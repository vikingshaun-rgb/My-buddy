//
//  server.js
//  Minimal backend proxy for the glasses app.
//
//  Why this exists: the API key must NEVER live inside the iOS app (it can be
//  extracted from the binary). The app calls THIS server; this server holds the
//  key and forwards to api.anthropic.com. Deploy it somewhere private
//  (Fly.io, Render, a small VPS) and put the app's endpoints behind an auth
//  token you control.
//
//  Endpoints:
//    POST /vision      -> forwards an image+prompt to Claude (used by VisionLoop)
//    POST /chat        -> forwards a streaming conversation (voice assistant)
//    POST /translate   -> convenience wrapper for live translation
//    POST /directions  -> Google Directions routing (used by SpokenNavigator)
//
//  Env vars required:
//    ANTHROPIC_API_KEY   your key
//    APP_SHARED_TOKEN    a random string the app must send as Bearer auth
//  Env vars optional:
//    GOOGLE_MAPS_API_KEY enables /directions (Google Directions API).
//                        Restrict this key to the Directions API in Google Cloud.
//                        Without it, /directions returns 501 and the app should
//                        fall back to Apple routing.
//
//  Run:  ANTHROPIC_API_KEY=sk-... APP_SHARED_TOKEN=... node server.js
//

const express = require("express");
const app = express();
app.use(express.json({ limit: "12mb" })); // images arrive base64, keep this generous
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded webhooks

// CORS: the web app (served from a different origin, or added to the home screen)
// must be allowed to call this backend from the browser. Without this, every
// request from the PWA is blocked by the browser before it even leaves.
// Batch 130 audit: this was Allow-Origin:* — harmless on its own, since the
// token is still required, but combined with a leaked token it meant any page
// he happened to visit could quietly use his brain on his bill. Restricting it
// to the origins that actually serve the app closes that. ALLOWED_ORIGINS lets
// him add one without a code change; anything unlisted still gets a reply, it
// just can't be read by a browser from another site.
const DEFAULT_ORIGINS = [
  "https://my-buddy-ai.onrender.com",
  "https://my-buddy-xu2x.onrender.com",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];
const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ORIGINS,
  ...String(process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
]);

app.use((req, res, next) => {
  const origin = req.get("origin") || "";
  // A PWA added to the home screen sends a null/absent origin, and so does
  // curl — neither is a cross-site browser request, so both are fine.
  if (!origin || ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204); // preflight
  next();
});

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const KEY = process.env.ANTHROPIC_API_KEY;
const APP_TOKEN = process.env.APP_SHARED_TOKEN;
// Optional service keys (batch 84). These are LIVE LOOKUPS, not constants:
// a key set from the phone lands in the durable store and takes effect on the
// next request — no redeploy, no Render dashboard. Env vars remain the
// fallback, so nothing breaks if the store is empty.
function envKey(name, fallback) {
  try { if (STORE && STORE.keys && STORE.keys[name]) return STORE.keys[name]; } catch {}
  return fallback;
}
Object.defineProperty(globalThis, "GMAPS_KEY", { get: () => envKey("GOOGLE_MAPS_API_KEY", process.env.GOOGLE_MAPS_API_KEY) });
Object.defineProperty(globalThis, "FLIGHT_KEY", { get: () => envKey("AVIATIONSTACK_KEY", process.env.AVIATIONSTACK_KEY) });
Object.defineProperty(globalThis, "ICLOUD_USER", { get: () => envKey("ICLOUD_USER", process.env.ICLOUD_USER) });
Object.defineProperty(globalThis, "ICLOUD_APP_PW", { get: () => envKey("ICLOUD_APP_PW", process.env.ICLOUD_APP_PW) });

if (!KEY || !APP_TOKEN) {
  console.error("Set ANTHROPIC_API_KEY and APP_SHARED_TOKEN");
  process.exit(1);
}

// Simple shared-token gate so randoms can't run up your bill.
// ================= DURABLE MIND (batch 51) =================
// File-backed store. On Render: add a Disk mounted at /var/data (1GB) so
// memory survives redeploys. Without it we fall back to ./data, which is
// EPHEMERAL on Render (wiped each deploy) — /health will say which.
const fs = require("fs");
const path = require("path");
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/var/data") ? "/var/data" : "./data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const STORE_FILE = path.join(DATA_DIR, "vision-store.json");
const DURABLE = DATA_DIR === "/var/data" || !!process.env.DATA_DIR;
/* --- DURABLE STORE (hardened, batch 137 audit) ------------------------------
 * The store is everything Vision knows about him. The audit found four ways it
 * could vanish without anyone noticing:
 *
 *   1. NON-ATOMIC WRITE — writeFileSync truncates then writes. A Render
 *      restart landing mid-write leaves a half-file; next boot JSON.parse
 *      throws, the catch swallows it, and STORE silently resets to empty.
 *   2. NO BACKUP — one file, nothing to fall back to.
 *   3. SILENT LOAD FAILURE — a corrupt store looked identical to a first run.
 *      He'd open the app to find Vision had forgotten him, with no error.
 *   4. NO SHUTDOWN FLUSH — saves debounce 1.5s. Tick milk off the list, deploy
 *      lands 800ms later, the tick is gone and it looks like it was ignored.
 * ------------------------------------------------------------------------ */
const STORE_BAK = STORE_FILE + ".bak";
const STORE_TMP = STORE_FILE + ".tmp";
const EMPTY_STORE = { profiles: {}, briefs: {}, flags: {}, mem: {}, watchers: {}, results: {}, seen: {} };

let STORE = { ...EMPTY_STORE };
let _loadState = "fresh";   // fresh | loaded | recovered | corrupt

function readStoreFile(p) {
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  return parsed;
}

// Try the live file, then the backup. Only ever start empty if BOTH are gone —
// and say so loudly if the live file existed but was unreadable.
try {
  STORE = { ...EMPTY_STORE, ...readStoreFile(STORE_FILE) };
  _loadState = "loaded";
} catch (e) {
  const liveExisted = fs.existsSync(STORE_FILE);
  try {
    STORE = { ...EMPTY_STORE, ...readStoreFile(STORE_BAK) };
    _loadState = "recovered";
    console.error("[vision] main store unreadable — RECOVERED FROM BACKUP:", e && e.message);
  } catch {
    _loadState = liveExisted ? "corrupt" : "fresh";
    if (liveExisted) {
      // Never overwrite evidence. Keep the bad file so it can be inspected
      // rather than quietly replaced on the next save.
      try { fs.renameSync(STORE_FILE, STORE_FILE + ".corrupt-" + Date.now()); } catch {}
      console.error("[vision] STORE CORRUPT AND NO BACKUP — starting empty. Bad file kept for inspection.");
    }
  }
}

let _saveT = null;
// A failed save is silent memory loss — the one failure you'd never notice
// until something you told Vision has vanished. Record it and surface it in
// /health so Status can say so plainly.
let _saveFails = 0, _lastSaveOk = 0;

// Write to a temp file, fsync it, then rename over the target. rename() is
// atomic on POSIX, so a crash leaves either the old file or the new one —
// never a half-written one.
function writeStoreNow() {
  // Batch 137 audit caught this: a length check alone is not enough.
  // JSON.stringify(null) is the four-character string "null", which sailed
  // past `length < 2` and would have been written straight over the real
  // store. Check the SHAPE before serialising, not the size after.
  if (!STORE || typeof STORE !== "object" || Array.isArray(STORE)) {
    throw new Error("refusing to write a non-object store");
  }
  const json = JSON.stringify(STORE);
  if (!json || json.length < 2 || json === "null") {
    throw new Error("refusing to write an empty store");
  }
  let fd;
  try {
    fd = fs.openSync(STORE_TMP, "w");
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);           // on disk, not just in the OS buffer
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  // Keep the previous good file as the backup before replacing it.
  try { if (fs.existsSync(STORE_FILE)) fs.copyFileSync(STORE_FILE, STORE_BAK); } catch {}
  fs.renameSync(STORE_TMP, STORE_FILE);
  _saveFails = 0; _lastSaveOk = Date.now();
}

function saveStore() {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => {
    try { writeStoreNow(); }
    catch (e) {
      _saveFails++;
      try { dlog(null, "errors", `MEMORY SAVE FAILED (${_saveFails}x): ${String(e.message || e).slice(0, 120)}`); } catch {}
      console.error("[vision] memory save failed:", e && e.message);
    }
  }, 1500);
}

// Render sends SIGTERM on every deploy and waits ~30s. Without this, anything
// saved in the last 1.5 seconds is lost — and that's exactly the moment he'd
// have just told Vision something.
let _exiting = false;
function flushAndExit(signal) {
  if (_exiting) return;
  _exiting = true;
  clearTimeout(_saveT);
  try { writeStoreNow(); console.error(`[vision] flushed store on ${signal}`); }
  catch (e) { console.error("[vision] flush on exit FAILED:", e && e.message); }
  process.exit(0);
}
process.on("SIGTERM", () => flushAndExit("SIGTERM"));
process.on("SIGINT", () => flushAndExit("SIGINT"));
function uidOf(req) { return String((req.body && req.body.uid) || req.query.uid || "shaun-default").slice(0, 64); }
function profileOf(uid) { return STORE.profiles[uid] || { name: "Shaun", ainame: "Vision" }; }

// Shared "current time" line every time-sensitive skill can drop into its
// prompt, so no endpoint ever has to ask the user what time it is or guess the
// date. Location-aware: uses his travel timezone when known (COUNTRY_TZ is a
// const defined later in the file, so it's guarded — by request time the module
// has fully loaded and it exists). Falls back to Brisbane.
function nowLine(uid, coords) {
  const prof = profileOf(uid) || {};
  // Priority: live GPS box → saved profile country → Brisbane.
  let tz = "";
  if (coords && typeof tzFromLatLng === "function") tz = tzFromLatLng(coords.lat, coords.lng);
  if (!tz) tz = (typeof COUNTRY_TZ !== "undefined" && prof.country && COUNTRY_TZ[String(prof.country).toLowerCase()]) || "Australia/Brisbane";
  let stamp;
  try { stamp = new Date().toLocaleString("en-AU", { timeZone: tz, dateStyle: "full", timeStyle: "short" }); }
  catch { stamp = new Date().toLocaleString("en-AU"); }
  return `The current date and time is ${stamp} (${tz}). You ALWAYS know the current time and date — never ask him for them, and use them for anything about "today", "tomorrow", "now", or timing.`;
}
function flagsOf(uid) { return STORE.flags[uid] = STORE.flags[uid] || { quiet: false, whisper: false, saver: false }; }

/* --- 🌐 SHARED AMBIENT CONTEXT (build 159) ----------------------------------
 * The thing EVERY model-backed skill should know before it answers: what time
 * it is, where he is, who he is, and (when relevant) what he's told Vision
 * before. Built once here so no skill is ever flying blind on context again —
 * append visionContext(uid, {recall: <the request text>}) to any system prompt.
 *
 * TIERED so it's smart, not heavy:
 *   - ALWAYS (cheap): time + place + name. Every skill gets this.
 *   - WHEN recall passed: core facts + memory relevant to THIS request. Skills
 *     that don't need it (currency, translate) simply don't pass recall.
 *
 * The later-defined helpers (coreBrief/recallBrief) are referenced safely:
 * this runs at request time, by which point the whole module has loaded.
 * An audit contract (sim-context) enforces that every model endpoint calls it.
 * ------------------------------------------------------------------------ */
function visionContext(uid, opts = {}) {
  const prof = profileOf(uid) || {};
  const coords = opts.coords || (opts.lat != null ? { lat: opts.lat, lng: opts.lng } : null);
  const bits = [nowLine(uid, coords)];
  const whereBits = [];
  if (prof.city) whereBits.push(prof.city);
  if (prof.country) whereBits.push(prof.country);
  if (whereBits.length) bits.push(`He's currently in ${whereBits.join(", ")} — use it, don't ask.`);
  if (prof.name && prof.name !== "Shaun") bits.push(`His name is ${prof.name}.`);
  if (prof.localCurrency) bits.push(`Local currency ${prof.localCurrency}; home currency AUD.`);
  // Heavier layer only when the caller passes the request text to match against.
  if (opts.recall) {
    try { const c = (typeof coreBrief === "function") ? coreBrief(uid) : ""; if (c) bits.push(c); } catch {}
    try { const r = (typeof recallBrief === "function") ? recallBrief(uid, String(opts.recall)) : ""; if (r) bits.push(r); } catch {}
  }
  bits.push("Never ask him for anything you already know from the above.");
  return " " + bits.filter(Boolean).join(" ");
}

// --- NATIVE PLUMBING (batch 41): shared brain state across web + glasses ---
// The web app already sends brain.brief() on every /chat and /route call.
// Cache the latest one here so the NATIVE shim can inject it — Vision on the
// glasses then knows the same trip state as Vision on the web, with zero
// native-side storage. Flags (quiet/whisper/saver) sync the same way.
// HONEST NOTE: in-memory — resets on redeploy; the web app re-primes it on
// first use, so the gap is minutes, not data loss.
// Per-user now (batch 51): briefs + flags keyed by uid, persisted in the store.
function rememberBrief(uid, b) { if (typeof b === "string" && b.trim()) { STORE.briefs[uid] = { text: b.slice(0, 900), at: Date.now() }; saveStore(); } }
function briefOf(uid) { return STORE.briefs[uid] || null; }

app.get("/state", requireAuth, (req, res) => { const uid = uidOf(req); res.json({ flags: flagsOf(uid), brief: briefOf(uid), today: todayShape(uid), recentDays: daySummaryBrief(uid, 3), upcoming: upcomingBrief(uid), pending: pendingBrief(uid), patterns: patternScan(uid),
    onThisDay: onThisDay(uid), texts: ((STORE.smsHold || {})[uid] || []), voicemails: ((STORE.vmHold || {})[uid] || []) }); });
app.post("/state", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const f = (req.body || {}).flags || {}; const cur = flagsOf(uid);
  for (const k of ["quiet", "whisper", "saver"]) if (k in f) cur[k] = !!f[k];
  saveStore(); res.json({ flags: cur });
});

// Profile: name, assistant nickname, home, partner — per user, durable.
app.get("/profile", requireAuth, (req, res) => res.json(profileOf(uidOf(req))));
app.post("/profile", requireAuth, (req, res) => {
  const uid = uidOf(req); const b = req.body || {};
  const p = STORE.profiles[uid] = { ...profileOf(uid) };
  for (const k of ["name", "ainame", "home", "homeCity", "partner"]) if (typeof b[k] === "string" && b[k].trim()) p[k] = b[k].trim().slice(0, 60);
  if (typeof b.style === "string") { const st = b.style.trim().slice(0, 140); if (st) p.style = st; else delete p.style; }
  saveStore(); res.json(p);
});

// Memory: durable notes/facts with add/search/forget/all.
app.post("/memory", requireAuth, (req, res) => {
  const uid = uidOf(req); const { action, text } = req.body || {};
  const mem = STORE.mem[uid] = STORE.mem[uid] || [];
  if (action === "add" && text) { remember(uid, String(text).slice(0, 500), { kind: "note" }); return res.json({ ok: true, count: (STORE.mem[uid] || []).length }); }
  if (action === "search" && text) { const q = String(text).toLowerCase(); return res.json({ hits: mem.filter(m => m.t.toLowerCase().includes(q)).slice(-8) }); }
  if (action === "forget" && text) { const q = String(text).toLowerCase(); const before = mem.length; STORE.mem[uid] = mem.filter(m => !m.t.toLowerCase().includes(q)); saveStore(); return res.json({ removed: before - STORE.mem[uid].length }); }
  if (action === "all") return res.json({ profile: profileOf(uid), count: mem.length, recent: mem.slice(-12) });
  res.status(400).json({ error: "bad action" });
});

/* --- AUTH + RATE LIMITING (batch 130 audit) --------------------------------
 * Three findings, in order of what they'd actually cost him:
 *
 * 1. NO RATE LIMITING AT ALL. A leaked token meant unlimited spend on his
 *    Anthropic account — and his APP_SHARED_TOKEN has already been exposed in
 *    a chat and a screenshot once. At ~2c a model call, a script hitting /chat
 *    unattended is real money before he notices.
 * 2. The token comparison short-circuited on the first wrong character, so
 *    response time leaked how much of a guess was right. Low risk over the
 *    internet, but free to fix and it's the correct pattern.
 * 3. CORS is Allow-Origin:* — harmless without the token, but with a leaked
 *    one it means any page he visits could quietly use his brain.
 * ------------------------------------------------------------------------ */
const crypto = require("crypto");

// Compares in constant time so a wrong guess takes as long as a right one.
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ""), "utf8");
  const B = Buffer.from(String(b || ""), "utf8");
  if (A.length !== B.length) {
    // Still burn a comparison so length itself isn't a timing signal.
    try { crypto.timingSafeEqual(A, A); } catch {}
    return false;
  }
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

/* Two buckets, because the two failure modes are different:
 *   - failed auth is someone guessing         -> lock the source out hard
 *   - successful calls are his own use        -> generous, but not unlimited
 * In-memory: this resets on redeploy, which is fine. It exists to stop a
 * runaway, not to be a fortress.
 */
const _authFails = new Map();   // ip -> { n, until }
const _callRate = new Map();    // ip -> { n, windowStart }

const AUTH_FAIL_MAX = 8;              // wrong tokens before a lockout
const AUTH_LOCK_MS = 15 * 60 * 1000;  // how long that lockout lasts
const CALL_WINDOW_MS = 60 * 1000;
const CALL_MAX = 120;                 // per minute — far above real use

function clientIp(req) {
  return String(req.get("x-forwarded-for") || req.ip || "unknown").split(",")[0].trim();
}

// Housekeeping so the maps can't grow forever on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _authFails) if (v.until < now) _authFails.delete(k);
  for (const [k, v] of _callRate) if (now - v.windowStart > CALL_WINDOW_MS * 5) _callRate.delete(k);
}, 10 * 60 * 1000);

function requireAuth(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();

  const lock = _authFails.get(ip);
  if (lock && lock.until > now) {
    return res.status(429).json({ error: "too many failed attempts", retryAfterSec: Math.ceil((lock.until - now) / 1000) });
  }

  const auth = req.get("authorization") || "";
  if (!APP_TOKEN || !safeEqual(auth, `Bearer ${APP_TOKEN}`)) {
    const f = _authFails.get(ip) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= AUTH_FAIL_MAX) {
      f.until = now + AUTH_LOCK_MS; f.n = 0;
      try { dlog(null, "errors", `auth: locked out ${ip} after ${AUTH_FAIL_MAX} failed attempts`); } catch {}
    }
    _authFails.set(ip, f);
    return res.status(401).json({ error: "unauthorized" });
  }

  // Authenticated, but still bounded — a leaked token shouldn't mean an
  // unlimited bill.
  const r = _callRate.get(ip) || { n: 0, windowStart: now };
  if (now - r.windowStart > CALL_WINDOW_MS) { r.n = 0; r.windowStart = now; }
  r.n++;
  _callRate.set(ip, r);
  if (r.n > CALL_MAX) {
    try { dlog(null, "errors", `rate limit hit: ${ip} made ${r.n} calls in a minute`); } catch {}
    return res.status(429).json({
      error: "rate limited",
      spoken: "You're going a bit fast for me — give me a moment.",
      retryAfterSec: Math.ceil((CALL_WINDOW_MS - (now - r.windowStart)) / 1000),
    });
  }

  _authFails.delete(ip);   // a good token clears the guess counter
  next();
}

// Forward a non-streaming request to Claude and return the raw JSON.
// --- USAGE METER (batch 48): count every token the server actually spends.
// ESTIMATE ONLY — your Anthropic key can't read the real balance (needs an
// admin key), so console.anthropic.com stays the source of truth for the bill.
const usageTotals = {}; // model -> { calls, inTok, outTok }
function recordUsage(model, u) {
  if (!u) return;
  try { const [pi, po] = PRICES[model] || [3, 15];
    dlog(null, "cost", `${model.replace("claude-", "")} ${u.input_tokens || 0}in/${u.output_tokens || 0}out`,
      { usd: Math.round((((u.input_tokens || 0) / 1e6) * pi + ((u.output_tokens || 0) / 1e6) * po) * 100000) / 100000 }); } catch {}
  const m = usageTotals[model] = usageTotals[model] || { calls: 0, inTok: 0, outTok: 0 };
  m.calls++; m.inTok += u.input_tokens || 0; m.outTok += u.output_tokens || 0;
  // Batch 68: durable spend ledger — survives redeploys, keyed by day.
  try {
    const [pi, po] = PRICES[model] || [3, 15];
    const cost = ((u.input_tokens || 0) / 1e6) * pi + ((u.output_tokens || 0) / 1e6) * po;
    const day = new Date().toISOString().slice(0, 10);
    STORE.spend = STORE.spend || {};
    STORE.spend[day] = (STORE.spend[day] || 0) + cost;
    // keep 90 days
    const days = Object.keys(STORE.spend).sort();
    while (days.length > 90) delete STORE.spend[days.shift()];
    saveStore();
  } catch {}
}
// USD per MTok (input, output) — update if Anthropic pricing changes.
const PRICES = { "claude-haiku-4-5-20251001": [1, 5], "claude-sonnet-4-6": [3, 15] };
function usdEstimate() {
  let total = 0;
  for (const [m, u] of Object.entries(usageTotals)) {
    const [pi, po] = PRICES[m] || [3, 15];
    total += (u.inTok / 1e6) * pi + (u.outTok / 1e6) * po;
  }
  return total;
}

// Rolling logs (batch 49): real-traffic brain latency + perf-run history.
// In-memory, resets on redeploy — durable logging needs the persistent-store
// upgrade (same missing piece as durable memory).
const brainLog = []; // {at, model, ms} cap 200 — EVERY real Claude call
const perfLog = [];  // {at, ok, worst} cap 30 — each /perf run

/* --- CLAUDE API GATEWAY (batch 115 audit) ----------------------------------
 * 57 call sites go through this one function. It had no timeout, no retry, and
 * no handling for 429 (rate limit) or 529 (overloaded) — the two statuses the
 * API actually returns under load. A single blip surfaced to Shaun as "Vision's
 * brain hiccuped", which is exactly the failure he already spent a night
 * debugging. What the serious assistants do instead, all added here:
 *   - bounded request (never hang a watcher or a spoken reply)
 *   - retry with exponential backoff + jitter, honouring retry-after
 *   - retry ONLY the transient statuses; never retry a 400 or a bad key
 *   - surface the real error so a wrong model name says so
 * ------------------------------------------------------------------------ */
const CLAUDE_TIMEOUT_MS = 45000;   // vision calls with a big image are slow
const CLAUDE_RETRIES = 2;          // 3 attempts total
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* --- SHARED PROMPT GUARDRAILS (batch 117 audit) -----------------------------
 * Audit of all 52 model-calling endpoints found:
 *   - 41 with no "never invent" instruction, including ones giving advice he
 *     acts on (prices, places, packing, visas, weather)
 *   - 23 that can return a 5xx, so the app gets an error and Vision says
 *     nothing useful — the worst possible failure on glasses
 *
 * Defining these once beats editing 41 prompts by hand: consistent wording,
 * one place to improve, and no drift between endpoints.
 * ------------------------------------------------------------------------ */

/* The SHAPE of a spoken answer, applied everywhere. Not what to say — how to
 * say it. Written after a "closest chemist" reply came back as a paragraph of
 * reasoning plus three options in no clear order: the answer buried, and the
 * choosing still left to him.
 *
 * Deliberately about structure rather than length. "Be brief" produces clipped
 * unhelpful answers; "lead with the answer and give each thing one clause"
 * produces short ones that are still complete. */
const ANSWER_FIRST =
  " Lead with the ANSWER, never the reasoning. Say the thing he asked for in the first few words. " +
  "Detail he did not ask for — ratings, addresses, opening hours, why you picked it — is noise until he decides, " +
  "so leave it out and let him ask. " +
  "If there is a clear best option, NAME IT rather than listing alternatives: a list is you making him do the work. " +
  "When he asks for several things at once, answer them ALL in one short reply, ordered by what matters soonest " +
  "rather than the order he said them, and give each one a single clause — not a paragraph. " +
  "If you could not do part of it, say so in the same breath rather than quietly dropping it. " +
  "End with at most ONE question, and make it answerable with yes.";

// The single most important line in the system. A confident invention is worse
// than an admitted blank — especially for a price, a visa rule or an allergen.
const NO_INVENT =
  " Never invent specifics. If you don't actually know a name, price, time, rule or fact, " +
  "say plainly that you're not sure and tell him how to check. A guess he acts on is worse than an honest blank.";

// For anything he'd spend money or make a plan on.
const NO_INVENT_STRICT =
  NO_INVENT +
  " Do NOT state opening hours, prices, availability or rules as fact unless they were given to you in this request. " +
  "Describe the KIND of thing to expect instead, and say it needs confirming.";

// For safety-critical advice.
// Spoken through the glasses — asterisks, hashes and bullet characters are
// noise when read aloud. /job/report is the deliberate exception: its dashed
// bullets are the house format Geeks2U expects, and it's pasted, not spoken.
const SPOKEN_PLAIN =
  " This is read ALOUD, so write it as speech: no markdown, no asterisks, no hashes, no bullet characters, no headings.";

const NO_FALSE_COMFORT =
  " Never give false reassurance. If you cannot be sure from what you were given, say so and name what he should check or ask. " +
  "It is always better to say 'I can't tell from this' than to be reassuring and wrong.";

/* --- IMAGE VALIDATION (batch 120 audit) -------------------------------------
 * Eight endpoints accept images. Four had no size check at all, so an
 * oversized photo travelled the whole way to Anthropic before being rejected —
 * the user waits out a slow upload and then hears "my brain hiccuped".
 * Checking here costs nothing and gives him something true to act on.
 *
 * Anthropic's own limits: ~5MB per image after decoding, 8000px max edge,
 * and it rejects anything under roughly 200px on the long edge.
 * ------------------------------------------------------------------------ */
const IMG_MAX_B64 = 5 * 1024 * 1024 * 4 / 3;   // ~5MB decoded, base64 is ~4/3
const IMG_MIN_B64 = 500;                        // below this it isn't a photo
const IMG_MIME_OK = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function checkImage(b64, mediaType) {
  if (typeof b64 !== "string" || !b64) return { ok: false, spoken: "That photo didn't come through — give it another go." };
  // The client sometimes forgets to strip the data: prefix; be forgiving.
  const raw = b64.startsWith("data:") ? (b64.split(",")[1] || "") : b64;
  if (raw.length < IMG_MIN_B64) return { ok: false, spoken: "That image was too small to read — try taking it again." };
  if (raw.length > IMG_MAX_B64) return { ok: false, spoken: "That photo's too big for me — try again and I'll shrink it first." };
  if (/^(undefined|null)$/i.test(raw.trim())) return { ok: false, spoken: "That photo didn't come through — give it another go." };
  const mt = mediaType || "image/jpeg";
  if (!IMG_MIME_OK.has(mt)) return { ok: false, spoken: "I can't read that kind of image — a photo or screenshot works best." };
  return { ok: true, data: raw, mediaType: mt };
}

async function callClaude(body, opts = {}) {
  const timeout = opts.timeout || CLAUDE_TIMEOUT_MS;
  const maxRetries = opts.retries === undefined ? CLAUDE_RETRIES : opts.retries;
  let attempt = 0, lastStatus = 0, lastText = "";

  while (attempt <= maxRetries) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const t0 = Date.now();
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": KEY,
          "anthropic-version": "2023-06-01",
          // Only sent when the body actually uses cache_control, so nothing
          // else in the system is affected by the beta flag.
          ...(JSON.stringify(body).includes("cache_control")
            ? { "anthropic-beta": "prompt-caching-2024-07-31" } : {}),
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const text = await r.text();
      lastStatus = r.status; lastText = text;

      if (r.status === 200) {
        try { const j = JSON.parse(text); if (j && j.usage) recordUsage(body.model, j.usage); } catch {}
        if (attempt > 0) { try { dlog(null, "errors", `Claude recovered after ${attempt} retr${attempt > 1 ? "ies" : "y"} (${Date.now() - t0}ms)`); } catch {} }
        return { status: 200, text, attempts: attempt + 1 };
      }

      // A 400 or 401 will fail identically every time — retrying just adds delay.
      if (!RETRYABLE.has(r.status) || attempt === maxRetries) {
        try { dlog(null, "errors", `Claude ${r.status}: ${String(text).slice(0, 160)}`); } catch {}
        return { status: r.status, text, attempts: attempt + 1 };
      }

      // Honour the server's own advice where it gives it.
      const ra = parseInt(r.headers.get("retry-after") || "", 10);
      const backoff = ra ? ra * 1000 : Math.min(8000, 600 * Math.pow(2, attempt)) + Math.floor(Math.random() * 400);
      try { dlog(null, "errors", `Claude ${r.status} — retrying in ${backoff}ms (attempt ${attempt + 1}/${maxRetries + 1})`); } catch {}
      await _sleep(backoff);
      attempt++;
    } catch (e) {
      clearTimeout(timer);
      const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
      lastStatus = aborted ? 504 : 0;
      lastText = JSON.stringify({ error: { message: aborted ? `request timed out after ${timeout}ms` : String(e.message || e) } });
      if (attempt === maxRetries) {
        try { dlog(null, "errors", `Claude ${aborted ? "timeout" : "network error"} after ${attempt + 1} attempts`); } catch {}
        return { status: lastStatus, text: lastText, attempts: attempt + 1 };
      }
      await _sleep(Math.min(8000, 600 * Math.pow(2, attempt)) + Math.floor(Math.random() * 400));
      attempt++;
    }
  }
  return { status: lastStatus, text: lastText, attempts: attempt };
}

// --- Vision: image + prompt in, one short line out (matches ClaudeVisionClient) ---
// --- Vision: Vision looks at a photo and answers, purpose-aware ---
// Body: { image: "<base64 jpeg/png>", mode?, question?, mediaType? }
//   mode: "identify" | "read" | "translate" | "safe" | "describe" (default: identify)
//   question: optional free-text ("what am I looking at?") — overrides mode framing
// Returns: { answer }  (warm, short, spoken-style) or { fallback:true, answer }
const VISION_MODES = {
  identify: "Tell Shaun what he's looking at — the main object, place, or landmark. One or two warm, spoken sentences. If notable, add one useful detail.",
  read:     "Read the text in this image for Shaun and tell him what it says, plainly. If it's a menu, sign, or label, give the gist first, then key details. Spoken style, no markdown.",
  translate:"Translate any text in this image into English for Shaun, then briefly say what it means in context. Spoken style, short.",
  safe:     "Shaun is asking if this looks safe (food, path, situation). Give your honest read in one or two sentences, name anything worth caution, and be clear you can't be certain from a photo. Never give medical or allergy guarantees.",
  describe: "Describe the scene for Shaun as if he can't see it — the setting, key things, and mood, in two or three warm spoken sentences.",
};
app.post("/vision", requireAuth, async (req, res) => {
  try {
    // Batch 120 audit: this had no size check — an oversized photo went all
    // the way to Anthropic before being rejected.
    if (req.body && req.body.image) {
      const _v = checkImage(req.body.image, req.body.mediaType);
      if (!_v.ok) return res.status(200).json({ fallback: true, answer: _v.spoken, spoken: _v.spoken });
      req.body.image = _v.data; req.body.mediaType = _v.mediaType;
    }
    const b = req.body || {};
    // Back-compat: if the app already sent a full /v1/messages body, forward it.
    if (Array.isArray(b.messages)) {
      const { status, text } = await callClaude(b);
      return res.status(status).type("application/json").send(text);
    }
    if (!b.image) return res.status(400).json({ error: "image required" });

    const framing = b.question
      ? `Shaun asks: "${b.question}". Answer from what you see, warm and spoken, one or two sentences.`
      : (VISION_MODES[b.mode] || VISION_MODES.identify);

    const system = "You are Vision, Shaun's warm AI companion in his glasses. You're looking through his camera. Keep answers SHORT, warm, and spoken-friendly — no markdown, no lists, no preamble." + NO_INVENT;

    const body = {
      model: "claude-sonnet-4-6", // vision reasoning wants the capable model
      max_tokens: 300,
      system,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: b.mediaType || "image/jpeg", data: b.image } },
          { type: "text", text: framing },
        ],
      }],
    };
    const { status, text } = await callClaude(body);
    if (status !== 200) {
      return res.status(200).json({ fallback: true, answer: "I couldn't make out the photo just then, Shaun — try once more?" });
    }
    const json = JSON.parse(text);
    const answer = (json.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
    // What he SAW is an ambient occurrence — but only worth remembering when he
    // actively asked about it (an intentional look), not passive narration. The
    // gate judges salience and novelty; a wall or a repeated scene evaporates.
    if (answer && b.question) {
      const place = b.location?.city || "";
      consider(uidOf(req), { kind: "saw", text: `saw${place ? ` in ${place}` : ""}: ${answer.slice(0, 140)}`, occurred: true, place: place || undefined, coords: (b.lat != null ? { lat: b.lat, lng: b.lng } : undefined) });
    }
    res.json({ answer: answer || "Hmm, I couldn't quite tell — want to try again?" });
  } catch (e) {
    res.status(200).json({ fallback: true, answer: "My eyes glitched for a sec — give it another go." });
  }
});

// --- Translate: {text, targetLang, sourceLang?} -> {translation} ---
app.post("/translate", requireAuth, async (req, res) => {
  const { text, targetLang, sourceLang } = req.body || {};
  if (!text || !targetLang) {
    return res.status(400).json({ error: "text and targetLang required" });
  }
  const src = sourceLang ? `from ${sourceLang} ` : "(auto-detect the source language) ";
  const body = {
    model: "claude-haiku-4-5-20251001", // fast + cheap; translation doesn't need Opus
    max_tokens: 500,
    system: "You are Vision, a warm translation helper for Shaun. Be accurate and natural, not literal-clunky." + NO_INVENT,
    messages: [{
      role: "user",
      content:
        `Translate the following ${src}into ${targetLang}.\n` +
        `Reply as compact JSON ONLY (no markdown, no preamble) with keys: ` +
        `"translation" (the natural translation), ` +
        `"detected" (the source language name), ` +
        `"note" (a SHORT note ONLY if there's useful nuance, tone, or a common phrase to know — else ""). ` +
        `Text:\n${text}`,
    }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, translation: "Couldn't translate that just now — try again?" });
    const json = JSON.parse(out);
    const raw = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    // The model returns JSON text; parse it, but degrade gracefully to plain text.
    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { parsed = { translation: raw, detected: sourceLang || "", note: "" }; }
    res.json({
      translation: parsed.translation || raw,
      detected: parsed.detected || "",
      note: parsed.note || "",
      // Batch 138 native-readiness audit: a voice client shouldn't have to
      // know which field to read out. Every endpoint now answers in words.
      spoken: (parsed.translation || raw) + (parsed.note ? ` — ${parsed.note}` : ""),
    });
  } catch (e) {
    res.status(200).json({ fallback: true, translation: "Translation hiccup — give it another go." });
  }
});

// --- Scam & price-check guard: is this a fair price here? ---
app.post("/scamcheck", requireAuth, async (req, res) => {
  // Batch 111 audit: this gives personalised ADVICE but was running blind.
  // Pull what he has paid for things before, and any scam he has already been caught by.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if it genuinely helps; never list it back): ${_mem}` : "";
  const { item, price, currency, country, prior } = req.body || {};
  if (!item || price == null) return res.status(400).json({ error: "item and price required" });
  const where = country ? ` in ${country}` : "";
  const cur = currency || "local currency";
  // Batch 58: his own spend history is the best price guide there is.
  const priorNote = (Array.isArray(prior) && prior.length)
    ? ` For reference, he himself recently paid: ${prior.slice(0, 3).map(p => `${p.amt} for "${p.note}"`).join("; ")}. Compare against his own history when relevant.`
    : "";
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 220,
    system: "You are Vision, a savvy travel companion who protects Shaun from being overcharged. You know rough local price norms for common tourist goods/services (taxis, tuk-tuks, street food, markets, SIM cards, souvenirs) across SE Asia and worldwide. Be honest and practical, never alarmist." + NO_FALSE_COMFORT + NO_INVENT + ANSWER_FIRST +
      _memNote + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{
      role: "user",
      content:
        `Shaun is being asked to pay ${price} ${cur} for "${item}"${where}.${priorNote} ` +
        `Reply as compact JSON ONLY (no markdown) with keys: ` +
        `"verdict" (one of: "fair", "high", "rip-off", "unsure"), ` +
        `"spoken" (one short friendly spoken sentence Vision would say — e.g. what a fair price is, or "that's steep, offer X"), ` +
        `"fairRange" (a short string like "20,000–30,000 VND" or "" if unknown).`,
    }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "I couldn't price-check that just now — trust your gut and haggle a little." });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { verdict: "unsure", spoken: raw, fairRange: "" }; }
    res.json({ verdict: p.verdict || "unsure", spoken: p.spoken || raw, fairRange: p.fairRange || "" });
    // A scam he was warned off is durable safety knowledge (twin of /allergy) —
    // only when the verdict actually flags risk, not for a clean "fair price".
    if (/scam|overpriced|avoid|rip|caution/i.test(String(p.verdict || "") + " " + String(p.spoken || ""))) {
      consider(uidOf(req), { kind: "scam", text: `scam risk flagged: ${item}${country ? ` in ${country}` : ""}${p.fairRange ? ` (fair ~${p.fairRange})` : ""}`, consequence: true, occurred: true });
    }
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Price-check hiccup — give it another go." });
  }
});

// --- Allergy / dietary shield: is this safe for me to eat? ---
app.post("/allergy", requireAuth, async (req, res) => {
  // Batch 111 audit: this gives personalised ADVICE but was running blind.
  // Pull anything he has told you about what he reacts to or avoids.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if it genuinely helps; never list it back): ${_mem}` : "";
  const { dish, avoid, country, image, mediaType } = req.body || {};
  // Batch 120 audit: no size check. Safety-critical, so a silent failure is
  // the worst outcome — better to say plainly that the photo didn't read.
  if (image) {
    const _v = checkImage(image, mediaType);
    if (!_v.ok) return res.status(200).json({ fallback: true, risk: "unsure", spoken: _v.spoken });
  }
  const avoidList = Array.isArray(avoid) ? avoid.join(", ") : (avoid || "");
  if (!avoidList) return res.status(400).json({ error: "avoid (what to avoid) required" });
  const sys = "You are Vision, Shaun's dietary safety guard while travelling. You know common hidden sources of allergens/restricted ingredients in local cuisines (e.g. fish sauce, shrimp paste, peanuts in SE Asian food). Be careful and clear. When unsure, say so and advise asking/confirming with the vendor in the local language." + NO_FALSE_COMFORT;
  const askText =
    `Shaun must AVOID: ${avoidList}.${country ? ` He's in ${country}.` : ""} ` +
    `${dish ? `The dish is: "${dish}". ` : "Assess the food in the image. "}` +
    `Reply as compact JSON ONLY (no markdown) with keys: ` +
    `"risk" (one of: "safe", "caution", "avoid", "unsure"), ` +
    `"spoken" (one or two short spoken sentences: the verdict + the biggest hidden risk to check), ` +
    `"askVendor" (a short phrase Shaun can show/say to the vendor in the LOCAL language to confirm, with the English in brackets — or "" if not needed).`;
  const content = image
    ? [{ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } }, { type: "text", text: askText }]
    : askText;
  const body = {
    model: "claude-sonnet-4-6", // safety-critical → stronger model
    max_tokens: 320,
    system: sys + _memNote + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{ role: "user", content }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, risk: "unsure", spoken: "I couldn't check that clearly — when in doubt, ask the vendor directly before eating." });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { risk: "unsure", spoken: raw, askVendor: "" }; }
    res.json({ risk: p.risk || "unsure", spoken: p.spoken || raw, askVendor: p.askVendor || "" });
    // The DURABLE fact isn't this dish — it's what he avoids. A safety
    // restriction is high-consequence and should persist (and can reach core via
    // reinforcement if it recurs). The per-dish verdict stays transient.
    consider(uidOf(req), { kind: "avoids", text: `avoids: ${avoidList}${country ? ` (checking food in ${country})` : ""}`, consequence: true, occurred: true });
  } catch (e) {
    res.status(200).json({ fallback: true, risk: "unsure", spoken: "Dietary-check hiccup — when unsure, confirm with the vendor before eating." });
  }
});

// --- Get me un-lost: spoken walking route from here back to a saved spot ---
app.post("/unlost", requireAuth, async (req, res) => {
  const { fromLat, fromLng, toLat, toLng, label } = req.body || {};
  if (fromLat == null || fromLng == null || toLat == null || toLng == null)
    return res.status(400).json({ error: "fromLat,fromLng,toLat,toLng required" });
  const MAPS = process.env.GOOGLE_MAPS_API_KEY;
  if (!MAPS) return res.status(501).json({ error: "maps_not_configured", spoken: "Add a Google Maps key and I can walk you back step by step." });
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/directions/json");
    u.searchParams.set("origin", `${fromLat},${fromLng}`);
    u.searchParams.set("destination", `${toLat},${toLng}`);
    u.searchParams.set("mode", "walking");
    u.searchParams.set("key", MAPS);
    const r = await fetch(u);
    const data = await r.json();
    const leg = data.routes?.[0]?.legs?.[0];
    if (!leg) return res.status(200).json({ found: false, spoken: "I couldn't map a walking route back — but your spot is saved; head roughly toward it and I'll retry." });
    const steps = (leg.steps || []).map(s => (s.html_instructions || "").replace(/<[^>]+>/g, "")).filter(Boolean);
    const dest = label || "your spot";
    // Vision speaks the first move warmly.
    const spoken = `Okay Shaun, ${dest} is ${leg.distance?.text || "close by"}, about ${leg.duration?.text || "a short walk"}. Start by heading ${steps[0] || "toward it"}.`;
    res.json({ found: true, spoken, distanceText: leg.distance?.text || "", durationText: leg.duration?.text || "", steps });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Route hiccup — your spot's still saved, try again in a sec." });
  }
});

// --- Is this a good deal? convert a price AND judge if it's reasonable ---
app.post("/gooddeal", requireAuth, async (req, res) => {
  // Batch 111 audit: this gives personalised ADVICE but was running blind.
  // Pull what he has paid for similar things before.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if it genuinely helps; never list it back): ${_mem}` : "";
  const { item, price, currency, home, country } = req.body || {};
  if (price == null || !currency) return res.status(400).json({ error: "price and currency required" });
  const homeCur = (home || "AUD").toUpperCase();
  // First get the real conversion (factual), then let Vision judge value.
  let convertedLine = "", convertedNum = null;
  try {
    const u = new URL("https://api.frankfurter.app/latest");
    u.searchParams.set("from", currency.toUpperCase());
    u.searchParams.set("to", homeCur);
    u.searchParams.set("amount", String(Number(price) || 1));
    const r = await fetch(u); const j = await r.json();
    convertedNum = j.rates?.[homeCur];
    if (convertedNum != null) convertedLine = `${price} ${currency.toUpperCase()} ≈ ${Number(convertedNum).toFixed(2)} ${homeCur}`;
  } catch {}
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: "You are Vision, Shaun's savvy money companion abroad. You judge whether a price is good value for the country, in plain friendly terms. You know rough local costs across SE Asia and worldwide." + NO_FALSE_COMFORT + NO_INVENT + ANSWER_FIRST +
      _memNote + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{
      role: "user",
      content:
        `Shaun is looking at ${item ? `"${item}" for ` : ""}${price} ${currency.toUpperCase()}` +
        `${country ? ` in ${country}` : ""}. ${convertedLine ? `That's about ${convertedLine}. ` : ""}` +
        `Reply as compact JSON ONLY (no markdown): "verdict" (one of "great","fair","pricey","rip-off","unsure"), ` +
        `"spoken" (one short friendly spoken sentence — is it good value, and what's normal?).`,
    }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    let p = { verdict: "unsure", spoken: convertedLine || "Couldn't judge that one." };
    if (status === 200) {
      const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p.spoken = raw; }
    }
    res.json({ verdict: p.verdict || "unsure", spoken: p.spoken || convertedLine, converted: convertedNum, convertedLine, home: homeCur });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: convertedLine || "Deal-check hiccup — try again.", convertedLine });
  }
});

// --- Agentic trip-planner: goal → structured day itinerary ---
app.post("/planday", requireAuth, async (req, res) => {
  // Batch 111 audit: this gives personalised ADVICE but was running blind.
  // Pull how he actually likes to spend a day and what he has already done here.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if it genuinely helps; never list it back): ${_mem}` : "";
  const { goal, city, budget, currency, profile, date } = req.body || {};
  if (!goal && !city) return res.status(400).json({ error: "goal or city required" });
  const body = {
    model: "claude-sonnet-4-6", // planning benefits from the stronger model
    max_tokens: 900,
    system: "You are Vision, Shaun's travel companion who PLANS his day, not just answers. Build a realistic, well-paced itinerary for the place and budget, with actual place types, rough times, and rough costs. Be specific and local, mindful of opening hours and travel time. Keep it doable, not a rushed checklist." + NO_INVENT_STRICT + ANSWER_FIRST +
      _memNote + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{
      role: "user",
      content:
        `Plan Shaun's day. Goal: ${goal || "explore"}.` +
        `${city ? ` City: ${city}.` : ""}${budget ? ` Budget: ${budget} ${currency || ""}.` : ""}` +
        `${date ? ` Date: ${date}.` : ""}${profile ? ` About Shaun: ${profile}.` : ""}\n` +
        `Reply as compact JSON ONLY (no markdown) with keys: ` +
        `"title" (short day title), ` +
        `"spoken" (2-3 sentence friendly spoken overview Vision would say), ` +
        `"stops" (array of {time, name, what, approxCost} — 4 to 7 stops), ` +
        `"totalCost" (rough total as a short string), ` +
        `"tip" (one short local tip).`,
    }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "I couldn't plan that just now — try again in a moment." });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { title: "Your day", spoken: raw, stops: [], totalCost: "", tip: "" }; }
    res.json({
      title: p.title || "Your day",
      spoken: p.spoken || "Here's a plan for your day.",
      stops: Array.isArray(p.stops) ? p.stops : [],
      totalCost: p.totalCost || "",
      tip: p.tip || "",
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Trip-planner hiccup — give it another go." });
  }
});

// --- Conversation mode: two-way, auto-detect, tone-aware translation ---
app.post("/converse", requireAuth, async (req, res) => {
  const { text, myLang, theirLang } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  const mine = myLang || "English";
  const theirs = theirLang || "the other language";
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: "You are Vision, powering a live two-way conversation translator for Shaun (a traveller). You auto-detect which language a line is in. If it's Shaun's language, translate INTO the other person's language; if it's the other person's language, translate INTO Shaun's. Keep it natural and colloquial, not literal. Also read the emotional tone.",
    messages: [{
      role: "user",
      content:
        `Shaun's language: ${mine}. The other person's language: ${theirs}. ` +
        `Here is a spoken line — detect its language and translate it the RIGHT direction:\n"${text}"\n` +
        `Reply as compact JSON ONLY (no markdown): "detected" (language name), ` +
        `"direction" (either "to-them" or "to-me"), ` +
        `"translation" (the natural translation to speak aloud), ` +
        `"tone" (one or two words: e.g. friendly, annoyed, urgent, neutral), ` +
        `"note" (SHORT — only if a cultural nuance matters, else "").`,
    }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, translation: "Didn't catch that — say it again?" });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { detected: "", direction: "", translation: raw, tone: "", note: "" }; }
    res.json({ detected: p.detected || "", direction: p.direction || "", translation: p.translation || raw, tone: p.tone || "", note: p.note || "" });
  } catch (e) {
    res.status(200).json({ fallback: true, translation: "Translation hiccup — try again." });
  }
});

// --- Etiquette whisper: local customs coaching ---
app.post("/etiquette", requireAuth, async (req, res) => {
  // Batch 66: this endpoint gives ADVICE, so it should know him. Pull the
  // memories relevant to local etiquette and let the model use them.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if relevant): ${_mem}` : "";
  const { question, country } = req.body || {};
  if (!question) return res.status(400).json({ error: "question required" });
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 240,
    system: "You are Vision, Shaun's discreet cultural guide abroad. Give warm, practical etiquette advice for the country — what's polite, what to avoid, how to do it right. Short and spoken-friendly. Be specific to the local culture, not generic." + SPOKEN_PLAIN + ANSWER_FIRST +
      NO_INVENT + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{
      role: "user",
      content: `${country ? `In ${country}: ` : ""}${question}${_memNote}\n` +
        `Reply as compact JSON ONLY: "spoken" (one or two short spoken sentences of practical etiquette advice), "phrase" (a useful local phrase with English in brackets, or "").`,
    }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't check that just now — when unsure, be warm, polite, and follow the locals' lead." });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { spoken: raw, phrase: "" }; }
    res.json({ spoken: p.spoken || raw, phrase: p.phrase || "" });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Etiquette hiccup — follow the locals' lead and you'll be fine." });
  }
});

// --- Landmark look-up: what am I looking at? (text place OR image) ---
app.post("/landmark", requireAuth, async (req, res) => {
  const { place, image, mediaType, country } = req.body || {};
  if (!place && !image) return res.status(400).json({ error: "place or image required" });
  // Batch 120 audit: no size check on the image path.
  if (image) {
    const _v = checkImage(image, mediaType);
    if (!_v.ok) return res.status(200).json({ fallback: true, spoken: _v.spoken });
  }
  const askText =
    `${place ? `Tell Shaun about this landmark/place: "${place}".` : "Identify the landmark or notable place in this image and tell Shaun about it."}` +
    `${country ? ` (He's in ${country}.)` : ""} ` +
    `Reply as compact JSON ONLY: "name" (what it is), ` +
    `"spoken" (2-3 sentence friendly spoken blurb — what it is, why it matters, one interesting fact), ` +
    `"tip" (a short visitor tip, or "").`;
  const content = image
    ? [{ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } }, { type: "text", text: askText }]
    : askText;
  const body = {
    model: "claude-sonnet-4-6", // identification benefits from stronger vision
    max_tokens: 320,
    system: "You are Vision, Shaun's knowledgeable, enthusiastic travel guide. When he looks at something, you tell him what it is and something genuinely interesting — like a great local guide would, briefly." + SPOKEN_PLAIN + ANSWER_FIRST +
      NO_INVENT_STRICT + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{ role: "user", content }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "I couldn't make that out clearly — try a closer photo?" });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { name: "", spoken: raw, tip: "" }; }
    res.json({ name: p.name || "", spoken: p.spoken || raw, tip: p.tip || "" });
    // He stood at a landmark and asked about it — a real occurrence, place-anchored
    // (twin of an intentional /vision look). The gate dedups repeat visits.
    if (p.name) consider(uidOf(req), { kind: "saw", text: `stood at ${p.name}${country ? `, ${country}` : ""}`, occurred: true, place: p.name });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Landmark look-up hiccup — try again." });
  }
});

// --- Offline survival pack: generate key phrases + info to cache on device ---
app.post("/survival", requireAuth, async (req, res) => {
  const { country, language } = req.body || {};
  if (!country && !language) return res.status(400).json({ error: "country or language required" });
  const lang = language || `the local language of ${country}`;
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system: "You are Vision, preparing Shaun an offline survival phrase pack for travel. Give the most useful emergency and everyday phrases in the local language with pronunciation and English." + SPOKEN_PLAIN + ANSWER_FIRST +
      NO_FALSE_COMFORT,
    messages: [{
      role: "user",
      content: `Make a compact survival phrase pack for ${country || lang} in ${lang}. ` +
        `Reply as compact JSON ONLY: "phrases" (array of {en, local, say} where "say" is a simple pronunciation hint) covering: hello, thank you, yes, no, "how much?", "help!", "I need a doctor", "police", "I'm allergic to...", "where is the toilet?", "I don't understand", "call an ambulance". ` +
        `Also "emergency" (the local emergency phone number if known, else ""), and "tip" (one safety tip).`,
    }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, phrases: [], tip: "Save your hotel address offline before heading out." });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { phrases: [], emergency: "", tip: "" }; }
    res.json({
      spoken: [
        (p.phrases || []).slice(0, 3).map(x => typeof x === "string" ? x : (x.phrase || x.text || "")).filter(Boolean).join("; "),
        p.emergency ? `Emergency here is ${p.emergency}.` : "",
        p.tip || "",
      ].filter(Boolean).join(" "), phrases: p.phrases || [], emergency: p.emergency || "", tip: p.tip || "" });
  } catch (e) {
    res.status(200).json({ fallback: true, phrases: [], tip: "Save your hotel address offline before heading out." });
  }
});

// --- Chat: streaming voice-assistant turn. Pass through Claude's SSE stream. ---
// --- Vision's brain: persona + memory + smart model routing + live context ---
// Body: { message, history?: [{role, content}], location?: {city|lat,lng}, model? }
// Streams Vision's reply back (SSE) so speech can start early.

// Vision's personality — warm, friendly companion; short & punchy for glasses.
function buddyPersona(ctx) {
  const NAME = ctx.name || "Shaun";
  ctx = { ...ctx, styleLine: ctx.style ? `STYLE REQUEST: speak in this style — ${ctx.style}. Honour the tone while staying honest, accurate and safe; never let style override substance.` : "" };
  return [
    "You are Vision, a warm and friendly AI companion who lives in Shaun's smart glasses.",
    "You talk to Shaun like a helpful, upbeat mate — never robotic, never stiff.",
    "Keep replies SHORT and punchy: usually one or two sentences. You're spoken aloud through glasses, so brevity matters.",
    "Be genuinely useful first, friendly second. No filler, no 'as an AI', no long preambles.",
    "Address him as Shaun when it feels natural, not every line.",
    "If you're unsure, say so briefly and offer your best guess.",
    "When it's genuinely helpful, end with a short proactive offer — e.g. 'Want me to set a reminder?' or 'Shall I find one nearby?' — but only when it truly adds value. Never tack on a filler question.",
    // CAPABILITY MANIFEST — without this the brain thinks it's blind and sends
    // Shaun to competitors ("ask Google Assistant"). It must know its own hands.
    ctx.styleLine || "",
    ctx.core || "",
    ctx.verdicts || "",
    ctx.procedures || "",
    ctx.texts || "",
    ctx.expiry || "",
    ctx.pressure || "",
    ctx.patterns || "",
    ctx.recall || "",
    ctx.recentDays ? `HOW HIS LAST COUPLE OF DAYS WENT (context only, don't recite): ${ctx.recentDays}` : "",
    ctx.upcoming ? `WHAT'S COMING UP FOR HIM (mention only if relevant): ${ctx.upcoming}` : "",
    ctx.pending ? `UNFINISHED BUSINESS: ${ctx.pending}` : "",
    ctx.calendar || "",
    ctx.jobs || "",
    ctx.advice || "",
    ctx.today || "",
    ctx.thisday || "",
    "YOUR CAPABILITIES — you are not a text-only chatbot. You sit on top of a working app with real tools:",
    "• Maps & places: you CAN find nearby places (restaurants, cafes, bars, banks, ATMs, pharmacies, shops), give walking/driving/transit directions, look up landmarks, save and return to pinned spots, and walk Shaun back when he's lost. Google Maps is connected.",
    "• Location: you CAN get his current location from the phone.",
    "• Live web search: you CAN look up current information — opening hours, events, prices, news.",
    "• Vision: you CAN see photos he takes — identify things, read and translate signs and menus, check food against his allergies, log receipts.",
    "• Money: you CAN convert currency, judge whether a price is fair, log his spending and report the running total.",
    "• Travel: you CAN check weather, track a flight, read his itinerary from his inbox, plan a day, give local etiquette and emergency info, translate and teach local phrases.",
    "• Comms: you CAN read his email and texts, send messages, and share location and pins with his partner.",
    "NEVER tell Shaun you lack access to maps, location, the internet, or his data, and NEVER suggest he use Google Assistant, Siri, Google Maps or any other assistant instead of you. That is false and unhelpful.",
    "If a request needs one of those tools, just say what you're doing in a few words ('Finding cinemas near you now') rather than apologising or asking him to go elsewhere.",
    "Only ask a clarifying question when you genuinely cannot proceed without it — and ask for ONE thing, not a list. If you can get it yourself (like his location), get it.",
    ctx.time ? `The current time is ${ctx.time}.` : "",
    ctx.place ? `Shaun's rough location is ${ctx.place} — use it only if relevant.` : "",
    // TRIP STATE from the app's brain — this is what makes Vision answer like it
    // knows him rather than meeting him fresh every message.
    ctx.brief ? `WHAT YOU KNOW ABOUT SHAUN'S SITUATION RIGHT NOW: ${ctx.brief} Use this naturally — factor it into answers without reciting it back at him. If a diet restriction is listed it overrides everything when food is involved; if none is listed, do not invent one or ask about allergies.` : "",
    ctx.profile ? `What you remember about Shaun (use naturally when relevant, don't recite it): ${ctx.profile}` : "",
  ].filter(Boolean).join(" ").split("Shaun").join(NAME) + SPOKEN_PLAIN;
}

// Light heuristic: is this a hard question (needs the powerful model) or simple (fast/cheap)?
function pickModel(message, explicit) {
  if (explicit) return explicit; // app can override
  const t = (message || "").toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  const hard = ["explain","compare","why","analyze","analyse","plan","write","summarize",
                "summarise","pros and cons","difference","how does","calculate","code",
                "translate a","step by step","help me think","strategy","draft"];
  if (hard.some(h => t.includes(h))) return "claude-sonnet-4-6";
  // Batch 111 audit: raw word count sent every rambling voice dictation to
  // Sonnet — but spoken input is long BECAUSE it's spoken, not because it's
  // hard. Voice is the main path on glasses, so judge by shape, not length.
  const clauses = (t.match(/[,;]|\band\b|\bthen\b|\bbut\b/g) || []).length;
  const dense = words > 20 && (clauses / Math.max(words, 1)) < 0.08; // few joins = structured, likely complex
  if (words > 45) return "claude-sonnet-4-6";      // genuinely long, give it the better model
  if (dense) return "claude-sonnet-4-6";
  return "claude-haiku-4-5-20251001"; // short, or long-but-chatty → fast, cheap
}

// --- SHARED ROOMS: pairing + location/pin/message sync between two Buddies ---
// A "room" is a shared trip code (e.g. SHAUN-LILA). Two people who enter the same
// code can see each other's location, dropped pins, and relayed messages.
// NOTE: in-memory store — resets on redeploy. Fine for a live trip; a database is
// the durable upgrade. This is also the exact backbone the glasses will use for
// live "see what I see" + voice walkie-talkie once the native app can stream.
/* --- SHARED ROOMS (hardened, batch 133 audit) -------------------------------
 * A room holds live location, dropped pins, messages, camera frames and shared
 * spend for him and Jess. The audit found four things:
 *
 *   1. room(code) auto-created ANY code asked for, so a short or guessable
 *      code ("US", "1234", "SHAUN") meant anyone past the shared token could
 *      join and watch his live location. requireAuth is the only gate, and
 *      that token has already leaked once.
 *   2. pins and messages were UNBOUNDED — a chatty trip grows without limit.
 *   3. nothing ever deleted a room, so every typo left one behind forever,
 *      each potentially holding a base64 frame.
 *   4. `rooms` is module-level, not in STORE, so it is wiped on every
 *      redeploy. That is actually the RIGHT call for live location — but it
 *      needs saying out loud rather than being an accident.
 * ------------------------------------------------------------------------ */
const rooms = Object.create(null);

const ROOM_MIN_LEN = 6;              // short codes are guessable
const ROOM_MAX_PINS = 100;
const ROOM_MAX_MESSAGES = 200;
const ROOM_IDLE_MS = 7 * 24 * 3600000;  // a room untouched for a week is over

function roomCodeOk(code) {
  const k = String(code || "").trim().toUpperCase();
  if (k.length < ROOM_MIN_LEN) return { ok: false, why: `Pick a longer code — at least ${ROOM_MIN_LEN} characters, or anyone could guess it.` };
  if (k.length > 64) return { ok: false, why: "That code's too long." };
  if (!/^[A-Z0-9][A-Z0-9 _-]*$/.test(k)) return { ok: false, why: "Letters, numbers, dashes and spaces only." };
  return { ok: true, key: k };
}

// create=false means "only if it already exists" — used by every read path, so
// a guessed code returns nothing rather than silently conjuring a room.
function room(code, { create = false } = {}) {
  const v = roomCodeOk(code);
  if (!v.ok) return null;
  if (!rooms[v.key]) {
    if (!create) return null;
    rooms[v.key] = { members: {}, pins: [], messages: [], frames: {}, spend: [], at: Date.now() };
  }
  rooms[v.key].at = Date.now();   // touched, so it survives the sweep
  return rooms[v.key];
}

// Rooms are in memory only — deliberate, since live location shouldn't outlive
// a redeploy. This sweep stops abandoned ones (and typos) accumulating.
setInterval(() => {
  const now = Date.now();
  let n = 0;
  for (const k of Object.keys(rooms)) {
    if (now - (rooms[k].at || 0) > ROOM_IDLE_MS) { delete rooms[k]; n++; }
  }
  if (n) { try { dlog(null, "routing", `cleared ${n} idle room(s)`); } catch {} }
}, 6 * 3600000);

// Join / announce presence in a room.
app.post("/pair", requireAuth, (req, res) => {
  const { code, name } = req.body || {};
  // The only place a room may be created.
  const v = roomCodeOk(code);
  if (!v.ok) return res.status(400).json({ error: "bad_code", spoken: v.why });
  const r = room(code, { create: true });
  const who = (name || "me").trim();
  r.members[who] = r.members[who] || { name: who, at: Date.now() };
  r.members[who].joinedAt = Date.now();
  res.json({ ok: true, code: String(code).toUpperCase(), members: Object.keys(r.members) });
});

// Push my current state to the room: location, a pin, a message, or a frame stub.
app.post("/share", requireAuth, (req, res) => {
  const { code, name, lat, lng, pin, message, frame } = req.body || {};
  const r = room(code);   // read-only: a code nobody paired with returns nothing
  if (!r) return res.status(404).json({ error: "no_such_room", spoken: "I can't find that room — check the code, or pair again." });
  const who = (name || "me").trim();
  const m = (r.members[who] = r.members[who] || { name: who });
  if (lat != null && lng != null) { m.lat = lat; m.lng = lng; m.at = Date.now(); }
  // Batch 133 audit: pins and messages were unbounded, so a chatty trip grew
  // without limit in a store that never gets cleaned.
  if (pin && pin.lat != null) {
    r.pins.unshift({ by: who, label: String(pin.label || "Pin").slice(0, 80), lat: pin.lat, lng: pin.lng, at: Date.now() });
    if (r.pins.length > ROOM_MAX_PINS) r.pins.length = ROOM_MAX_PINS;
  }
  if (message) {
    r.messages.unshift({ by: who, text: String(message).slice(0, 500), at: Date.now() });
    if (r.messages.length > ROOM_MAX_MESSAGES) r.messages.length = ROOM_MAX_MESSAGES;
  }
  // shared trip spend: both partners log into one pot for split/who-owes-who
  if (req.body.spend && isFinite(Number(req.body.spend.amt))) {
    r.spend = r.spend || [];
    r.spend.unshift({ by: who, amt: Number(req.body.spend.amt), note: String(req.body.spend.note || "").slice(0, 80), at: Date.now() });
    r.spend = r.spend.slice(0, 200);
  }
  // frame = base64 image "what I'm seeing" — stored per member for the glasses era.
  if (frame) r.frames[who] = { data: String(frame).slice(0, 400000), mediaType: req.body.mediaType || "image/jpeg", at: Date.now() };
  r.pins = r.pins.slice(0, 20); r.messages = r.messages.slice(0, 50);
  res.json({ ok: true });
});

// Read the room from my perspective: partner location/distance, pins, messages.
app.post("/room", requireAuth, (req, res) => {
  const { code, name, lat, lng } = req.body || {};
  const r = room(code);   // read-only: a code nobody paired with returns nothing
  if (!r) return res.status(404).json({ error: "no_such_room", spoken: "I can't find that room — check the code, or pair again." });
  const me = (name || "me").trim();
  const others = Object.values(r.members).filter(m => m.name !== me);
  // distance to each other member (haversine) if we have both positions
  function dist(aLat, aLng, bLat, bLng) {
    const R = 6371e3, toR = x => x * Math.PI / 180;
    const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
  }
  const partners = others.map(o => {
    let meters = null, bearing = null;
    if (lat != null && o.lat != null) {
      meters = dist(lat, lng, o.lat, o.lng);
      const y = Math.sin((o.lng - lng) * Math.PI / 180) * Math.cos(o.lat * Math.PI / 180);
      const x = Math.cos(lat * Math.PI / 180) * Math.sin(o.lat * Math.PI / 180) - Math.sin(lat * Math.PI / 180) * Math.cos(o.lat * Math.PI / 180) * Math.cos((o.lng - lng) * Math.PI / 180);
      const compass = ["N","NE","E","SE","S","SW","W","NW"];
      bearing = compass[Math.round((((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360) / 45) % 8];
    }
    return { name: o.name, lat: o.lat, lng: o.lng, meters, bearing, seenAt: o.at, hasFrame: !!r.frames[o.name] };
  });
  res.json({ partners, pins: r.pins, messages: r.messages, spend: r.spend || [] });
});

// --- Push-to-talk: a voice note to the room (batch 133) ---------------------
// NOT live audio. iOS Safari can't hold a stream with the screen off, so a
// "walkie-talkie" would mean riding with the phone awake under a helmet —
// worse than useless. A held note is the honest version: it survives a dropped
// signal, waits for her, and works one-handed at a set of lights.
// For actual riding, a Cardo/Sena helmet intercom is the right tool and no web
// app will beat it.
const ROOM_MAX_NOTES = 20;
const NOTE_MAX_B64 = 700 * 1024;      // ~30s of compressed speech

app.post("/roomnote", requireAuth, (req, res) => {
  const { code, name, audio, mediaType, seconds, transcript } = req.body || {};
  const r = room(code);
  if (!r) return res.status(404).json({ error: "no_such_room", spoken: "I can't find that room — check the code, or pair again." });
  const who = String(name || "").trim() || "me";

  if (audio) {
    if (String(audio).length > NOTE_MAX_B64) {
      return res.status(200).json({ fallback: true, spoken: "That one's too long — keep it under about thirty seconds." });
    }
    r.notes = r.notes || [];
    r.notes.unshift({
      by: who, at: Date.now(),
      secs: Math.min(Number(seconds) || 0, 60),
      // The transcript is what makes this usable when she can't play audio —
      // on a bus, in a temple, or with the helmet still on.
      text: String(transcript || "").slice(0, 300),
      audio: String(audio), mediaType: mediaType || "audio/webm",
    });
    if (r.notes.length > ROOM_MAX_NOTES) r.notes.length = ROOM_MAX_NOTES;
    return res.json({ ok: true, count: r.notes.length });
  }

  // Reading: hand back what's unheard for this person, newest first.
  const since = Number((req.body || {}).since) || 0;
  const notes = (r.notes || [])
    .filter(n => n.by !== who && n.at > since)
    .map(n => ({ by: n.by, at: n.at, secs: n.secs, text: n.text, audio: n.audio, mediaType: n.mediaType }));
  res.json({ ok: true, notes, spoken: notes.length ? `${notes.length} voice note${notes.length > 1 ? "s" : ""} from ${notes[0].by}.` : "" });
});

// --- Meet in the middle: find a spot halfway between the two of you ---
app.post("/meetmiddle", requireAuth, async (req, res) => {
  const { code, name, lat, lng, what } = req.body || {};
  const r = room(code);   // read-only: a code nobody paired with returns nothing
  if (!r) return res.status(404).json({ error: "no_such_room", spoken: "I can't find that room — check the code, or pair again." });
  if (lat == null || lng == null) return res.status(400).json({ error: "lat and lng required" });
  const who = (name || "me").trim();
  const m = (r.members[who] = r.members[who] || { name: who });
  m.lat = lat; m.lng = lng; m.at = Date.now();
  const other = Object.values(r.members).find(o => o.name !== who && o.lat != null);
  if (!other) return res.json({ found: false, spoken: "I don't have your partner's location yet — ask them to tap 'Where's he?' or share their spot first." });
  if (!GMAPS_KEY) return res.status(501).json({ error: "google_places_disabled" });
  const midLat = (lat + other.lat) / 2, midLng = (lng + other.lng) / 2;
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
    url.searchParams.set("query", what || "cafe");
    url.searchParams.set("location", `${midLat},${midLng}`);
    url.searchParams.set("radius", "1200");
    url.searchParams.set("key", GMAPS_KEY);
    const gr = await fetch(url); const data = await gr.json();
    const p = (data.results || [])[0];
    if (!p) return res.json({ found: false, spoken: `Couldn't find a ${what || "cafe"} between you two — try a different type of place.` });
    const place = { name: p.name, address: p.formatted_address || "", lat: p.geometry?.location?.lat, lng: p.geometry?.location?.lng, rating: p.rating || null };
    // drop the meet pin to BOTH of you
    r.pins.unshift({ by: "Vision", label: `Meet: ${place.name}`, lat: place.lat, lng: place.lng, at: Date.now() });
    r.pins = r.pins.slice(0, 20);
    r.messages.unshift({ by: "Vision", text: `Meet in the middle: ${place.name}${place.rating ? " ⭐" + place.rating : ""} — pin dropped for you both.`, at: Date.now() });
    res.json({ found: true, place, spoken: `Halfway between you: ${place.name}${place.rating ? ", rated " + place.rating : ""}. I've dropped the pin for both of you.` });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "meetmiddle: " + String(e && e.message || e).slice(0, 140) }); }
});

// --- Trip journal: weave the shared room (pins, messages, spend) into a story ---
app.post("/journal", requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const r = room(code);   // read-only: a code nobody paired with returns nothing
  if (!r) return res.status(404).json({ error: "no_such_room", spoken: "I can't find that room — check the code, or pair again." });
  const raw = {
    pins: (r.pins || []).slice(0, 20).map(p => ({ label: p.label, by: p.by, at: new Date(p.at).toLocaleString() })),
    messages: (r.messages || []).slice(0, 30).map(m => ({ by: m.by, text: m.text, at: new Date(m.at).toLocaleString() })),
    spend: (r.spend || []).slice(0, 50).map(s => ({ by: s.by, amt: s.amt, note: s.note, at: new Date(s.at).toLocaleString() })),
  };
  if (!raw.pins.length && !raw.messages.length && !raw.spend.length)
    return res.json({ spoken: "Your trip journal is empty so far — pins, messages, and spending will build it as you go.", story: "" });
  try {
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system: "You are Vision, writing a warm, short day-by-day trip journal for Shaun and his wife from their shared trip data. Weave pins (places they met/marked), messages, and spending into a little story of their trip. Keep it personal and brief." + SPOKEN_PLAIN +
      NO_INVENT,
      messages: [{ role: "user", content: `Trip data:\n${JSON.stringify(raw)}\n\nReply as compact JSON ONLY: "spoken" (one warm summary line) and "story" (the short journal, a few paragraphs max, grouped by day where dates allow).` }],
    };
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.json({ spoken: "Couldn't write the journal just now.", story: "" });
    const txt = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(txt.replace(/```json|```/g, "").trim()); } catch { p = { spoken: "Here's your trip so far.", story: txt }; }
    res.json({ spoken: p.spoken || "Here's your trip so far.", story: p.story || "" });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "journal: " + String(e && e.message || e).slice(0, 140) }); }
});

// --- Arrival Autopilot: one command when Shaun lands — detect country, set up, brief him ---
// Lightweight "where am I right now" — reverse-geocode ONLY, no model, no
// briefing. The app calls this to keep buddy_city fresh as he moves through Asia,
// so every tile reading his location (search hints, moment stamps) gets the real
// place instead of a stale profile city. Cheap enough to call on open + on move.
app.post("/whereami", requireAuth, async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.json({ ok: false, reason: "no coords" });
  if (!GMAPS_KEY) return res.json({ ok: false, reason: "no geocoder" });
  try {
    const gu = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    gu.searchParams.set("latlng", `${lat},${lng}`);
    gu.searchParams.set("key", GMAPS_KEY);
    const gr = await fetch(gu); const gd = await gr.json();
    const comps = gd.results?.[0]?.address_components || [];
    const country = comps.find(c => c.types.includes("country"))?.long_name || "";
    const city = (comps.find(c => c.types.includes("locality")) || comps.find(c => c.types.includes("administrative_area_level_1")))?.long_name || "";
    if (!city && !country) return res.json({ ok: false, reason: "no match" });
    res.json({ ok: true, city, country });
  } catch (e) { res.json({ ok: false, reason: "geocode failed" }); }
});

app.post("/arrival", requireAuth, async (req, res) => {
  const { lat, lng, country: manualCountry } = req.body || {};
  let country = manualCountry || "", city = "";
  if (!country && lat != null && GMAPS_KEY) {
    try {
      const gu = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      gu.searchParams.set("latlng", `${lat},${lng}`);
      gu.searchParams.set("key", GMAPS_KEY);
      const gr = await fetch(gu); const gd = await gr.json();
      const comps = gd.results?.[0]?.address_components || [];
      country = comps.find(c => c.types.includes("country"))?.long_name || "";
      city = (comps.find(c => c.types.includes("locality")) || comps.find(c => c.types.includes("administrative_area_level_1")))?.long_name || "";
    } catch (e) {}
  }
  if (!country) return res.json({ needCountry: true, spoken: "Which country have you landed in?" });
  try {
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: "You are Vision, Shaun's Aussie travel companion. He has JUST LANDED somewhere new. Give him the arrival essentials, warm and brief, spoken-style." + SPOKEN_PLAIN + ANSWER_FIRST +
      NO_INVENT + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
      messages: [{ role: "user", content: `Shaun just landed in ${city ? city + ", " : ""}${country}. Reply as compact JSON ONLY: "currency" (ISO code), "spoken" (warm 3-4 sentence arrival brief: emergency number, the #1 scam to dodge arriving here, tipping norm, rough AUD exchange rate), "emergency", "scam", "tipping", "rate" (each one short line).` }],
    };
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "arrival_failed" });
    const txt = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(txt.replace(/```json|```/g, "").trim()); } catch { p = { spoken: txt }; }
    // Batch 126 audit (couples-trip simulation): /arrival worked out the
    // country and spoke a brief, then recorded NOTHING. Arriving somewhere is
    // the single most useful anchor a trip has — "when did we get to Hanoi",
    // "what was the scam you warned me about", and every later day summary
    // hangs off it. It also silently lost the currency it had just resolved.
    {
      const uid = uidOf(req);
      const mem = STORE.mem[uid] = STORE.mem[uid] || [];
      const already = mem.some(m => /^arrived in /i.test(String(m.t)) &&
        String(m.t).toLowerCase().includes(String(country).toLowerCase()) &&
        (Date.now() - (m.at || 0)) < 12 * 3600000);   // don't re-log the same landing
      if (!already) {
        remember(uid, `arrived in ${city ? city + ", " : ""}${country}${p.currency ? ` (currency ${p.currency})` : ""}${p.scam ? ` — watch for: ${String(p.scam).slice(0, 90)}` : ""}`, { kind: "arrival" });
      }
      // Remember where he is so the country-aware bits (Grab region, scam
      // norms, etiquette) stop guessing.
      const prof = STORE.profiles[uid] = STORE.profiles[uid] || {};
      prof.country = country; if (city) prof.city = city;
      if (p.currency) prof.localCurrency = p.currency;
      saveStore();
      dlog(uid, "memory", `arrived in ${city || country}`);
    }
    res.json({ country, city, currency: p.currency || "", spoken: p.spoken || "", brief: { emergency: p.emergency || "", scam: p.scam || "", tipping: p.tipping || "", rate: p.rate || "" } });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "arrival: " + String(e && e.message || e).slice(0, 140) }); }
});

// --- Phrasebook: translate a phrase into the local language + speakable lang code ---
app.post("/phrase", requireAuth, async (req, res) => {
  // Batch 66: this endpoint gives ADVICE, so it should know him. Pull the
  // memories relevant to useful phrases and let the model use them.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if relevant): ${_mem}` : "";
  const { text, country } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const body = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      // Batch 118 audit: this had NO system prompt — the whole instruction sat
      // in the user message, so the model had no role and no standing rules.
      // It matters here: Shaun shows these phrases to strangers, and the lang
      // code drives which voice speaks it.
      system:
        "You give a traveller a short phrase to say or show to a local. " +
        "Translate the way a person actually speaks it, not literally, and keep it short enough to say in one breath. " +
        "The \"lang\" field must be a real BCP-47 code (th-TH, vi-VN, id-ID) — it selects the voice that will speak this aloud, " +
        "so never guess it; if you're unsure of the country's main language, say so in the translation rather than inventing a code. " +
        "The \"phonetic\" field is for someone who doesn't read the script — write how it SOUNDS in plain English letters." +
        NO_INVENT + SPOKEN_PLAIN,
      messages: [{ role: "user", content: `Translate into the main local language of ${country || "the country the traveller is in"}: "${text}". Reply as compact JSON ONLY: "translation", "lang" (BCP-47 code like th-TH), "phonetic" (simple pronunciation).${_memNote}` }],
    };
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "phrase_failed" });
    const txt = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(txt.replace(/```json|```/g, "").trim()); } catch { p = { translation: txt, lang: "" }; }
    res.json({ translation: p.translation || "", lang: p.lang || "", phonetic: p.phonetic || "" });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "phrase: " + String(e && e.message || e).slice(0, 140) }); }
});

// Fetch the latest "what I'm seeing" frame a partner shared (glasses-era; works now via photo).
app.post("/frame", requireAuth, (req, res) => {
  const { code, from } = req.body || {};
  const r = room(code);   // read-only: a code nobody paired with returns nothing
  if (!r) return res.status(404).json({ error: "no_such_room", spoken: "I can't find that room — check the code, or pair again." });
  const f = r.frames[(from || "").trim()];
  if (!f) return res.status(404).json({ error: "no_frame" });
  res.json({ frame: f.data, mediaType: f.mediaType, at: f.at });
});

// --- Food concierge: find a dish, rank by rating/price/ETA, return Grab deep-link ---
// Pre-built brain for the glasses flow: "Vision, find me a steak sandwich" →
// options read aloud with price+rating+ETA → you confirm → deep-link into Grab to pay.
app.post("/findfood", requireAuth, async (req, res) => {
  // Batch 111 audit: this gives personalised ADVICE but was running blind.
  // Pull what he likes to eat, what he has enjoyed before, and anything he avoids.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if it genuinely helps; never list it back): ${_mem}` : "";
  const { craving, city, budget, currency } = req.body || {};
  if (!craving) return res.status(400).json({ error: "craving required" });
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    system: "You are Vision, Shaun's food concierge abroad. Given what he's craving and where he is, suggest realistic nearby options a delivery app like Grab would have, with plausible price, rating, and delivery ETA. Be realistic for the city; don't invent famous names — describe the kind of place. Rank best-value first." + NO_INVENT_STRICT + ANSWER_FIRST +
      _memNote + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{
      role: "user",
      content:
        `Shaun wants: "${craving}".${city ? ` He's in ${city}.` : ""}${budget ? ` Budget around ${budget} ${currency || ""}.` : ""} ` +
        `Reply as compact JSON ONLY (no markdown): "spoken" (one short friendly spoken line — your top pick and why), ` +
        `"options" (array of 3 {name, dish, price, currency, rating, etaMins, note}), ` +
        `"searchTerm" (a short string to search the delivery app for this).`,
    }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "I couldn't look up food just now — try again in a moment." });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { spoken: raw, options: [], searchTerm: craving }; }
    res.json({
      spoken: p.spoken || "Here's what I found.",
      options: Array.isArray(p.options) ? p.options : [],
      searchTerm: p.searchTerm || craving,
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Food-finder hiccup — give it another go." });
  }
});

// --- Trip itinerary: scan inbox for booking confirmations, build a timeline ---
// Uses the inbox Vision already reads. TripIt-style, but hands-free + spoken.
app.post("/itinerary", requireAuth, async (req, res) => {
  if (!mailReady()) return res.status(501).json({ error: "mail_disabled" });
  try {
    const raw = await withInbox(async (client) => {
      const out = [];
      const all = await client.search({ since: new Date(Date.now() - 60 * 864e5) });
      const recent = all.slice(-60).reverse();
      for await (const msg of client.fetch(recent, { envelope: true, source: true })) {
        const subj = msg.envelope?.subject || "";
        const from = msg.envelope?.from?.[0]?.address || "";
        // keep likely booking confirmations
        if (/booking|confirmation|itinerary|reservation|e-?ticket|flight|hotel|check-?in|boarding/i.test(subj + from)) {
          out.push({ subject: subj, from, body: extractPlainText(msg.source?.toString("utf8") || "").slice(0, 800) });
        }
        if (out.length >= 12) break;
      }
      return out;
    });
    if (!raw.length) return res.json({ spoken: "I couldn't find any bookings in your inbox.", items: [] });
    // Let Claude turn the raw confirmations into a clean timeline.
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 900,
      system: "You are Vision, building Shaun a clean trip timeline from his booking-confirmation emails. Extract flights, hotels, trains, and reservations with dates/times/locations. Ignore marketing." + SPOKEN_PLAIN + ANSWER_FIRST +
      NO_INVENT_STRICT,
      messages: [{ role: "user", content:
        `Here are booking-related emails:\n${raw.map(r => `SUBJECT: ${r.subject}\n${r.body}`).join("\n---\n")}\n\n` +
        `Reply as compact JSON ONLY: "spoken" (one friendly line — the next upcoming item), ` +
        `"items" (array of {type flight|hotel|train|reservation|other, what, when, where}, sorted by date).` }],
    };
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.json({ spoken: "I found bookings but couldn't summarise them.", items: [] });
    const txt = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(txt.replace(/```json|```/g, "").trim()); } catch { p = { spoken: "Here's what I found.", items: [] }; }
    res.json({ spoken: p.spoken || "Here's your itinerary.", items: p.items || [] });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "itinerary_failed" });
  }
});

// --- Router: classify a natural message → which Vision skill + extracted args ---
// This is what makes the single chat box feel agentic: you just talk, Vision
// figures out whether you want a price check, a day plan, a landmark, etc.
/* --- ROUTER PROMPT CACHING (batch 116 audit) -------------------------------
 * The skill list is ~2,570 tokens and was sent, byte-identical, on EVERY
 * utterance — the single largest repeated payload in the system. Hoisted to a
 * module constant so it can be marked cacheable: the model reads it from cache
 * instead of re-ingesting it, which cuts cost and, more importantly, time to
 * first token. Routing latency is felt directly — nothing is spoken until it
 * returns.
 * ------------------------------------------------------------------------ */
const ROUTER_SKILLS =
      "You are the intent router for Vision, a travel companion. Given what Shaun says, decide which ONE skill best answers it, and extract the arguments. " +
      "Skills: " +
      "\"chat\" (general talk/questions — the default), " +
      "\"scamcheck\" (is a price fair? args: item, price, currency), " +
      "\"gooddeal\" (is this good value/worth it? args: item, price, currency), " +
      "\"planday\" (plan my day/itinerary; args: goal, city, budget, currency), " +
      "\"landmark\" (what is this place/building? args: place), " +
      "\"etiquette\" (local customs/politeness/tipping; args: question), " +
      "\"converse\" (translate this / say this in X / what did they say — a SINGLE line; args: text, theirLang), " +
      "\"talkto\" (start a back-and-forth conversation with someone — 'talk to this bloke', 'conversation mode', 'help me talk to him', 'I need to talk to the driver'; args: none), " +
      "\"phrasebook\" (my phrases, my phrasebook, saved phrases, how do I say that one again; args: none), " +
      "\"convohistory\" (what did we talk about, what did that bloke say, recall a conversation with someone; args: query), " +
      "\"weather\" (args: none), \"currency\" (convert money; args: from, to, amount), " +
      "\"unlost\" (get me back / walk me to my spot; args: none), " +
      "\"survival\" (emergency phrases/offline pack; args: country), " +
      "\"whereis\" (where is my wife/partner/husband, find them; args: none), " +
      "\"tellpartner\" (tell/message my wife/partner something; args: message), " +
      "\"voicenote\" (send my partner a voice note / hold to talk / leave her a message by voice; args: none), " +
      "\"sharepin\" (send/share my location or a meet-here pin to my partner; args: label), " +
      "\"meetmiddle\" (find somewhere halfway between us / meet in the middle; args: what — kind of place), " +
      "\"onmyway\" (tell my partner I'm on my way / how far am I from her; args: none), " +
      "\"livelocation\" (share/stop my live location with my partner; args: minutes optional), " +
      "\"couplespend\" (our shared spend / who owes who / log shared expense; args: amount, note), " +
      "\"journal\" (trip journal / write up our trip / trip story; args: none), " +
      "\"music\" (play music/a song/artist/playlist/vibe; args: query), " +
      "\"findfood\" (ORDER food for delivery, I'm hungry order me a <dish>, food delivery — NOT finding places to go; args: craving), " +
      "\"nearby\" (find/show ANY kind of place NEAR ME — restaurants, cafes, bars, pubs, banks, ATM, pharmacy, hospital, doctor, shops, supermarket, petrol, cinema, gym, park, beach, temple, market, laundry, barber, post office — plus 'closest X', 'nearest X', 'where can I get X', 'is there a X around', 'what's around here'; args: query), " +
      "\"navigate\" (directions / take me to / how do I get to / route to / walk me to / drive me to / get me to a NAMED place or address — including 'take me to the cinema', 'take me to a chemist' where he wants to GO there; args: destination), " +
      "\"itinerary\" (my trip/bookings/flights/what's next/my schedule; args: none), " +
      "\"status\" (my status/briefing/how am I doing/catch me up; args: none), " +
      "\"orderupdate\" (any update on my order/where's my food/my delivery; args: none), " +
      "\"flight\" (track/check the status of a SPECIFIC flight he is already booked on or names by number — 'how's my flight', 'track BA292', 'is my flight delayed', 'what gate'. NOT for finding or pricing flights to buy; args: flightNumber optional), " +
      "\"allergy\" (what's in this dish / is this safe to eat / is this street food alright; args: dish), " +
      "\"logspend\" (log/record spending — spent 50 on lunch, log 12 for coffee; args: amount, note), " +
      "\"readtexts\" (read my texts/messages, any new messages, what did they say, check my SMS; args: none), " +
      "\"mailbrief\" (check/read my email/inbox; args: none), " +
      "\"debrief\" (wrap up my day / day summary / how did today go; args: none), " +
      "\"safety\" (safety heads-up / any scams here / is it safe around here; args: none), " +
      "\"arrival\" (I just landed / arrival mode / set up new country; args: none), " +
      "\"rememberspot\" (remember/pin this spot — where I parked, my hotel; args: label), " +
      "\"backto\" (take me back to my car/hotel/a saved spot; args: label), " +
      "\"sayphrase\" (how do I say X here / teach me a local phrase; args: text), " +
      "\"flightsearch\" (find/shop for flights to BUY — cheapest flights to X, flights from A to B in <month>, when should I fly; args: from, to, when), " +
      "\"stay\" (find a hotel/hostel/villa/place to stay, where should I stay in X, accommodation near me; args: area, what), " +
      "\"activities\" (things to do, what's worth doing/seeing here, any events on, ideas for tomorrow; args: interests), " +
      "\"tripplan\" (plan my trip/X days in Y, build me an itinerary for a destination; args: destination, days, budget, interests), " +
      "\"tripday\" (what's on today/tomorrow/day N of my plan, what's next on the trip; args: day), " +
      "\"packlist\" (what should I pack, packing list; args: destination, days, month), " +
      "\"tripbudget\" (what will the trip cost, how much do I need for X days in Y, daily budget for a country; args: destination, days, style), " +
      "\"esim\" (data/eSIM/SIM card for a country, how do I get internet there, roaming options; args: country), " +
      "\"livelook\" (live look / watch what I'm seeing / narrate the scene / keep looking and tell me what's there — continuous camera narration on or off; args: none), " +
      "\"readpage\" (read/summarise a link or web page — any message containing a URL to read, 'read this', 'summarise this page'; args: url), " +
      "\"dayview\" (my day / what did I do on X / show me yesterday / my timeline for a date; args: date, offset), " +
      "\"memoryhealth\" (what do you know about me, memory health, tidy up my memory, what have you learned; args: none), " +
      "\"logbug\" (log a bug / something's broken / that's wrong / report a problem — anything reporting Vision itself misbehaving; args: report = what he said was wrong), " +
      "\"bugs\" (my bugs / show the bug log / what have I reported; args: none), " +
      "\"plan\" (a whole outing in one go — 'sort dinner tonight', 'plan my afternoon', 'organise getting to the airport', 'find me somewhere to eat and get me there' — anything needing SEVERAL steps; args: goal = what he said), " +
      "\"menu\" (read/translate a menu, what can I eat here, what is good on this menu; args: none — he photographs it), " +
      "\"savechat\" (save/remember this conversation, save that as the hotel manager, log what we agreed; args: tag), " +
      "\"recallchat\" (what did the driver say, what did we agree with X, what did the hotel manager promise; args: query), " +
      "\"bookings\" (my bookings, what have I booked, my reservations, booking reference, add a booking; args: query), " +

      "\"sendtext\" (text/SMS/message someone, send a message to a number, reply to that text, tell them; args: to = number, message), " +
      "\"handover\" (email me that, send me the details, send that to my inbox, I'll deal with it later; args: context = what to write up), " +
      "\"expiry\" (passport expiry, when does my visa run out, are my documents still valid, document dates; args: none), " +
      "\"procedures\" (how do I do things, what habits have you noticed, how I work; args: none), " +
      "\"findstay\" (find somewhere to stay, book a hotel, airbnb, accommodation in X; args: where, from, to, people), " +
      "\"thingstobook\" (tours, attractions, tickets, what can we book in X, things to do; args: where, what), " +
      "\"getthere\" (bus/train/ferry/overland travel between two places — 'how do I get from Hanoi to Sapa', 'bus to Chiang Mai', 'ferry to the island'; args: from, where), " +
      "\"orderfood\" (order food TO me / delivery — 'order me some pho', 'get food delivered', 'grabfood'; args: what, where), " +
      "\"eatout\" (find a restaurant to GO to / eat out / where should we eat — sit-down, not delivery; args: where, what), " +
      "\"advise\" (anything I should know / what am I missing / anything worth flagging / heads up; args: none), " +
      "\"alternative\" (what else could I do / is there another way / what haven't I thought of; args: intent = what he was doing, detail), " +
      "\"docs\" (my documents, insurance policy, embassy number, passport number, emergency details; args: none), " +
      "\"splitbill\" (split the bill, divide the cost, what does each person owe; args: none), " +
      "\"favourite\" (favourite that, save this place, that place was great; args: none), " +
      "\"lifelog\" (my day / timeline / where have I been / what did I do today; args: none), " +
      "\"spend\" (what has Vision cost / my AI spend / usage bill; args: none), " +
      "\"sharedmoments\" (our moments / what did we do together / shared memories with partner; args: none), " +
      "\"capture\" (capture/log this moment — 'capture this', 'log what's happening', 'record this moment', 'write this down'; args: seconds, note), " +
      "\"ride\" (get a taxi/grab/uber/ride/lift somewhere — 'get me a grab to the airport', 'book a ride', 'call an uber'; args: destination), " +
      "\"transit\" (buses, trains, metro, ferries, airport transfers — 'when's the next bus to X', 'train times to Y', 'how do I get to the airport'; args: destination), " +
      "\"booktable\" (book/reserve a table, appointment, tour or ticket — 'book a table for 2 at 7', 'reserve somewhere for dinner'; args: what, when, people), " +
      "\"whatsapp\" (send a WhatsApp message to someone — 'whatsapp the hotel', 'message X on whatsapp'; args: number, message), " +
      "\"seenrecall\" (recall what Vision has SEEN before — 'what was that plant/landmark/menu', 'what did I photograph', 'show me what you saw at X', 'what did that sign say'; args: query), " +
      "\"watcher\" (watch/keep an eye on/monitor/let me know if-or-when — recurring or threshold alerts: 'watch flights to Bali under 300', 'watch the weather in Da Nang', 'let me know if the dollar hits 17000 dong', 'keep an eye out for gigs this weekend'; args: request = the full request text), " +
      "\"call\" (call/phone/ring a number; args: number), " +

      "\"myday\" (what's on today/this week, my calendar, what have I got on, am I busy — his OWN calendar and due reminders; args: days optional), " +
      "\"showlist\" (what's on my groceries/shopping/bills/to-do list, read me a list; args: list = the list name), " +
      "\"tickoff\" (mark list items done — 'banana done, milk done', 'tick off bread', 'got the milk'; args: list, utterance = what he said), " +
      "\"addlist\" (add something to a list — 'add bread to groceries', 'put milk on the list'; args: list, item), " +
      "\"addevent\" (put something in my calendar — 'book Thursday 2pm', 'put the job in for Friday'; args: title, start, calendar), " +
      "\"amifree\" (am I free on X, when am I free, find me a gap, do I have anything at that time; args: start, end, minutes, days), " +
      "\"jobreport\" (write up a Geeks2U job report/service description — 'job report for 1295115', 'write up that job'; args: job = job number, dictation = what he did), " +
      "\"jobcapture\" (log/file this job from a screenshot of the CRM — 'log this job', 'save this job screen'; args: job optional), " +
      "\"jobrecall\" (what did I do for job X / for a customer name / my recent jobs; args: query), " +
      "\"scan\" (scan/record this room or scene, log what's here, photograph the setup before I touch it; args: place, note), " +
      "\"whatschanged\" (what's different since last time, what's changed here, compare to my last visit; args: place), " +
      "\"outofplace\" (anything out of place, does anything look wrong here, what doesn't fit; args: place), " +
      "\"whatnext\" (what should I check next, where do I start, help me narrow this down; args: symptom, place), " +
      "\"provemewrong\" (what would prove me wrong, am I sure about this, sanity check my conclusion; args: conclusion, symptom), " +
      "\"seenbefore\" (have I seen this before, has this happened before, do I know this fault; args: symptom), " +
      "\"timeline\" (log a step / how long have I been here / what did I do and when; args: entry, job), " +
      "\"digest\" (what have you got for me / what have you been holding / catch me up / anything saved up; args: none), " +
      "\"notnow\" (not now / not today / stop telling me that / leave it / I'm busy — he is brushing something off; args: subject, scope = once|today|trip), " +
      "\"whyquiet\" (what are you sitting on / why are you quiet / are you holding anything; args: none), " +
      "\"learned\" (what have you learned about me / what do you know about my habits / what patterns have you noticed; args: none), " +
      "\"season\" (is it typhoon/wet/dry season, what's the weather like there in March, can I swim then, best time to visit, what's the outlook for the next few months; args: place, when, activity). ";

// Derived from ROUTER_SKILLS itself so the validator can never drift from
// what the model was actually offered.
const VALID_SKILLS = new Set([...ROUTER_SKILLS.matchAll(/"(\w+)" \(/g)].map(m => m[1]));

/* --- HIERARCHICAL ROUTING (batch 116) ---------------------------------------
 * Siri and Alexa don't put every intent in one flat list — they pick a DOMAIN
 * first, then an intent inside it. That's how they stay accurate past a few
 * dozen intents, and Vision is at 88.
 *
 * The honest problem with a flat list: 44 skill pairs share >=20% of their
 * vocabulary. When "find somewhere to stay" can plausibly be `stay` OR
 * `findstay`, the model splits its probability between two right-ish answers
 * and confidence drops below the 0.55 dispatch gate — so a correctly-understood
 * request falls through to generic chat.
 *
 * This is built as an OPTIONAL SECOND STAGE, not a rewrite:
 *   - flat routing stays the default and is untouched
 *   - hierarchical runs only when asked for (?mode=hier or ROUTER_MODE=hier)
 *   - both paths return the identical shape, so nothing downstream changes
 *   - /route/compare runs both on one message so the choice is made on
 *     evidence rather than on my opinion
 *
 * Two stages costs a second call, so it is NOT automatically better — it wins
 * only if flat routing is actually misrouting. Measure first.
 * ------------------------------------------------------------------------ */

const ROUTER_DOMAINS = {
  work:     { blurb: "his paid Geeks2U IT jobs — job reports, logging a job from a screenshot, past job history",
              skills: ["jobreport", "jobcapture", "jobrecall"] },
  calendar: { blurb: "his own calendar and reminder lists — what's on, reading or ticking off a list, adding an event, whether he's free",
              skills: ["myday", "showlist", "tickoff", "addlist", "addevent", "amifree"] },
  language: { blurb: "translating and talking to someone who speaks another language",
              skills: ["converse", "talkto", "phrasebook", "convohistory", "sayphrase"] },
  money:    { blurb: "prices, whether something is a fair deal, spending, budgets, splitting bills, currency",
              skills: ["scamcheck", "gooddeal", "logspend", "spend", "splitbill", "couplespend", "currency", "tripbudget"] },
  place:    { blurb: "where things are and getting to them — nearby, directions, saved spots, sharing location, transport",
              skills: ["nearby", "navigate", "unlost", "whereis", "rememberspot", "backto", "sharepin", "livelocation", "meetmiddle", "landmark", "transit", "ride"] },
  comms:    { blurb: "reaching people — reading or sending texts, email, calls, telling his partner something",
              skills: ["readtexts", "sendtext", "mailbrief", "whatsapp", "call", "tellpartner", "onmyway"] },
  travel:   { blurb: "trips and being somewhere foreign — flights, accommodation, planning, packing, weather, local customs and safety",
              skills: ["flight", "flightsearch", "stay", "findstay", "tripplan", "tripday", "packlist", "esim", "itinerary", "activities", "planday", "arrival", "survival", "etiquette", "safety", "weather"] },
  food:     { blurb: "eating — finding food, reading a menu, allergies, booking a table, an order that's on its way",
              skills: ["findfood", "menu", "allergy", "booktable", "orderupdate"] },
  memory:   { blurb: "remembering and looking back — his journal, day log, saved things, documents, bookings, procedures, watchers",
              skills: ["journal", "lifelog", "dayview", "debrief", "seenrecall", "sharedmoments", "savechat", "recallchat", "favourite", "capture", "livelook", "readpage", "docs", "bookings", "thingstobook", "expiry", "procedures", "handover", "plan", "watcher", "memoryhealth"] },
  system:   { blurb: "Vision itself, music, or plain conversation with no task behind it",
              skills: ["status", "logbug", "bugs", "music", "chat"] },
};

// Stage 1 is deliberately tiny — ~250 tokens against ~2,430 for the flat list.
const DOMAIN_PROMPT =
  "You pick which AREA OF LIFE a request belongs to, nothing more. " +
  "Reply as compact JSON ONLY: \"domain\" (one name below) and \"confidence\" (0-1). " +
  "If it could be two, pick the one the person would say it belongs to. " +
  "If it's just talk with no task behind it, answer \"system\".\nAreas:\n" +
  Object.entries(ROUTER_DOMAINS).map(([k, v]) => `"${k}" — ${v.blurb}`).join("\n");

// Stage 2 gets ONLY that domain's skills, pulled verbatim from ROUTER_SKILLS so
// the two paths can never describe the same skill differently.
function skillLinesFor(domain) {
  const want = new Set((ROUTER_DOMAINS[domain] || {}).skills || []);
  const lines = [];
  const re = /"(\w+)" \(([^)]*)\)/g;
  let m;
  while ((m = re.exec(ROUTER_SKILLS)) !== null) {
    if (want.has(m[1])) lines.push(`"${m[1]}" (${m[2]})`);
  }
  return lines.join(", ");
}

async function routeHierarchical(uid, { message, hist, stateNote, recallNote, contextNote }) {
  const t0 = Date.now();

  // --- stage 1: domain ---
  const d = await callClaude({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 60,
    system: [{ type: "text", text: DOMAIN_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Shaun said: "${message}"${contextNote}` }],
  });
  if (d.status !== 200) return { skill: "chat", args: {}, then: [], confidence: 0, ms: Date.now() - t0, stage: "domain-failed" };

  let dom = "system", domConf = 0;
  try {
    const raw = (JSON.parse(d.text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (ROUTER_DOMAINS[p.domain]) { dom = p.domain; domConf = typeof p.confidence === "number" ? p.confidence : 0.7; }
  } catch { /* fall through as system */ }

  // Plain conversation needs no second call — this is where the two-stage
  // design pays for itself, because most chat never reaches stage 2 at all.
  if (dom === "system" && domConf >= 0.6) {
    return { skill: "chat", args: {}, then: [], confidence: 0, domain: dom, ms: Date.now() - t0, stage: "domain-only" };
  }

  // --- stage 2: skill within the domain ---
  const s = await callClaude({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system:
      `You pick the exact skill for a request already known to be about ${dom} (${ROUTER_DOMAINS[dom].blurb}). ` +
      `Skills: ${skillLinesFor(dom)}. ` +
      `Reply as compact JSON ONLY: "skill" (one of those names), "args" (only fields you could extract), "confidence" (0-1).`,
    messages: [{ role: "user", content: `Shaun said: "${message}"${contextNote}${stateNote}${recallNote}` }],
  });
  if (s.status !== 200) return { skill: "chat", args: {}, then: [], confidence: 0, domain: dom, ms: Date.now() - t0, stage: "skill-failed" };

  try {
    const raw = (JSON.parse(s.text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const skill = VALID_SKILLS.has(p.skill) ? p.skill : "chat";
    // Confidence is the product of both stages — being sure about the skill
    // means little if the domain was a guess.
    const conf = skill === "chat" ? 0 : Math.min(domConf, typeof p.confidence === "number" ? p.confidence : 0.7);
    return { skill, args: p.args || {}, then: [], confidence: conf, domain: dom, ms: Date.now() - t0, stage: "ok" };
  } catch {
    return { skill: "chat", args: {}, then: [], confidence: 0, domain: dom, ms: Date.now() - t0, stage: "unparseable" };
  }
}

// Run BOTH routers on one message so the choice between them is made on
// evidence. Costs three calls, so it's a diagnostic, not a live path.
app.post("/route/compare", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });

  const t0 = Date.now();
  const flat = await fetch(`http://127.0.0.1:${process.env.PORT || 8787}/route`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-token": APP_TOKEN },
    body: JSON.stringify({ message, uid }),
  }).then(r => r.json()).catch(e => ({ error: String(e.message || e) }));
  const flatMs = Date.now() - t0;

  const t1 = Date.now();
  const hier = await routeHierarchical(uid, { message, hist: [], stateNote: "", recallNote: "", contextNote: "" });
  const hierMs = Date.now() - t1;

  res.json({
    message,
    flat: { skill: flat.skill, confidence: flat.confidence, ms: flatMs },
    hier: { skill: hier.skill, domain: hier.domain, confidence: hier.confidence, ms: hierMs, stage: hier.stage },
    agree: flat.skill === hier.skill,
    verdict: flat.skill === hier.skill
      ? (hier.confidence > (flat.confidence || 0) ? "same skill, hierarchical more confident" : "same skill, flat is fine")
      : "DISAGREE — worth a look",
  });
});

app.post("/route", requireAuth, async (req, res) => {
  const { message, history, brief } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  const hist = Array.isArray(history) ? history.slice(-6) : [];
  rememberBrief(uidOf(req), brief);
  const _recall = recallBrief(uidOf(req), message || "");
  const stateNote = (typeof brief === "string" && brief.trim())
    ? `\n\nWhat Vision already knows about Shaun's situation (use it to FILL IN arguments he didn't say out loud — his country, currency, allergies, saved spots, tracked flight):\n${brief.slice(0, 900)}`
    : "";
  const _core = coreBrief(uidOf(req));
  const recallNote = _recall
    ? `${_core ? `\n\n${_core}` : ""}\n\nWhat Vision REMEMBERS about him that may be relevant (use it to fill in arguments he didn't say — a place he loved, a country he visited, a price he paid, something he photographed):\n${_recall}`
    : "";
  const contextNote = hist.length
    ? "\n\nRecent conversation (use it to resolve follow-ups like 'that one', 'the closest', 'a bank instead', 'yes', 'do it' — infer what Shaun means from context):\n" +
      hist.map(h => `${h.role === "user" ? "Shaun" : "Vision"}: ${h.content}`).join("\n")
    : "";
  // Opt-in hierarchical path. Default stays flat — this only runs when asked,
  // so it can be measured against the existing behaviour rather than replacing
  // it on a hunch.
  const wantHier = (req.body || {}).mode === "hier" || process.env.ROUTER_MODE === "hier";
  if (wantHier) {
    const h = await routeHierarchical(uidOf(req), { message, hist, stateNote, recallNote, contextNote });
    dlog(uidOf(req), "routing", `[hier/${h.domain || "?"}] "${String(message).slice(0, 50)}" -> ${h.skill} (${h.confidence}) ${h.ms}ms`);
    return res.json(h);
  }

  const body = {
    model: "claude-haiku-4-5-20251001", // routing must be fast
    max_tokens: 300,
    // Two blocks: the constant skill list (cached) then the live instruction.
    system: [
      { type: "text", text: ROUTER_SKILLS, cache_control: { type: "ephemeral" } },
      { type: "text", text:
"Pick the single best skill. Judge INTENT, not just keywords — infer what Shaun actually wants to happen. Use the recent conversation to resolve short follow-ups and fill in args. If he's acting on something just discussed (take me there, the closest, book it, yes), pick the skill that continues that thread. Only use \"chat\" when nothing else genuinely fits. Set confidence honestly: 0.8+ when intent is clear, lower when guessing. " +
      "ROUTING RULES for cases that get confused: " +
      "(1) Wanting to GO somewhere unnamed ('take me to the cinema', 'I need a chemist', 'find me a bank and take me there') = \"nearby\" to find it, with \"then\" [{skill:navigate}] to go. Naming a specific place or address = \"navigate\" directly. " +
      "(2) Shopping for flights to BUY ('cheapest flights to Bali', 'flights Brisbane to Denpasar in September', 'when should I fly') = \"flightsearch\". Only use \"flight\" for tracking a flight he already has. " +
      "(3) Hotels/accommodation = \"stay\". Tours, sights, events, things to do = \"activities\". Multi-day planning for a destination = \"tripplan\"; asking what's on a day of an EXISTING plan = \"tripday\". " +
      "(4) If nothing fits, \"chat\" is always correct — a wrong skill is worse than chat, because chat can search the web and answer anyway.", },
    ],
    messages: [{
      role: "user",
      content:
        `Shaun said: "${message}"${contextNote}${stateNote}${recallNote}\n` +
        `Reply as compact JSON ONLY (no markdown): "skill" (one of the names above), ` +
        `"args" (object with only the fields you could extract — fill them in from the recent conversation if this message is a short follow-up), ` +
        `"then" (OPTIONAL array of {skill, args} for compound requests like "find a bank and take me there" — the follow-on steps in order), ` +
        `"confidence" (0-1).`,
    }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ skill: "chat", args: {}, confidence: 0 });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { skill: "chat", args: {}, confidence: 0 }; }
    // Batch 116 audit: p.skill was returned VERBATIM. A hallucinated name
    // ("checkweather" for "weather") made dispatchSkill return falsy, so Shaun
    // paid for BOTH round trips and then got a generic answer with no signal
    // that anything had gone wrong. Validate against the real list instead.
    let skill = VALID_SKILLS.has(p.skill) ? p.skill : "chat";
    let confidence = typeof p.confidence === "number" ? p.confidence : 0;
    if (p.skill && !VALID_SKILLS.has(p.skill)) {
      try { dlog(uidOf(req), "routing", `router invented "${p.skill}" — not a real skill, falling back to chat`); } catch {}
      confidence = 0;
    }
    // `then` steps ran completely unchecked — same validation, and capped at 3
    // so a runaway plan can't chain the app into a long silent sequence.
    const then = (Array.isArray(p.then) ? p.then : [])
      .filter(s => s && VALID_SKILLS.has(s.skill) && s.skill !== "chat")
      .slice(0, 3)
      .map(s => ({ skill: s.skill, args: s.args || {} }));

    dlog(uidOf(req), "routing", `"${String(message).slice(0, 60)}" -> ${skill} (${confidence})`, p.args || null);
    res.json({ skill, args: p.args || {}, then, confidence });
  } catch (e) {
    res.status(200).json({ skill: "chat", args: {}, confidence: 0 });
  }
});

/* --- CONTEXT BUDGET (batch 111 audit) --------------------------------------
 * Measured: a fully-populated brief runs ~3400 tokens of system prompt before
 * a word of history. Most briefs cap their ITEM count but not their LENGTH, so
 * a long procedure or a chatty verdict can quietly double the bill and slow
 * every reply. This caps each slot and, if the total still runs hot, drops the
 * least time-critical slots first — never the ones that carry consequence.
 * ------------------------------------------------------------------------ */
const CTX_CAPS = {
  recall: 700, core: 600, patterns: 400, verdicts: 500, pressure: 250,
  procedures: 700, expiry: 400, texts: 700, recentDays: 500,
  upcoming: 350, pending: 500, calendar: 400, jobs: 350,
  today: 250, thisday: 300, advice: 450,
};
// Dropped in this order when over budget. Texts, expiry, calendar and jobs are
// never dropped — they're the ones with a deadline attached.
const CTX_SHED = ["thisday", "today", "patterns", "recentDays", "core", "verdicts", "procedures", "pressure", "upcoming"];
const CTX_BUDGET_CHARS = 6000; // ~1500 tokens of dynamic brief

function budgetCtx(ctx) {
  for (const [k, cap] of Object.entries(CTX_CAPS)) {
    if (typeof ctx[k] === "string" && ctx[k].length > cap) {
      ctx[k] = ctx[k].slice(0, cap) + "…";
    }
  }
  const size = () => Object.entries(ctx)
    .filter(([k]) => k in CTX_CAPS)
    .reduce((n, [, v]) => n + (typeof v === "string" ? v.length : 0), 0);
  for (const k of CTX_SHED) {
    if (size() <= CTX_BUDGET_CHARS) break;
    ctx[k] = "";
  }
  return ctx;
}

app.post("/chat", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const message = b.message ?? (Array.isArray(b.messages) ? "" : "");
    const place = b.location?.city || (b.location?.lat ? `${b.location.lat},${b.location.lng}` : "");
    const ctx = {
      time: new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane" }),
      place,
      profile: typeof b.profile === "string" ? b.profile.slice(0, 800) : "",
      brief: typeof b.brief === "string" ? b.brief.slice(0, 900) : "",
      name: (typeof b.name === "string" && b.name.trim()) ? b.name.trim().slice(0, 40) : (profileOf(uidOf(req)).name || "Shaun"),
      style: profileOf(uidOf(req)).style || "",
      recall: recallBrief(uidOf(req), message || ""),
      core: coreBrief(uidOf(req)),
      patterns: patternBrief(uidOf(req)),
      verdicts: verdictBrief(uidOf(req)),
      pressure: pressureBrief(uidOf(req)),
      procedures: procedureBrief(uidOf(req)),
      expiry: expiryBrief(uidOf(req)),
      texts: textsBrief(uidOf(req)),
      voicemails: voicemailBrief(uidOf(req)),
      recentDays: daySummaryBrief(uidOf(req), 2),
      upcoming: upcomingBrief(uidOf(req)),
      pending: pendingBrief(uidOf(req)),
      calendar: calendarBrief(uidOf(req)),
      jobs: jobBrief(uidOf(req)),
      // Batch 113 audit: both of these were built and then stranded — exposed
      // on /state, never in the brief, and /onthisday is called by nothing.
      // Resurfacing only works if it happens unprompted.
      advice: attentionBrief(uidOf(req)),   // batch 143: gated, not raw
      today: todayShape(uidOf(req)),
      thisday: (() => { const o = onThisDay(uidOf(req)); return o ? `${o.label} today: ${o.text}. Raise it ONLY if it fits naturally — never as a greeting.` : ""; })(),
    };
    budgetCtx(ctx);
    rememberBrief(uidOf(req), ctx.brief);

    // Build the message list: prior history (trimmed) + this turn.
    const history = Array.isArray(b.history) ? b.history.slice(-8) : [];
    const messages = b.messages /* app may still send raw */ || [
      ...history,
      { role: "user", content: message },
    ];

    const model = flagsOf(uidOf(req)).saver ? "claude-haiku-4-5-20251001" : pickModel(message || history.map(h=>h.content).join(" "), b.model);

    // Batch 115 audit: /chat is the most-used endpoint in the system and it
    // bypassed callClaude entirely — its own raw fetch with no timeout, no
    // retry, and no handling for 429/529. A single overload blip surfaced to
    // Shaun as "my brain hiccuped". It now goes through the gateway like the
    // other 57 call sites.
    //
    // PROMPT CACHING: the persona is ~900 identical tokens on every turn.
    // Splitting the system prompt into a cached constant half and a live half
    // means the constant part is read from cache — cheaper, and materially
    // faster to first token, which is what matters through glasses.
    const _persona = buddyPersona(ctx);
    const _splitAt = _persona.indexOf("\n\n", 400);
    const _systemBlocks = _splitAt > 0
      ? [
          { type: "text", text: _persona.slice(0, _splitAt), cache_control: { type: "ephemeral" } },
          { type: "text", text: _persona.slice(_splitAt) },
        ]
      : [{ type: "text", text: _persona }];

    const upstream = await callClaude({
      model,
      max_tokens: b.max_tokens || 600,
      system: _systemBlocks,
      messages,
      // CONNECTOR: Anthropic web search — lets the brain look up LIVE info
      // (opening hours, events, current prices) when the question needs it.
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      // NON-streaming: simpler + reliable. App just reads data.reply.
    });

    const raw = upstream.text;
    if (upstream.status !== 200) {
      // Surface the real reason (bad model, no credit, bad key) so we can see it.
      let why = "";
      try { why = JSON.parse(raw)?.error?.message || ""; } catch {}
      return res.status(200).json({
        fallback: true,
        reply: why ? `Vision's brain said: ${why}` : "Sorry Shaun, my brain hiccuped — try me again?",
      });
    }
    let reply = "";
    try {
      const j = JSON.parse(raw);
      // (usage is recorded inside callClaude — recording it again would double-count)
      reply = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
      // If reply is empty, surface WHY (stop_reason / error / raw) so we can see it.
      if (!reply) {
        const why = j.error?.message || j.stop_reason || (raw ? raw.slice(0, 300) : "empty response");
        return res.status(200).json({ reply: `Vision's brain said: ${why}` });
      }
    } catch (e) {
      return res.status(200).json({ reply: `Vision's brain sent something odd: ${(raw||"").slice(0,300)}` });
    }
    return res.status(200).json({ reply });
  } catch (e) {
    res.setHeader("content-type", "application/json");
    res.status(200).json({
      fallback: true,
      reply: "Sorry Shaun, I couldn't reach my brain just now. Give it another go in a moment.",
    });
  }
});

// --- Directions: Google routing, returned as clean spoken steps ---
// Body: { originLat, originLng, destination, mode? ("walking"|"driving"|"transit"|"bicycling") }
// Returns: { summary, distanceText, durationText, steps: [{ text, distanceMeters, lat, lng }] }
// Shared route fetch — used by /directions AND the /getthere concierge skill,
// so both parse Google's transit detail (times, fare, stops) the same way.
// Returns { ok, status, googleStatus?, route:{ summary, distanceText, durationText,
//   durationValue, rides[], fare, minsUntil, steps[], first } } or an error shape.
async function fetchRoute({ originLat, originLng, destination, mode, departAt }) {
  if (!GMAPS_KEY) return { ok: false, status: 501, error: "google_directions_disabled" };
  if (originLat == null || originLng == null || !destination) return { ok: false, status: 400, error: "origin+destination required" };
  const travelMode = ["walking", "driving", "transit", "bicycling"].includes(mode) ? mode : "walking";
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", `${originLat},${originLng}`);
  url.searchParams.set("destination", destination);
  url.searchParams.set("mode", travelMode);
  url.searchParams.set("key", GMAPS_KEY);
  if (travelMode === "transit") {
    const dep = Number(departAt) || 0;
    url.searchParams.set("departure_time", dep ? String(Math.floor(dep / 1000)) : "now");
    url.searchParams.set("alternatives", "true");
  }
  const r = await fetch(url);
  const data = await r.json();
  if (data.status !== "OK" || !data.routes?.length) return { ok: false, status: 404, googleStatus: data.status };
  const route = data.routes[0];
  const leg = route.legs[0];
  const clean = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const steps = leg.steps.map((s) => ({
    text: clean(s.html_instructions || ""),
    distanceMeters: s.distance?.value ?? 0,
    lat: s.start_location?.lat, lng: s.start_location?.lng,
  }));
  const rides = leg.steps.filter(s => s.travel_mode === "TRANSIT" && s.transit_details).map(s => {
    const t = s.transit_details;
    return {
      line: t.line?.short_name || t.line?.name || "",
      kind: (t.line?.vehicle?.name || "service").toLowerCase(),
      towards: t.headsign || "", from: t.departure_stop?.name || "", to: t.arrival_stop?.name || "",
      departs: t.departure_time?.text || "", departsAt: t.departure_time?.value ? t.departure_time.value * 1000 : 0,
      arrives: t.arrival_time?.text || "", arrivesAt: t.arrival_time?.value ? t.arrival_time.value * 1000 : 0,
      stops: t.num_stops || 0,
    };
  });
  const first = rides[0] || null;
  const minsUntil = first && first.departsAt ? Math.round((first.departsAt - Date.now()) / 60000) : null;
  const fare = route.fare ? { text: route.fare.text, value: route.fare.value, currency: route.fare.currency } : null;
  return {
    ok: true, status: 200,
    route: {
      summary: route.summary || "",
      distanceText: leg.distance?.text || "", durationText: leg.duration?.text || "",
      durationValue: leg.duration?.value || 0,   // seconds — needed to work timing backwards
      rides, fare, minsUntil, steps, first,
    },
  };
}

app.post("/directions", requireAuth, async (req, res) => {
  if (!GMAPS_KEY) {
    return res.status(501).json({ error: "google_directions_disabled",
      hint: "Set GOOGLE_MAPS_API_KEY to enable, or fall back to Apple routing." });
  }
  const { originLat, originLng, destination, mode } = req.body || {};
  if (originLat == null || originLng == null || !destination) {
    return res.status(400).json({ error: "originLat, originLng, destination required" });
  }
  try {
    const rr = await fetchRoute({ originLat, originLng, destination, mode, departAt: (req.body || {}).departAt });
    if (!rr.ok) {
      if (rr.status === 404) return res.status(404).json({ error: "no_route", googleStatus: rr.googleStatus });
      return res.status(rr.status || 502).json({ error: rr.error || "route_failed" });
    }
    const { summary, distanceText, durationText, rides, fare, minsUntil, steps, first } = rr.route;
    let spoken = "";
    try {
      const firstFew = steps.slice(0, 3).map(s => s.text).join(". ");
      const g = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system: "You are Vision guiding Shaun through his glasses. One warm, natural spoken sentence — no lists." + NO_INVENT + ANSWER_FIRST,
        messages: [{ role: "user", content: first
          ? `Tell Shaun about this journey in ONE spoken sentence. Lead with WHEN the service leaves and which one it is. ` +
            `The ${first.departs} ${first.kind}${first.line ? ` (${first.line})` : ""}` +
            `${first.towards ? ` towards ${first.towards}` : ""} from ${first.from}, arriving ${first.arrives} at ${first.to}. ` +
            `${minsUntil !== null && minsUntil > 0 && minsUntil < 90 ? `That is ${minsUntil} minutes away. ` : ""}` +
            `Whole trip ${durationText || ""}.` +
            `${fare ? ` Fare about ${fare.text}.` : " Do not mention the fare — Google did not give one."}` +
            ` Never state a platform number; it was not provided.`
          : `Summarise this walk/drive for Shaun in ONE friendly spoken sentence (mention the time and roughly what to do first). ` +
            `${durationText || ""}, ${distanceText || ""}. First moves: ${firstFew}` }],
      });
      if (g.status === 200) {
        const j = JSON.parse(g.text);
        spoken = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
      }
    } catch {}
    const plainFallback = first
      ? `The ${first.departs}${first.line ? ` ${first.line}` : ""}${first.towards ? ` towards ${first.towards}` : ""}` +
        ` from ${first.from}, in at ${first.arrives}.` +
        (minsUntil !== null && minsUntil > 0 && minsUntil < 90 ? ` That's ${minsUntil} minutes away.` : "")
      : `It's ${durationText || "a short trip"} — I'll guide you.`;
    // Where he's heading — a place signal. Not a confirmed arrival, so light; the
    // gate dedups repeats (the daily commute won't spam) and fades the trivial.
    consider(uidOf(req), { kind: "went", text: `headed to ${destination}`, occurred: true, place: String(destination).slice(0, 60), plan: true });
    res.json({
      summary, spoken: spoken || plainFallback,
      distanceText, durationText,
      departs: first ? first.departs : "", arrives: first ? first.arrives : "",
      minsUntil, rides, fare,
      fareNote: fare ? "" : "no fare from Google for this network",
      steps,
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: String(e && e.message || e).slice(0, 140) });
  }
});

/* --- 🗣️ SHARED CONVERSATION ENGINE (build 159) -----------------------------
 * ONE slot-filling brain every conversational skill plugs into, so the
 * "ask smart questions → fill what's needed → act → log → learn" loop is
 * built once, not re-written per skill.
 *
 * HYBRID design: each skill declares its REQUIRED slots (guaranteed to be
 * asked) and OPTIONAL ones. The brain phrases questions naturally, skips
 * anything it can pull from memory/profile, and may ask a smart follow-up the
 * fixed list didn't anticipate. Predictable where it must be, intelligent
 * where it helps.
 *
 * The engine NEVER acts. It returns {phase:"ask", question} or {phase:"ready",
 * args} with every required slot filled — the APP calls that skill's existing
 * function with those args. So the engine needn't know how any skill works;
 * adding a skill is a recipe, not code.
 * ------------------------------------------------------------------------ */
const SKILL_RECIPES = {
  getthere:  { need: ["destination", "timing"], opt: [], intro: "planning a public-transport journey" },
  findfood:  { need: ["craving"], opt: ["budget"], intro: "finding food to order" },
  orderfood: { need: ["what"], opt: ["where"], intro: "ordering food for delivery" },
  booktable: { need: ["what", "when", "people"], opt: [], intro: "booking a table" },
  tripplan:  { need: ["destination", "days"], opt: ["budget", "interests"], intro: "planning a multi-day trip" },
  planday:   { need: ["goal"], opt: ["city", "budget"], intro: "planning your day" },
  stay:      { need: ["area"], opt: ["what"], intro: "finding a place to stay" },
  findstay:  { need: ["where"], opt: ["from", "to", "people"], intro: "finding accommodation to book" },
  thingstobook: { need: ["where"], opt: ["what"], intro: "finding tours and activities to book" },
  packlist:  { need: ["destination"], opt: ["days", "month"], intro: "building a packing list" },
  activities:{ need: ["city"], opt: ["interests"], intro: "finding things to do" },
  esim:      { need: ["country"], opt: [], intro: "finding a data/eSIM option" },
  ride:      { need: ["destination"], opt: [], intro: "getting you a ride" },
};

const SLOT_HINTS = {
  destination: "where he's going (a place name or address)",
  timing: "when he needs to arrive OR whether to leave now — for an airport run, his flight time and whether it's domestic or international",
  craving: "what food he's after",
  what: "what specifically (dish, cuisine, or the kind of place/tour)",
  where: "which town, area, or country",
  when: "the date and time",
  people: "how many people",
  budget: "his rough budget (skip if he doesn't care)",
  days: "how many days",
  interests: "what he's into (skip if not relevant)",
  goal: "what he wants out of the day",
  city: "which city or area",
  area: "which area or neighbourhood",
  from: "check-in date",
  to: "check-out date",
  month: "which month he's travelling",
  country: "which country",
};

app.post("/ask", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { skill, history, seed, lat, lng } = req.body || {};
  const recipe = SKILL_RECIPES[skill];
  if (!recipe) return res.status(400).json({ error: "unknown_skill", spoken: "I'm not set up to plan that one conversationally yet." });

  const turns = Array.isArray(history) ? history.slice(-10) : [];
  const prof = profileOf(uid) || {};
  const seedText = typeof seed === "string" ? seed : "";
  const past = recallFor(uid, `${skill} ${seedText}`, 4).map(m => `${when(m.at)}: ${m.t}`).join(" | ");

  const _tz = (typeof COUNTRY_TZ !== "undefined" && prof.country && COUNTRY_TZ[String(prof.country).toLowerCase()]) || "Australia/Brisbane";
  const known = [
    nowLine(uid, (lat != null ? { lat, lng } : null)),
    prof.city ? `He's based near ${prof.city}.` : "",
    prof.country ? `He's currently in ${prof.country}.` : "",
    prof.localCurrency ? `Local currency is ${prof.localCurrency}; his home currency is AUD.` : "",
  ].filter(Boolean).join(" ");

  const needList = recipe.need.map(s => `"${s}" (${SLOT_HINTS[s] || s}) — REQUIRED`).join("\n");
  const optList = recipe.opt.map(s => `"${s}" (${SLOT_HINTS[s] || s}) — optional`).join("\n");

  const sys =
    `You are Vision, ${prof.name || "Shaun"}'s warm travel companion, ${recipe.intro} through his glasses by voice. ` +
    "Collect what you need to act, asking ONE natural question at a time. " +
    "Do NOT ask for anything he's already told you, anything given as known context, or anything you can reasonably infer. " +
    "Optional slots: only ask if it would genuinely improve the result, and never more than once. " +
    "The moment you have every REQUIRED slot, stop asking and return ready. " +
    "Be adaptive — if the situation needs a smart follow-up the list didn't cover, ask it." +
    NO_INVENT + SPOKEN_PLAIN;

  const ctx =
    `Skill: ${skill}.\nRequired slots:\n${needList}\n${optList ? `Optional slots:\n${optList}\n` : ""}` +
    (known ? `\nKnown context (use, don't ask): ${known}` : "") +
    (past ? `\nRelevant memory: ${past}` : "") +
    (seedText ? `\nHe opened with: "${seedText}"` : "") +
    `\n\nConversation so far:\n` +
    (turns.length ? turns.map(t => `${t.who === "me" ? "Shaun" : "Vision"}: ${t.text}`).join("\n") : "(nothing yet)") +
    `\n\nReply as compact JSON ONLY (no markdown):\n` +
    `{"ready": true|false, ` +
    `"question": "the ONE next question, warm and spoken — empty if ready", ` +
    `"args": { each slot you've resolved, by its exact name above }, ` +
    `"spoken": "if ready, one warm line telling him what you're about to do"}`;

  try {
    const g = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: sys,
      messages: [{ role: "user", content: ctx }],
    });
    if (g.status !== 200) return res.status(200).json({ fallback: true, spoken: "I lost my thread there — say that again?" });
    const raw = (JSON.parse(g.text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { ready: false, question: raw }; }

    const args = p.args || {};
    const haveAll = recipe.need.every(s => args[s] != null && String(args[s]).trim() !== "");
    if (!p.ready || !haveAll) {
      const gap = recipe.need.find(s => args[s] == null || String(args[s]).trim() === "");
      const q = p.question || (gap ? `What ${gap === "timing" ? "time do you need to be there" : gap}?` : "Tell me a bit more?");
      return res.json({ phase: "ask", skill, question: q, spoken: q, args });
    }

    try {
      const mem = STORE.mem[uid] = STORE.mem[uid] || [];
      remember(uid, `ask/${skill}: ${Object.entries(args).map(([k, v]) => `${k}=${v}`).join(", ")}`, { kind: "ask", origin: "tool" });
      saveStore();
    } catch {}

    return res.json({ phase: "ready", skill, args, spoken: p.spoken || "On it." });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Something tangled up there — give me another go?" });
  }
});

// --- 🧭 GET ME THERE: the adaptive, conversational journey concierge ---------
// Not a route lookup — a back-and-forth that changes with WHY you're going.
// Airport → asks the flight, checks it, works backwards through customs/security
// buffers. Event/dinner → asks the booking time, arrives on time with a buffer.
// General → leave-now or arrive-by. Full multi-turn until it's nailed, then a
// complete spoken report + hands to Maps, and LOGS the trip so next time it
// leads with your usual (auto-learning).
//
// Body: { destination, originLat, originLng, history:[{who,text}], answer, reset }
//   Client re-sends the whole `history` each turn (stateless brain).
// Returns one of:
//   { phase:"ask", question, spoken, mode }                     — needs an answer
//   { phase:"plan", spoken, report{...}, mapsDest, mode, leaveBy } — ready, open Maps
//   { fallback:true, spoken }                                    — soft failure
//
// Airport buffers (his stated defaults): international 3h, domestic 1.5h before.
const AIRPORT_BUFFER = { international: 180, domestic: 90 }; // minutes before departure

function tripTypeOf(dest, history) {
  const d = (dest || "").toLowerCase();
  const all = (history || []).map(h => h.text).join(" ").toLowerCase() + " " + d;
  if (/airport|terminal|flight|departures|check.?in/.test(all)) return "airport";
  if (/dinner|reservation|booking|restaurant|table at|meet|meeting|show|concert|movie|game|match|appointment|wedding|party|event/.test(all)) return "event";
  return "general";
}

app.post("/getthere", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { destination, originLat, originLng, history, reset } = req.body || {};
  if (!destination) return res.status(400).json({ error: "destination required" });
  const mode = "transit"; // this tile is trains & buses; driving handled by Navigate

  STORE.trips = STORE.trips || {};
  const turns = Array.isArray(history) ? history.slice(-8) : [];
  const type = tripTypeOf(destination, turns);

  // What Vision already knows, so it doesn't ask what it can look up.
  const prof = profileOf(uid) || {};
  const past = recallFor(uid, `trip to ${destination}`, 5).map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const learned = (STORE.trips[uid] || []).filter(t => (t.dest || "").toLowerCase() === destination.toLowerCase()).slice(-3);
  const usual = learned.length ? learned[learned.length - 1] : null;

  // Airport mode can enrich itself from a saved flight before it even asks.
  let flightNote = "";
  if (type === "airport" && FLIGHT_KEY) {
    const savedIata = prof.flightIata || (turns.map(t => (t.text.match(/\b([A-Z]{2}\d{2,4})\b/) || [])[1]).filter(Boolean)[0]);
    if (savedIata) {
      try {
        const av = await aviationFetch({ access_key: FLIGHT_KEY, flight_iata: savedIata });
        const f = (av.json?.data || [])[0];
        if (f?.departure?.scheduled) {
          flightNote = `Saved flight ${savedIata} departs ${new Date(f.departure.scheduled).toLocaleString("en-AU")} from ${f.departure.airport || "the airport"}.`;
        }
      } catch {}
    }
  }

  // The brain decides: ask the next sharp question, OR (if it has enough) say
  // "ready" with the departure target. It never guesses a flight time or a
  // reservation it wasn't told; if unknown, it asks.
  const sys =
    "You are Vision, Shaun's travel concierge, planning ONE public-transport journey through his glasses, by voice. " +
    "Be adaptive: the questions depend on WHY he's going.\n" +
    "- AIRPORT: you must know his flight's departure time and whether it's international or domestic. " +
    `Then he must be AT the airport ${AIRPORT_BUFFER.international} min before an international flight or ${AIRPORT_BUFFER.domestic} min before a domestic one (his rule). ` +
    "If he has a checked bag or it's peak hour, mention it adds time. Work out the LATEST he can arrive at the airport, then he'll get the train that lands before it.\n" +
    "- EVENT/DINNER: you must know the time he needs to be there. Add a sensible 10-15 min arrival buffer.\n" +
    "- GENERAL: ask whether he wants to leave now or arrive by a certain time.\n" +
    "Ask ONE question at a time. Keep asking until you have a concrete TARGET ARRIVAL TIME (clock time today/tomorrow). " +
    "Don't re-ask what he's already told you or what's given below. When — and only when — you have a firm target arrival time, stop asking." +
    NO_INVENT + SPOKEN_PLAIN;

  const ctx =
    `Destination: ${destination}. Trip type: ${type}.` +
    `\n${nowLine(uid, (originLat != null ? { lat: originLat, lng: originLng } : null))} When he gives a flight or event time like "4pm", combine it with today's date (or tomorrow's if that time has already passed today) to compute the target arrival.` +
    (flightNote ? `\n${flightNote}` : "") +
    (usual ? `\nHis usual for this trip: ${usual.note || ""}${usual.leaveBy ? ` (last time he left by ${usual.leaveBy})` : ""}.` : "") +
    (past ? `\nRelevant memory: ${past}` : "") +
    (prof.city ? `\nHe's based near ${prof.city}.` : "") +
    `\n\nConversation so far:\n` +
    (turns.length ? turns.map(t => `${t.who === "me" ? "Shaun" : "Vision"}: ${t.text}`).join("\n") : "(nothing yet — this is the first turn)") +
    `\n\nReply as compact JSON ONLY (no markdown):\n` +
    `{"ready": true|false, ` +
    `"question": "the ONE next question to ask, spoken and warm — empty if ready", ` +
    `"targetArrival": "ISO 8601 clock time he must ARRIVE by, or empty if not ready", ` +
    `"advice": "short spoken advice for this trip type — check-in/security reminder for airport, buffer note for events — or empty", ` +
    `"why": "one short clause explaining the timing, e.g. so you clear security in time"}`;

  try {
    const g = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: sys,
      messages: [{ role: "user", content: ctx }],
    });
    if (g.status !== 200) return res.status(200).json({ fallback: true, spoken: "I lost my train of thought — say that again?" });
    const raw = (JSON.parse(g.text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { ready: false, question: raw }; }

    // STILL ASKING ------------------------------------------------------------
    if (!p.ready || !p.targetArrival) {
      return res.json({
        phase: "ask",
        mode: type,
        question: p.question || "When do you need to be there?",
        spoken: p.question || "When do you need to be there?",
        advice: p.advice || "",
      });
    }

    // READY — now do the real route maths against the target arrival time. -----
    // We need to leave such that we ARRIVE by targetArrival. Google transit
    // supports arrival_time, but our shared fetchRoute uses departure_time, so
    // we ask for "now" first to get trip duration, then compute leave-by.
    if (originLat == null || originLng == null) {
      return res.json({ phase: "ask", mode: type, question: "I need your location to time this — allow location and tell me again?", spoken: "I need your location to time this." });
    }
    const target = new Date(p.targetArrival);
    if (isNaN(target.getTime())) {
      // The brain gave a target we can't parse — ask once more rather than crash.
      return res.json({ phase: "ask", mode: type, question: "What time do you need to be there? A clock time like 2:30pm works best.", spoken: "What time do you need to be there?" });
    }
    const rr = await fetchRoute({ originLat, originLng, destination, mode, departAt: Date.now() });
    if (!rr.ok) {
      return res.status(200).json({ fallback: true, spoken: "I couldn't find a train route there just now — want me to open Maps so you can check?", mapsDest: destination, mode });
    }
    const r = rr.route;
    const durMin = Math.round((r.durationValue || 0) / 60) || 30;
    const leaveBy = new Date(target.getTime() - durMin * 60000);
    const leaveByTxt = leaveBy.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
    const targetTxt = target.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });

    // Build the full spoken report.
    const parts = [];
    parts.push(`To be there by ${targetTxt}, leave by about ${leaveByTxt} — it's roughly a ${r.durationText || durMin + " min"} trip.`);
    if (r.first) parts.push(`Catch the ${r.first.departs} ${r.first.kind}${r.first.line ? ` (${r.first.line})` : ""}${r.first.towards ? ` towards ${r.first.towards}` : ""} from ${r.first.from}.`);
    if (r.fare) parts.push(`Fare's about ${r.fare.text}.`);
    else if (r.rides.length) parts.push(`No fare from Google for this network — sort it at the gate.`);
    if (p.advice) parts.push(p.advice);
    if (p.why) parts.push(p.why.charAt(0).toUpperCase() + p.why.slice(1) + ".");
    const spoken = parts.join(" ");

    // LOG THE TRIP — durable memory + a learned pattern for next time.
    const tripLog = { dest: destination, type, at: Date.now(), target: p.targetArrival, leaveBy: leaveByTxt, note: `${type} trip to ${destination}, target ${targetTxt}` };
    STORE.trips[uid] = STORE.trips[uid] || [];
    STORE.trips[uid].push(tripLog);
    while (STORE.trips[uid].length > 40) STORE.trips[uid].shift();
    const mem = STORE.mem[uid] = STORE.mem[uid] || [];
    remember(uid, `getthere: ${type} trip to ${destination} — needed to arrive ${targetTxt}, left by ${leaveByTxt}`, { kind: "trip", origin: "tool" });
    saveStore();

    return res.json({
      phase: "plan",
      mode: type,
      spoken,
      report: {
        targetArrival: targetTxt, leaveBy: leaveByTxt,
        durationText: r.durationText, fare: r.fare, first: r.first,
        rides: r.rides, steps: r.steps.slice(0, 6), advice: p.advice || "", why: p.why || "",
      },
      mapsDest: destination, leaveBy: leaveByTxt,
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Something tangled up planning that — give me another go?" });
  }
});
// AviationStack free tier rejects HTTPS (paid feature) — try https first,
// fall back to plain http so a valid free key still works.
async function aviationFetch(params) {
  for (const scheme of ["https", "http"]) {
    try {
      const u = new URL(`${scheme}://api.aviationstack.com/v1/flights`);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      const r = await fetch(u);
      const j = await r.json().catch(() => null);
      // free-tier https rejection comes back as an error object, not a 200 list
      if (r.status === 200 && j && !j.error) return { ok: true, json: j };
      if (j && j.error && /https|access_restricted|function_access/i.test(JSON.stringify(j.error)) && scheme === "https") continue;
      return { ok: false, json: j, status: r.status };
    } catch (e) { if (scheme === "http") return { ok: false, error: String(e) }; }
  }
  return { ok: false };
}

// --- Maps depth helpers (batch 36) ---
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// Details (hours/phone/website) + one small photo for a place, attached in-place.
// Best-effort: any failure just leaves the place un-enriched.
async function enrichTopPlace(p) {
  if (!GMAPS_KEY || !p) return;
  try {
    if (p.placeId) {
      const du = new URL("https://maps.googleapis.com/maps/api/place/details/json");
      du.searchParams.set("place_id", p.placeId);
      du.searchParams.set("fields", "formatted_phone_number,website,opening_hours");
      du.searchParams.set("key", GMAPS_KEY);
      const dr = await fetch(du); const dd = await dr.json();
      if (dd.status === "OK" && dd.result) {
        p.phone = dd.result.formatted_phone_number || null;
        p.website = dd.result.website || null;
        const today = new Date().getDay(); // JS: 0=Sun; Google weekday_text: 0=Mon
        const wt = dd.result.opening_hours?.weekday_text;
        if (wt && wt.length === 7) p.hoursToday = wt[(today + 6) % 7] || null;
      }
    }
    if (p.photoRef) {
      const pu = new URL("https://maps.googleapis.com/maps/api/place/photo");
      pu.searchParams.set("maxwidth", "400");
      pu.searchParams.set("photo_reference", p.photoRef);
      pu.searchParams.set("key", GMAPS_KEY);
      const pr = await fetch(pu);
      if (pr.ok) {
        const buf = Buffer.from(await pr.arrayBuffer());
        if (buf.length < 300000) {
          const mime = pr.headers.get("content-type") || "image/jpeg";
          p.photo = `data:${mime};base64,${buf.toString("base64")}`;
        }
      }
    }
  } catch { /* enrichment is a bonus, never a blocker */ }
  delete p.photoRef;
}

app.post("/places", requireAuth, async (req, res) => {
  if (!GMAPS_KEY) {
    return res.status(501).json({ error: "google_places_disabled",
      hint: "Set GOOGLE_MAPS_API_KEY (same key as Directions works if Places API is enabled)." });
  }
  const { lat, lng, query, type, radius } = req.body || {};
  if (lat == null || lng == null) {
    return res.status(400).json({ error: "lat and lng required" });
  }
  const r = radius || 1500;

  let url;
  if (query) {
    // Text search: best for "find me X" spoken queries.
    url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
    url.searchParams.set("query", query);
    url.searchParams.set("location", `${lat},${lng}`);
    url.searchParams.set("radius", String(r));
  } else {
    // Nearby search: best for "what's around me" / a type filter.
    url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
    url.searchParams.set("location", `${lat},${lng}`);
    url.searchParams.set("radius", String(r));
    if (type) url.searchParams.set("type", type);
  }
  url.searchParams.set("key", GMAPS_KEY);

  try {
    const gr = await fetch(url);
    const data = await gr.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "places_failed" });
    }
    const places = (data.results || []).slice(0, 8).map((p) => ({
      name: p.name,
      address: p.formatted_address || p.vicinity || "",
      lat: p.geometry?.location?.lat,
      lng: p.geometry?.location?.lng,
      rating: p.rating ?? null,
      openNow: p.opening_hours?.open_now ?? null,
      types: p.types || [],
      placeId: p.place_id,
      photoRef: p.photos?.[0]?.photo_reference || null,
    }));
    // MAPS DEPTH: straight-line distance + walk estimate. Free (no Distance
    // Matrix billing) and honest enough for "about 4 min away".
    for (const p of places) {
      if (p.lat != null && lat != null) {
        p.distanceM = Math.round(haversineM(lat, lng, p.lat, p.lng));
        p.walkMin = Math.max(1, Math.round(p.distanceM / 80));
      }
    }

    // Concierge layer: let Vision recommend, not just list. style: "pick" | "list" | "auto"
    const style = (req.body || {}).recommend || "auto";
    if (style === "none" || places.length === 0) {
      return res.json({ places, recommendation: places.length ? "" : "I couldn't find anything matching nearby, Shaun." });
    }
    // Rank client-side first (open now + rating), so Vision reasons over the best few.
    const ranked = [...places].sort((a, b) =>
      (Number(b.openNow) - Number(a.openNow)) || ((b.rating || 0) - (a.rating || 0)));
    const top = ranked.slice(0, 5).map(p =>
      `${p.name}${p.rating ? ` (${p.rating}★)` : ""}${p.openNow === false ? " [closed now]" : p.openNow ? " [open]" : ""}${p.walkMin ? ` [~${p.walkMin} min walk]` : ""} — ${p.address}`
    ).join("\n");
    const wants = style === "list"
      ? "Give Shaun a SHORT ranked shortlist (top 3), one line each, warm and spoken. End by offering directions to his pick."
      : style === "pick"
      ? "Recommend the single BEST option for Shaun in one or two warm spoken sentences (favour open-now and higher rating), then offer directions."
      : "If one option clearly stands out, recommend just that one warmly and offer directions. If it's close, give a quick top-3. Spoken style, short, no markdown.";
    try {
      const rec = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 220,
        system: "You are Vision, Shaun's warm companion in his glasses. Recommend places like a helpful local friend — never a raw list dump." + NO_INVENT_STRICT + ANSWER_FIRST,
        messages: [{ role: "user", content: `${wants}\n\nNearby options:\n${top}` }],
      });
      let recommendation = "";
      if (rec.status === 200) {
        const j = JSON.parse(rec.text);
        recommendation = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
      }
      // MAPS DEPTH: enrich the top pick with details (hours today, phone,
      // website) and one photo — proxied server-side so the key stays here.
      if (ranked[0]) await enrichTopPlace(ranked[0]);
      return res.json({ places: ranked, recommendation });
    } catch {
      return res.json({ places: ranked, recommendation: "" });
    }
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: String(e && e.message || e).slice(0, 140) });
  }
});

// --- Flight status: gate, terminal, delay, status (AviationStack) ---
// Body: { flightIata }  e.g. "BA292"
// Returns: { found, airline, status, depAirport, depGate, depTerminal,
//            depScheduled, depEstimated, delayMin, arrAirport, arrGate, arrTerminal }
app.post("/flight", requireAuth, async (req, res) => {
  if (!FLIGHT_KEY) {
    return res.status(501).json({ error: "flight_api_disabled",
      hint: "Set AVIATIONSTACK_KEY to enable flight tracking." });
  }
  const { flightIata } = req.body || {};
  if (!flightIata) return res.status(400).json({ error: "flightIata required" });

  try {
    const av = await aviationFetch({ access_key: FLIGHT_KEY, flight_iata: flightIata });
    const data = av.json || {};
    const f = (data.data || [])[0];
    if (!f) return res.json({ found: false, spoken: "I couldn't find that flight, Shaun — double-check the number?" });

    const info = {
      found: true,
      airline: f.airline?.name || "",
      status: f.flight_status || "",            // scheduled/active/landed/cancelled/diverted
      depAirport: f.departure?.airport || "",
      depGate: f.departure?.gate || null,
      depTerminal: f.departure?.terminal || null,
      depScheduled: f.departure?.scheduled || null,
      depEstimated: f.departure?.estimated || null,
      delayMin: f.departure?.delay || 0,
      arrAirport: f.arrival?.airport || "",
      arrGate: f.arrival?.gate || null,
      arrTerminal: f.arrival?.terminal || null,
      arrBaggage: f.arrival?.baggage || null,
    };
    // Vision's plain spoken status line.
    const bits = [];
    if (info.status) bits.push(info.status);
    if (info.delayMin > 0) bits.push(`delayed about ${info.delayMin} min`);
    if (info.depGate) bits.push(`gate ${info.depGate}`);
    if (info.depTerminal) bits.push(`terminal ${info.depTerminal}`);
    info.spoken = `${info.airline || "Your flight"} ${flightIata}: ${bits.join(", ") || "no live details yet"}.` +
      (info.arrBaggage ? ` Baggage at ${info.arrBaggage}.` : "");
    res.json(info);
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: String(e && e.message || e).slice(0, 140) });
  }
});

// --- Health: does the backend work, and can it reach each external API? ---
// GET /health  -> { ok, checks: { anthropic, google, flight, weather, currency } }
// Auth required so it can actually test the keyed upstreams.
// --- 🏨 STAY: find accommodation via Places lodging + Vision's pick ---
// Body: { lat?, lng?, area?, what? }  (area = "Ubud" etc when not using GPS)
// Returns { spoken, places:[{name,address,rating,priceLevel,openNow}], bookLink }
// HONEST LIMIT: live nightly rates need Google Hotels (paid scrapers only) —
// so we shortlist + rate here, and deep-link out to book.
app.post("/stay", requireAuth, async (req, res) => {
  // Batch 111 audit: this gives personalised ADVICE but was running blind.
  // Pull where he has stayed before and what he liked or disliked about it.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if it genuinely helps; never list it back): ${_mem}` : "";
  if (!GMAPS_KEY) return res.status(501).json({ error: "google_places_disabled" });
  const { lat, lng, area, what } = req.body || {};
  const q = `${what || "hotels"} in ${area || "this area"}`;
  const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", area ? q : (what || "hotels"));
  if (lat != null && lng != null) { url.searchParams.set("location", `${lat},${lng}`); url.searchParams.set("radius", "4000"); }
  url.searchParams.set("type", "lodging");
  url.searchParams.set("key", GMAPS_KEY);
  try {
    const gr = await fetch(url); const data = await gr.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS")
      return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "places_failed" });
    const places = (data.results || [])
      .filter(p => p.rating).sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 6)
      .map(p => ({ name: p.name, address: p.formatted_address || p.vicinity || "",
        rating: p.rating ?? null, priceLevel: p.price_level ?? null,
        openNow: p.opening_hours?.open_now ?? null }));
    let spoken = "I couldn't find places to stay there — try naming the area.";
    if (places.length) {
      const body = {
        model: "claude-haiku-4-5-20251001", max_tokens: 200,
        system: "You are Vision, a warm travel companion. Given hotel options, recommend ONE in 2 short spoken sentences (why it stands out), mention a runner-up by name. No lists, no markdown." + NO_INVENT_STRICT + ANSWER_FIRST +
      _memNote + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
        messages: [{ role: "user", content: JSON.stringify(places) }],
      };
      const { status, text } = await callClaude(body);
      if (status === 200) { try { spoken = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim() || spoken; } catch {} }
    }
    const where = area || (places[0] ? places[0].address.split(",").slice(-2).join(",").trim() : "");
    const bookLink = "https://www.booking.com/searchresults.html?ss=" + encodeURIComponent(where || "hotels");
    res.json({ spoken, places, bookLink });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "stay: " + String(e && e.message || e).slice(0, 140) }); }
});

// --- 🎟️ ACTIVITIES: things to do, live via web search ---
// Body: { city?, country?, interests? }  Returns { spoken, items:[..] }
app.post("/activities", requireAuth, async (req, res) => {
  // Batch 66: this endpoint gives ADVICE, so it should know him. Pull the
  // memories relevant to what he might enjoy doing and let the model use them.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if relevant): ${_mem}` : "";
  const { city, country, interests } = req.body || {};
  const where = [city, country].filter(Boolean).join(", ") || "the area Shaun is in";
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 500,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    system: "You are Vision, a warm travel companion speaking aloud. Suggest 4-5 genuinely good things to do — current, specific, not tourist-trap filler. Use web search if it helps (events, seasonal). Reply as JSON only: {\"spoken\": \"2-3 sentence pick of the best one or two\", \"items\": [\"short line each\"]}. No markdown." + NO_INVENT_STRICT + ANSWER_FIRST + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{ role: "user", content: `Things to do in ${where}${interests ? " — he's into " + interests : ""}.${_memNote}` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "activities_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300), items: [] }; }
    res.json({ spoken: p.spoken || "", items: Array.isArray(p.items) ? p.items.slice(0, 6) : [] });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "activities: " + String(e && e.message || e).slice(0, 140) }); }
});

// --- 🗺️ TRIPPLAN: multi-day itinerary, returned structured so the app can SAVE it ---
// Body: { destination, days?, budget?, currency?, interests? }
// Returns { spoken, plan: { destination, days: [{ day, title, items: [{when, what}] }] } }
app.post("/tripplan", requireAuth, async (req, res) => {
  const { destination, days, budget, currency, interests } = req.body || {};
  if (!destination) return res.status(400).json({ error: "destination required" });
  const nDays = Math.min(Math.max(Number(days) || 3, 1), 14);
  const body = {
    model: "claude-sonnet-4-6", max_tokens: 1500,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    system: "You are Vision, a sharp travel planner. Build a realistic day-by-day plan — geographically sensible (cluster nearby things), paced like a human (not 12 stops a day), with real place names. Web-search if current info helps. Reply as JSON ONLY: {\"spoken\": \"2-3 sentences selling the shape of the trip\", \"days\": [{\"day\": 1, \"title\": \"...\", \"items\": [{\"when\": \"morning|afternoon|evening\", \"what\": \"short line\"}]}]}. No markdown." + NO_INVENT_STRICT + ANSWER_FIRST + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{ role: "user", content: `${nDays}-day plan for ${destination}.${budget ? ` Budget ${budget} ${currency || ""}/day.` : ""}${interests ? ` Into: ${interests}.` : ""}` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "tripplan_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "tripplan_parse" }); }
    res.json({ spoken: p.spoken || "", plan: { destination, days: Array.isArray(p.days) ? p.days.slice(0, nDays) : [] } });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "tripplan: " + String(e && e.message || e).slice(0, 140) }); }
});

// --- 🎒 PACKLIST ---  Body: { destination, days?, month? }  Returns { spoken, items }
app.post("/packlist", requireAuth, async (req, res) => {
  // Batch 66: this endpoint gives ADVICE, so it should know him. Pull the
  // memories relevant to what to pack and let the model use them.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if relevant): ${_mem}` : "";
  const { destination, days, month } = req.body || {};
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 450,
    system: "You are Vision. Build a tight packing list for the trip — climate-aware, no obvious filler (\"clothes\"), include the things people forget (adapters, meds, offline maps). JSON only: {\"spoken\": \"1-2 sentences with the non-obvious highlights\", \"items\": [\"item — why, only when not obvious\"]}. Max 15 items." + SPOKEN_PLAIN + ANSWER_FIRST +
      NO_INVENT_STRICT + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{ role: "user", content: `Packing for ${destination || "a trip"}${days ? `, ${days} days` : ""}${month ? `, in ${month}` : ""}. He's travelling from Australia.${_memNote}` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "packlist_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 200), items: [] }; }
    res.json({ spoken: p.spoken || "", items: Array.isArray(p.items) ? p.items.slice(0, 15) : [] });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "packlist: " + String(e && e.message || e).slice(0, 140) }); }
});

// --- 💵 TRIPBUDGET: what will it cost, live-informed ---
// Body: { destination, days?, style? }  Returns { spoken, perDay, total, currency }
app.post("/tripbudget", requireAuth, async (req, res) => {
  // Batch 66: this endpoint gives ADVICE, so it should know him. Pull the
  // memories relevant to trip costs and let the model use them.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if relevant): ${_mem}` : "";
  const { destination, days, style } = req.body || {};
  if (!destination) return res.status(400).json({ error: "destination required" });
  const nDays = Number(days) || 7;
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 400,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    system: "You are Vision, honest about money. Estimate a realistic daily budget for the trip in AUD (his home currency) — food, transport, activities, drinks; note what accommodation adds separately. Web-search current prices if useful. JSON only: {\"spoken\": \"2-3 plain sentences with the daily number and what swings it\", \"perDay\": <number AUD>, \"total\": <number AUD>, \"currency\": \"AUD\"}." + SPOKEN_PLAIN +
      NO_INVENT_STRICT + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{ role: "user", content: `${nDays} days in ${destination}, ${style || "mid-range"} style.${_memNote}` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "tripbudget_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300) }; }
    res.json({ spoken: p.spoken || "", perDay: p.perDay ?? null, total: p.total ?? null, currency: p.currency || "AUD" });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "tripbudget: " + String(e && e.message || e).slice(0, 140) }); }
});

// --- 📶 ESIM: data options for a country, live ---
// Body: { country }  Returns { spoken, options }
app.post("/esim", requireAuth, async (req, res) => {
  // Batch 66: this endpoint gives ADVICE, so it should know him. Pull the
  // memories relevant to data/SIM options and let the model use them.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if relevant): ${_mem}` : "";
  const { country } = req.body || {};
  if (!country) return res.status(400).json({ error: "country required" });
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 450,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    system: "You are Vision, practical about phone data abroad. For the country given: best eSIM options for an Australian traveller (e.g. Airalo/Holafly/local telco), rough current prices, and whether a local physical SIM at the airport beats them. Web-search for current pricing. JSON only: {\"spoken\": \"2-3 sentences with your actual pick\", \"options\": [\"short line each\"]}." + SPOKEN_PLAIN + ANSWER_FIRST +
      NO_INVENT_STRICT + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{ role: "user", content: `Data/eSIM for ${country}.${_memNote}` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "esim_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300), options: [] }; }
    res.json({ spoken: p.spoken || "", options: Array.isArray(p.options) ? p.options.slice(0, 5) : [] });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "esim: " + String(e && e.message || e).slice(0, 140) }); }
});

app.get("/health", requireAuth, async (req, res) => {
  const checks = {};
  const time = async (label, fn) => {
    const t0 = Date.now();
    try { checks[label] = { ok: await fn(), ms: Date.now() - t0 }; }
    catch (e) { checks[label] = { ok: false, ms: Date.now() - t0, error: String(e) }; }
  };

  await Promise.all([
    // Anthropic: a 1-token ping proves the key + connectivity.
    time("anthropic", async () => {
      const r = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      return r.status === 200;
    }),
    time("google", async () => {
      if (!GMAPS_KEY) return null; // not configured
      const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      u.searchParams.set("address", "London"); u.searchParams.set("key", GMAPS_KEY);
      const r = await fetch(u); const j = await r.json();
      return j.status === "OK";
    }),
    time("flight", async () => {
      if (!FLIGHT_KEY) return null;
      const av = await aviationFetch({ access_key: FLIGHT_KEY, limit: "1" });
      return av.ok;
    }),
    time("weather", async () => {
      // Open-Meteo needs no key; proves outbound network for weather.
      const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.1&current=temperature_2m");
      return r.status === 200;
    }),
    time("currency", async () => {
      const r = await fetch("https://api.frankfurter.app/latest?from=EUR&to=USD");
      return r.status === 200;
    }),
    time("mail", async () => {
      if (!mailReady()) return null; // not configured
      // Prove IMAP auth works without pulling messages.
      return await withInbox(async () => true);
    }),
  ]);

  for (const [k, c] of Object.entries(checks)) {
    dlog(uidOf(req), c.ok === false ? "errors" : "services", `${k}: ${c.ok === false ? "DOWN" : c.ok === null ? "not set up" : "up"} ${c.ms || 0}ms`);
  }
  const ok = Object.values(checks).every(c => c.ok !== false);
  // Batch 58: memory storage indicator — store size + disk free + durability.
  let storage = { durable: DURABLE };
  try { storage.storeKB = Math.round((require("fs").statSync(STORE_FILE).size || 0) / 1024 * 10) / 10; } catch { storage.storeKB = 0; }
  storage.saveFails = _saveFails;
  storage.lastSaveOk = _lastSaveOk || null;
  // Batch 137 audit: a corrupt store used to look identical to a first run —
  // he'd find Vision had forgotten him with no way to tell why. Say which
  // happened, in words Status can put on screen.
  storage.loadState = _loadState;
  storage.loadNote =
    _loadState === "recovered" ? "The main memory file was unreadable — recovered from the backup. Nothing lost that had been saved."
    : _loadState === "corrupt" ? "Memory was unreadable and there was no backup, so Vision started fresh. The damaged file was kept."
    : _loadState === "fresh" ? "No memory file yet — this is a fresh start."
    : "";
  try { storage.hasBackup = require("fs").existsSync(STORE_BAK); } catch { storage.hasBackup = false; }
  try { const sf = require("fs").statfsSync(DATA_DIR); storage.diskFreeMB = Math.round(sf.bavail * sf.bsize / 1048576); } catch {}
  res.json({ ok, checkedAt: new Date().toISOString(), checks, storage });
});

// --- Weather: current + short forecast (Open-Meteo, no key) ---
// Body: { lat, lng }
/* Batch 157: weather only ever answered "here, now". He asks about Da Nang
 * tomorrow, or Lombok when he gets there — both perfectly reasonable, neither
 * of which the endpoint could do. Geocoding a named place is one extra call
 * and turns one question into three. */
/* --- RESOLVING A VAGUE PLACE (batch 159) ------------------------------------
 * "The local beach" is not a place — it's a description. His own coordinates
 * are the wrong answer, because he's asking about somewhere he ISN'T yet.
 *
 * The failure is quiet: marine data for an inland point returns nulls, so he
 * gets "no data" rather than the beach conditions, and nothing explains why.
 *
 * So: one resolver, used by everything that needs real coordinates. Saved
 * places first (he told us where his gym is), then a search near him. And it
 * always reports WHAT it resolved to, so the answer can name the guess —
 * "Coolum's flat this morning" rather than an unexplained forecast.
 * ------------------------------------------------------------------------ */

// Phrasings that describe a kind of place rather than name one. These are the
// ones where using his own position silently gives the wrong answer.
const VAGUE_PLACE = /\b(the |a |my |nearest |closest |local |nearby |round here|around here)\b/i;
const KIND_WORDS = /\b(beach|surf|coast|shore|servo|petrol|gas station|chemist|pharmacy|supermarket|shop|store|market|cafe|coffee|restaurant|pub|bar|gym|atm|bank|hospital|clinic|park|station)\b/i;

function looksVague(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (!KIND_WORDS.test(t)) return false;          // not a kind of place at all

  // A hedge word settles it: "the local beach", "nearest chemist".
  if (VAGUE_PLACE.test(t)) {
    // ...unless a proper name follows it — "the Coolum Beach surf club".
    const words = t.split(/\s+/).filter(w => !VAGUE_PLACE.test(w));
    const named = words.some(w => /^[A-Z][a-z]{2,}$/.test(w) && !KIND_WORDS.test(w));
    return !named;
  }

  // No hedge. A capitalised word that isn't the kind-word is a name —
  // "Coolum Beach", "Bondi Beach", "Woolworths Caboolture".
  const hasName = t.split(/\s+/).some(w => /^[A-Z][a-z]{2,}$/.test(w) && !KIND_WORDS.test(w));
  if (hasName) return false;

  // Bare kind-word on its own: "beach", "chemist".
  return t.split(/\s+/).length <= 2;
}

/* Returns { lat, lng, name, resolved } — resolved true when it had to pick
 * something, which is the signal to name it in the answer. */
async function resolvePlaceFor(uid, { text, lat, lng } = {}) {
  const t = String(text || "").trim();

  // Nothing to resolve — he gave a real name, so geocode it directly.
  if (t && !looksVague(t)) {
    const geo = await placeToCoords(t);
    if (geo) return { ...geo, resolved: false };
  }

  // A saved place beats a search every time — he told us where it is.
  if (t) {
    const key = t.toLowerCase().replace(/^(my|the)\s+/, "").trim();
    const saved = (STORE.profiles[uid] || {}).places || {};
    if (saved[key]) {
      const geo = await placeToCoords(saved[key].address || saved[key]);
      if (geo) return { ...geo, name: key, resolved: false };
    }
  }

  // Vague, and we know where he is: find the real thing near him.
  if (t && lat != null && lng != null && GMAPS_KEY) {
    try {
      const u = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
      u.searchParams.set("query", t);
      u.searchParams.set("location", `${lat},${lng}`);
      u.searchParams.set("radius", "30000");
      u.searchParams.set("key", GMAPS_KEY);
      const r = await fetch(u);
      const j = await r.json();
      const hit = j.results?.[0];
      if (hit) {
        return {
          lat: hit.geometry.location.lat,
          lng: hit.geometry.location.lng,
          name: hit.name || hit.formatted_address,
          // It picked something he didn't name — say so in the answer.
          resolved: true,
        };
      }
    } catch {}
  }

  // Fall back to where he is, and be honest that nothing was resolved.
  if (lat != null && lng != null) return { lat, lng, name: "", resolved: false };
  return null;
}

async function placeToCoords(place) {
  if (!place || !GMAPS_KEY) return null;
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    u.searchParams.set("address", String(place).slice(0, 120));
    u.searchParams.set("key", GMAPS_KEY);
    const r = await fetch(u);
    const j = await r.json();
    const hit = j.results?.[0];
    if (!hit) return null;
    return {
      lat: hit.geometry.location.lat,
      lng: hit.geometry.location.lng,
      name: hit.address_components?.[0]?.long_name || hit.formatted_address,
    };
  } catch { return null; }
}

/* Batch 158: marine conditions from Open-Meteo's Marine API — same provider,
 * no key. Swell, wind waves and sea temperature, which is what actually
 * decides whether a swim or a dive is on.
 *
 * NOT included, deliberately:
 *   TIDES      Open-Meteo has none, and the paid alternatives want a monthly
 *              fee for something he can read off a free app. Saying "check the
 *              tide app" beats inventing a number.
 *   VISIBILITY No API gives this reliably — it's local and day to day. The
 *              dive shop knows; a model guessing does not.
 */
async function marineFor(lat, lng, daysOut) {
  try {
    const u = new URL("https://marine-api.open-meteo.com/v1/marine");
    u.searchParams.set("latitude", String(lat));
    u.searchParams.set("longitude", String(lng));
    u.searchParams.set("daily", "wave_height_max,wave_direction_dominant,wave_period_max,swell_wave_height_max,swell_wave_period_max,swell_wave_direction_dominant");
    u.searchParams.set("current", "wave_height,sea_surface_temperature,swell_wave_height,swell_wave_period");
    u.searchParams.set("forecast_days", String(Math.max(2, Math.min(8, (daysOut || 0) + 2))));
    u.searchParams.set("timezone", "auto");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(u, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    // Inland coordinates return nulls rather than an error — treat that as
    // "no marine data" rather than reporting a zero-metre swell.
    const d = j.daily || {}, c = j.current || {};
    const wave = d.wave_height_max?.[daysOut];
    if (wave == null && c.wave_height == null) return null;
    return {
      waveM: wave ?? c.wave_height,
      swellM: d.swell_wave_height_max?.[daysOut] ?? c.swell_wave_height,
      swellPeriodS: d.swell_wave_period_max?.[daysOut] ?? c.swell_wave_period,
      swellFrom: compassFromDegrees(d.swell_wave_direction_dominant?.[daysOut]),
      waveFrom: compassFromDegrees(d.wave_direction_dominant?.[daysOut]),
      seaTempC: c.sea_surface_temperature ?? null,
    };
  } catch { return null; }
}

// "South-east" is what he'd say. 157 degrees is not.
function compassFromDegrees(deg) {
  if (deg == null) return "";
  const pts = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return pts[Math.round(((deg % 360) / 45)) % 8];
}

// Is he asking about the water? Only then is any of this worth fetching.
function wantsMarine(said) {
  return /\b(swim|swimming|surf|surfing|beach|dive|diving|snorkel|snorkelling|snorkeling|boat|sail|sailing|kayak|paddle|fish|fishing|swell|waves?|tide|ocean|sea|water)\b/i
    .test(String(said || ""));
}

app.post("/weather", requireAuth, async (req, res) => {
  let { lat, lng, place, day, onArrival, said } = req.body || {};
  let placeName = "";

  // Batch 159: "the local beach" used to fall through to his own coordinates —
  // which are 5km inland, so the marine API returned nulls and he got "no
  // data" instead of the beach conditions. The resolver turns a description
  // into a real place first, and says which one it picked.
  let resolvedGuess = false;
  if (place) {
    const geo = await resolvePlaceFor(uidOf(req), { text: place, lat, lng });
    if (!geo) {
      return res.status(200).json({ fallback: true, spoken: `I couldn't find ${place} — try the town or city name?` });
    }
    lat = geo.lat; lng = geo.lng; placeName = geo.name || place;
    resolvedGuess = !!geo.resolved;
  }
  if (lat == null || lng == null) return res.status(400).json({ error: "lat,lng or place required" });

  // How many days out does he need? Open-Meteo is honest past about 14 —
  // beyond that it's climate, not forecast, and belongs in /season.
  const daysOut = Math.max(0, Math.min(14, Number(day) || 0));
  const forecastDays = Math.max(2, Math.min(16, daysOut + 2));

  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lng));
  u.searchParams.set("current", "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m");
  u.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,uv_index_max");
  u.searchParams.set("forecast_days", String(forecastDays));
  u.searchParams.set("timezone", "auto");
  try {
    // Only fetch marine data when he's actually asking about the water —
    // a swell reading on a chemist trip is noise, and it's a second call.
    const marineWanted = wantsMarine(said);
    const [r, marine] = await Promise.all([
      fetch(u),
      marineWanted ? marineFor(lat, lng, daysOut) : Promise.resolve(null),
    ]);
    const data = await r.json();
    // Vision's warm spoken forecast + a practical tip.
    let spoken = "";
    try {
      const c = data.current || {}, d = data.daily || {};
      // Which day is he actually asking about? "Now" only makes sense for
      // today and here — for Da Nang tomorrow, the current reading is noise.
      const when = daysOut === 0 ? "today" : daysOut === 1 ? "tomorrow" : `in ${daysOut} days`;
      const where = placeName || "where he is";
      const i = daysOut;

      const facts = (daysOut === 0
          ? `Right now: ${c.temperature_2m}°C (feels ${c.apparent_temperature}°), wind ${c.wind_speed_10m} km/h, precip ${c.precipitation}mm, code ${c.weather_code}. `
          : "")
        + `${when.charAt(0).toUpperCase() + when.slice(1)} in ${where}: `
        + `high ${d.temperature_2m_max?.[i]}° low ${d.temperature_2m_min?.[i]}°, `
        + `rain chance ${d.precipitation_probability_max?.[i]}%, code ${d.weather_code?.[i]}`
        + (d.uv_index_max?.[i] != null ? `, UV ${d.uv_index_max[i]}` : "") + ".";

      // The marine numbers only mean something turned into a verdict. "Swell's
      // up, 1.8 metres" tells him whether to bother; "significant wave height
      // 1.8m, period 11s, direction 157 degrees" does not.
      const marineFacts = marine
        ? `\nWater: ${marine.waveM != null ? `waves ${marine.waveM}m` : ""}` +
          `${marine.swellM != null ? `, swell ${marine.swellM}m` : ""}` +
          `${marine.swellPeriodS != null ? ` at ${marine.swellPeriodS}s` : ""}` +
          `${marine.swellFrom ? ` from the ${marine.swellFrom}` : ""}` +
          `${marine.seaTempC != null ? `, sea ${Math.round(marine.seaTempC)}°C` : ""}.`
        : "";

      const g = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 170,
        system: "You are Vision in Shaun's glasses. Say the weather like a friend — one or two spoken sentences, plain temps, and ONE practical tip (jacket, umbrella, sunscreen, wind) when it's actually warranted. " +
          "Say the place and the day when he asked about somewhere other than here, so he knows you understood. " +
          (resolvedGuess
            ? `He described a kind of place rather than naming one, and you picked ${placeName}. Name it in your answer — ` +
              `"Coolum's flat this morning" — so he can correct you if that's the wrong one. Do not ask; just say which. `
            : "") +
          "No numbers-soup." +
          (marineFacts
            ? " He's asking about the water, so give him the VERDICT first — is it a good day for it — and only then a number or two. " +
              "Under half a metre is flat and easy. Around a metre is fine for a strong swimmer, choppy for anyone else. " +
              "Over 1.5 metres is not a swimming day, and say so plainly. A long swell period means clean surf rather than chop. " +
              "Never guess at water clarity or tides — you do not have that data. If he asks, tell him the dive shop or a tide app will know."
            : "") +
          NO_INVENT + ANSWER_FIRST + SPOKEN_PLAIN,
        messages: [{ role: "user", content: `Give Shaun the weather from this data:\n${facts}${marineFacts}` }],
      });
      if (g.status === 200) { const j = JSON.parse(g.text);
        spoken = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim(); }
    } catch {}
    // A fallback with the actual numbers in it — if the model call fails he
    // still gets the answer, just less warmly phrased.
    const dd = data.daily || {};
    const plain = daysOut === 0
      ? `${Math.round(data.current?.temperature_2m)}° right now${placeName ? ` in ${placeName}` : ""}` +
        `, high ${Math.round(dd.temperature_2m_max?.[0])}°` +
        (dd.precipitation_probability_max?.[0] > 20 ? `, ${dd.precipitation_probability_max[0]}% chance of rain` : "") + "."
      : `${placeName || "There"} ${daysOut === 1 ? "tomorrow" : `in ${daysOut} days`}: ` +
        `${Math.round(dd.temperature_2m_min?.[daysOut])}° to ${Math.round(dd.temperature_2m_max?.[daysOut])}°` +
        (dd.precipitation_probability_max?.[daysOut] > 20 ? `, ${dd.precipitation_probability_max[daysOut]}% chance of rain` : ", looking dry") + ".";

    res.json({
      raw: data,
      marine,
      place: placeName,
      day: daysOut,
      rainChance: dd.precipitation_probability_max?.[daysOut] ?? null,
      high: dd.temperature_2m_max?.[daysOut] ?? null,
      low: dd.temperature_2m_min?.[daysOut] ?? null,
      spoken: spoken || plain,
    });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — try me again in a moment.", detail: String(e && e.message || e).slice(0, 160) }); }
});

/* --- SEASONS (batch 157) ----------------------------------------------------
 * "Is it typhoon season?" and "can I swim in Lombok in March?" are not
 * forecast questions — no API goes out three months, and pretending otherwise
 * would be the worst kind of confident. They're climate: patterns the model
 * genuinely knows.
 *
 * Which makes this the highest-risk endpoint in the system for invention. He
 * would book a flight around "typhoon season ends mid-October". So it is
 * guarded harder than anything else: describe the PATTERN, never assert exact
 * dates, and say plainly that it shifts year to year and wants checking closer
 * to the time.
 * ------------------------------------------------------------------------ */
app.post("/season", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { place, when, activity } = req.body || {};
  const prof = profileOf(uid) || {};
  let where = place || prof.city || prof.country || "";
  if (!where) return res.status(400).json({ error: "place required", spoken: "Where are you asking about?" });
  // Batch 159: a description like "the local beach" would have gone to the
  // model as a literal string. Resolve it to a real place first, same as
  // weather does, so the answer is about somewhere that exists.
  if (looksVague(where)) {
    const geo = await resolvePlaceFor(uid, { text: where, lat: req.body?.lat, lng: req.body?.lng });
    if (geo && geo.name) where = geo.name;
  }

  // If he's asked about somewhere he's actually going, use his real dates
  // rather than making him repeat them.
  let dates = "";
  try {
    const bookings = (STORE.bookings || {})[uid] || [];
    const match = bookings.find(b => String(b.what || "").toLowerCase().includes(String(where).toLowerCase()));
    if (match && match.whenISO) dates = ` He arrives around ${new Date(match.whenISO).toDateString()}.`;
  } catch {}

  const mem = recallFor(uid, `${where} ${activity || ""}`, 3).map(m => m.t).join(" | ");

  try {
    const { status, text } = await callClaude({
      model: "claude-sonnet-4-6",
      max_tokens: 420,
      system:
        "He is asking about the SEASON somewhere, not the forecast — this is beyond any forecast, so answer from what you " +
        "know about the climate there. " +
        "THE ONE RULE: never state exact dates as fact. Seasons shift by weeks year to year, and he will book flights " +
        "around what you say. Say 'usually', 'around', 'tends to' — and say plainly that it moves and wants checking " +
        "closer to the time. " +
        "Answer what he actually asked: if he wants to swim, talk about the water, the swell and anything that stings, " +
        "not the average rainfall. If he asks about typhoons or the wet season, say when it usually runs and what it " +
        "actually means day to day — most 'wet season' is an afternoon downpour, not a washout, and saying so is more " +
        "useful than a warning. " +
        "If a month is genuinely a bad idea, say so plainly rather than hedging." +
        NO_INVENT_STRICT + ANSWER_FIRST + SPOKEN_PLAIN + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
      messages: [{ role: "user", content:
        `Where: ${where}${when ? `\nWhen: ${when}` : ""}${activity ? `\nHe wants to: ${activity}` : ""}${dates}` +
        (mem ? `\n\nWhat you remember about how he travels: ${mem}` : "") +
        `\n\nReply as compact JSON ONLY: ` +
        `"spoken" (two or three sentences he can hear — the answer first), ` +
        `"season" (short name of what's on then, e.g. "tail of the wet season"), ` +
        `"watchFor" (array of up to 3 short strings — what actually affects him), ` +
        `"goodFor" (array of up to 3 short strings), ` +
        `"verdict" (one of: good, mixed, avoid), ` +
        `"checkCloser" (true if the timing is near enough to a boundary that he should confirm nearer the date).` }],
    });
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't work that out just now — try me again." });

    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { spoken: raw.slice(0, 400), watchFor: [], goodFor: [], verdict: "mixed", checkCloser: true }; }

    // Anything seasonal is worth remembering — he'll ask again about the same
    // place, and next time it can lead with what he already knows.
    try {
      const mem2 = STORE.mem[uid] = STORE.mem[uid] || [];
      mem2.push({ t: `season: ${where}${when ? ` in ${when}` : ""} — ${p.season || p.verdict || ""}`, at: Date.now() });
      while (mem2.length > 400) mem2.shift();
      saveStore();
    } catch {}

    res.json({
      ok: true,
      place: where,
      season: p.season || "",
      watchFor: (p.watchFor || []).slice(0, 3),
      goodFor: (p.goodFor || []).slice(0, 3),
      verdict: p.verdict || "mixed",
      checkCloser: p.checkCloser !== false,
      spoken: p.spoken || "",
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't work that out just now — try me again." });
  }
});

// --- Currency: convert using daily ECB rates (Frankfurter, no key) ---
// Body: { from, to, amount }
app.post("/currency", requireAuth, async (req, res) => {
  const { from, to, amount } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: "from,to required" });
  const amt = Number(amount) || 1;
  const u = new URL("https://api.frankfurter.app/latest");
  u.searchParams.set("from", from.toUpperCase());
  u.searchParams.set("to", to.toUpperCase());
  u.searchParams.set("amount", String(amt));
  try {
    const r = await fetch(u); const j = await r.json();
    const converted = j.rates?.[to.toUpperCase()];
    if (converted == null) return res.status(404).json({ error: "rate_unavailable" });
    const F = from.toUpperCase(), T = to.toUpperCase();
    const spoken = `${amt} ${F} is about ${Number(converted).toFixed(2)} ${T}.`;
    res.json({ from: F, to: T, amount: amt, converted, rateDate: j.date, spoken });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — try me again in a moment.", detail: String(e && e.message || e).slice(0, 160) }); }
});

// --- Summarize: "catch me up" on forwarded messages, or a daily debrief ---
// Body: { items: [strings], style: "messages" | "debrief" }
// KEPT FOR NATIVE: used by other endpoints and available to the native app
app.post("/summarize", requireAuth, async (req, res) => {
  const { items, style } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items array required" });
  }
  const joined = items.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const instruction = style === "debrief"
    ? `These are notes from the wearer's day. Give a warm, brief spoken recap (3-4 sentences), then one gentle suggestion if useful. No lists, no markdown.`
    : `These are recent messages/notifications the wearer missed. Lead with anything URGENT or time-sensitive first, then the rest. Summarize what matters in 2-3 spoken sentences: who needs a reply and why. No lists, no markdown.`;
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    // Batch 118 audit: no system prompt. This condenses things he'll act on —
    // an unread inbox, a long page — so an invented "urgent" item sends him
    // chasing something that was never there.
    system:
      "You condense something for a traveller who is busy and will act on what you say. " +
      "Lead with anything urgent or time-bound. Summarise only what is actually in the text — " +
      "if something looks important but is ambiguous, say it's unclear rather than deciding for him." + NO_INVENT + ANSWER_FIRST + SPOKEN_PLAIN,
    messages: [{ role: "user", content: `${instruction}\n\n${joined}` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(status).type("application/json").send(text);
    const json = JSON.parse(text);
    const summary = (json.content || []).filter(b => b.type === "text")
      .map(b => b.text).join(" ").trim();
    res.json({ summary });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: String(e && e.message || e).slice(0, 140) });
  }
});

// --- Email briefing: iCloud IMAP (app-specific password required) ---
// Uses imapflow. Install: npm install imapflow
// GET  /mail/unread            -> { count, messages: [{ from, subject, date, priority, uid }] }
// POST /mail/read { uid }      -> { from, subject, date, body }  (plain-text, trimmed)
//
// SECURITY: credentials come from env only, never from the app. The app calls
// these endpoints; it never sees the password.
let ImapFlow;
try { ({ ImapFlow } = require("imapflow")); } catch { /* installed at deploy */ }

function mailReady() { return ImapFlow && ICLOUD_USER && ICLOUD_APP_PW; }

async function withInbox(fn) {
  const client = new ImapFlow({
    host: "imap.mail.me.com", port: 993, secure: true,
    auth: { user: ICLOUD_USER, pass: ICLOUD_APP_PW },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try { return await fn(client); }
  finally { lock.release(); await client.logout().catch(() => {}); }
}

// Light priority heuristic: flag things that usually matter out and about.
function classifyPriority(from = "", subject = "") {
  const s = (from + " " + subject).toLowerCase();
  const urgent = ["bank", "payment", "security", "verify", "code", "flight",
    "booking", "delivery", "invoice", "urgent", "reminder", "appointment"];
  const low = ["newsletter", "digest", "promotion", "sale", "unsubscribe",
    "no-reply", "noreply", "notification"];
  if (urgent.some(w => s.includes(w))) return "high";
  if (low.some(w => s.includes(w))) return "low";
  return "normal";
}

app.get("/mail/unread", requireAuth, async (req, res) => {
  if (!mailReady()) {
    return res.status(501).json({ error: "mail_disabled",
      hint: "Set ICLOUD_USER + ICLOUD_APP_PW (app-specific password) and install imapflow." });
  }
  try {
    const messages = await withInbox(async (client) => {
      const out = [];
      // Fetch unseen; cap to the most recent 15 for a quick spoken briefing.
      const uids = await client.search({ seen: false });
      const recent = uids.slice(-15).reverse();
      for await (const msg of client.fetch(recent, { envelope: true, internalDate: true })) {
        const from = msg.envelope?.from?.[0];
        const fromName = from?.name || from?.address || "unknown";
        const subject = msg.envelope?.subject || "(no subject)";
        out.push({
          uid: msg.uid,
          from: fromName,
          subject,
          date: msg.internalDate,
          priority: classifyPriority(fromName, subject),
        });
      }
      return out;
    });
    res.json({ count: messages.length, messages, briefing: await mailBriefing(messages) });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "imap_failed" });
  }
});

// Vision reads the unread senders/subjects and gives a warm spoken triage.
async function mailBriefing(messages) {
  if (!messages.length) return "Your inbox is clear, Shaun — nothing unread.";
  try {
    const list = messages.slice(0, 12)
      .map((m, i) => `${i + 1}. from ${m.from} — "${m.subject}"`).join("\n");
    const r = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 220,
      system: "You are Vision, Shaun's warm companion in his glasses. Triage his unread email like a sharp assistant." + NO_INVENT,
      messages: [{ role: "user", content:
        `Give Shaun a SHORT spoken briefing of his unread email. Lead with anything that genuinely needs him ` +
        `(real people, bills, bookings, security), name who and why in a phrase, then note how many are just newsletters/promos. ` +
        `Two or three sentences, warm, no lists, no markdown.\n\n${list}` }],
    });
    if (r.status === 200) {
      const j = JSON.parse(r.text);
      const t = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
      if (t) return t;
    }
  } catch {}
  // Fallback: simple count using the keyword priority we already computed.
  const high = messages.filter(m => m.priority === "high").length;
  return high
    ? `You've got ${messages.length} unread, Shaun — ${high} look important.`
    : `You've got ${messages.length} unread, nothing urgent-looking.`;
}

// KEPT FOR NATIVE: native app will use this; the web app only shows the briefing
app.post("/mail/read", requireAuth, async (req, res) => {
  if (!mailReady()) return res.status(501).json({ error: "mail_disabled" });
  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: "uid required" });
  try {
    const result = await withInbox(async (client) => {
      const msg = await client.fetchOne(String(uid), { envelope: true, source: true });
      if (!msg) return null;
      // Extract a readable plain-text body from the raw source.
      const raw = msg.source?.toString("utf8") || "";
      const body = extractPlainText(raw);
      const from = msg.envelope?.from?.[0];
      return {
        from: from?.name || from?.address || "unknown",
        subject: msg.envelope?.subject || "(no subject)",
        date: msg.envelope?.date || null,
        body: body.slice(0, 1500), // keep spoken length sane
      };
    });
    if (!result) return res.status(404).json({ error: "not_found" });
    res.json(result);
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "imap_failed" });
  }
});

// ---- SMS OVER EMAIL (TelTel) ----
// Shaun's SMS arrive as emails from <number>@sms.teltel.com.au, and replying to
// that email sends an SMS back. These endpoints detect SMS specifically and send
// replies in the exact format TelTel needs (message first, then "Regards Shaun
// Erlandsson", no double line-breaks — TelTel truncates after that sign-off).
const SMS_DOMAIN = "sms.teltel.com.au";
const SMS_SIGNOFF = process.env.SMS_SIGNOFF || "Regards Shaun Erlandsson";

function smsNumberFrom(address = "") {
  const m = String(address).match(/([\d+]{6,15})@sms\.teltel\.com\.au/i);
  return m ? m[1] : null;
}

// List recent SMS specifically (separated from normal email).
app.get("/sms/recent", requireAuth, async (req, res) => {
  if (!mailReady()) return res.status(501).json({ error: "mail_disabled" });
  try {
    const out = await withInbox(async (client) => {
      const items = [];
      // pull recent messages, keep only SMS-format senders
      const all = await client.search({ since: new Date(Date.now() - 7 * 864e5) });
      const recent = all.slice(-40).reverse();
      for await (const msg of client.fetch(recent, { envelope: true, internalDate: true, source: true })) {
        const addr = msg.envelope?.from?.[0]?.address || "";
        const num = smsNumberFrom(addr);
        if (!num) continue;
        const body = extractPlainText(msg.source?.toString("utf8") || "")
          .replace(/reply directly to this email[\s\S]*/i, "").trim();
        items.push({ uid: msg.uid, number: num, replyTo: addr, text: body.slice(0, 600), date: msg.internalDate });
        if (items.length >= 15) break;
      }
      return items;
    });
    res.json({ count: out.length, messages: out });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "imap_failed" });
  }
});

// Send an SMS reply (or new SMS) via SMTP → TelTel converts it to a text.
let nodemailer;
try { nodemailer = require("nodemailer"); } catch { /* installed at deploy */ }
function mailer() {
  return nodemailer.createTransport({
    host: "smtp.mail.me.com", port: 587, secure: false,
    auth: { user: ICLOUD_USER, pass: ICLOUD_APP_PW },
  });
}
app.post("/sms/send", requireAuth, async (req, res) => {
  if (!mailReady() || !nodemailer) return res.status(501).json({ error: "mail_disabled", hint: "Set ICLOUD_USER + ICLOUD_APP_PW and install nodemailer." });
  let { number, message } = req.body || {};
  if (!number || !message) return res.status(400).json({ error: "number and message required" });
  const to = /@/.test(number) ? number : `${String(number).replace(/[^\d+]/g, "")}@${SMS_DOMAIN}`;
  // TelTel format: message, blank line, sign-off. Avoid double line breaks mid-message.
  const clean = String(message).replace(/\n{2,}/g, "\n").trim();
  const bodyText = `${clean}\n${SMS_SIGNOFF}`;
  try {
    await mailer().sendMail({ from: ICLOUD_USER, to, subject: "SMS", text: bodyText });
    res.json({ ok: true, to });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "smtp_failed" });
  }
});

// Send a normal email reply (for actual emails, not SMS).
// KEPT FOR NATIVE: native app will use this; no web UI yet by design
app.post("/mail/send", requireAuth, async (req, res) => {
  if (!mailReady() || !nodemailer) return res.status(501).json({ error: "mail_disabled" });
  const { to, subject, message, html } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: "to and message required" });
  try {
    await mailer().sendMail({ from: ICLOUD_USER, to, subject: subject || "(no subject)",
      text: String(message), ...(html ? { html: String(html) } : {}) });
    res.json({ ok: true, to });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "smtp_failed" });
  }
});

// Crude but dependency-free: pull the text/plain part, strip headers & simple HTML.
function extractPlainText(raw) {
  // Prefer a text/plain section if present.
  const plainIdx = raw.search(/content-type:\s*text\/plain/i);
  let chunk = raw;
  if (plainIdx !== -1) {
    chunk = raw.slice(plainIdx);
    const blank = chunk.indexOf("\r\n\r\n");
    if (blank !== -1) chunk = chunk.slice(blank + 4);
    const nextBoundary = chunk.indexOf("\r\n--");
    if (nextBoundary !== -1) chunk = chunk.slice(0, nextBoundary);
  }
  return chunk
    .replace(/<[^>]+>/g, " ")
    .replace(/=\r?\n/g, "")        // quoted-printable soft breaks
    .replace(/=[0-9A-F]{2}/g, " ") // rough quoted-printable strip
    .replace(/\s+/g, " ")
    .trim();
}

// --- Local briefing: headlines, traffic, events, food near a place ---
// Body: { place, kinds?: ["headlines","traffic","events","food"] }
// Uses Claude with web search to assemble a short spoken briefing.
app.post("/local", requireAuth, async (req, res) => {
  // Batch 66: this endpoint gives ADVICE, so it should know him. Pull the
  // memories relevant to local knowledge and let the model use them.
  const _mem = recallFor(uidOf(req), JSON.stringify(req.body || {}).slice(0, 300), 4)
    .map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  const _memNote = _mem ? `\n\nWhat you remember about him that may matter here (use only if relevant): ${_mem}` : "";
  const { place, kinds } = req.body || {};
  if (!place) return res.status(400).json({ error: "place required" });
  const want = Array.isArray(kinds) && kinds.length ? kinds : ["headlines", "events", "food"];
  const menu = {
    headlines: "top local news headlines today",
    traffic: "current traffic or transit disruptions",
    events: "notable events happening today or this week",
    food: "well-reviewed places to eat right now",
  };
  const asks = want.map(k => menu[k]).filter(Boolean).join("; ");
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    // Batch 118 audit: no system prompt. This one states events, transport
    // disruptions and opening food places as FACT, so it's the highest
    // invention risk of the lot — he plans a day around it.
    system:
      "You brief a traveller on what's happening around them right now. " +
      "Only state something as fact if the search results actually support it — otherwise say what's typical and that it needs checking. " +
      "Lead with anything time-sensitive; skip anything he can't act on today." +
      NO_INVENT_STRICT + SPOKEN_PLAIN + ANSWER_FIRST + visionContext(uidOf(req), {recall: JSON.stringify(req.body||{}).slice(0,200), lat: (req.body||{}).lat, lng: (req.body||{}).lng}),
    messages: [{
      role: "user",
      content: `For someone in or near ${place}, give a brief spoken briefing covering: ${asks}. ${_memNote}` +
               `Keep it tight and useful — a few sentences per topic, spoken-style, no markdown, no lists. ` +
               `Lead with anything time-sensitive.`
    }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(status).type("application/json").send(text);
    const json = JSON.parse(text);
    const briefing = (json.content || []).filter(b => b.type === "text")
      .map(b => b.text).join(" ").trim();
    res.json({ place, briefing });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: String(e && e.message || e).slice(0, 140) });
  }
});

// --- Receipt parsing: image -> structured expense record ---
// Body: a /v1/messages body with the receipt image (app builds it, like /vision).
// The app prompts for JSON; this just forwards. Kept as its own route for clarity
// and so you can meter receipt costs separately.
// --- Receipt: Vision reads a receipt photo → structured expense ---
// Body: { image:"<base64>", mediaType? }  OR raw messages (back-compat)
// Returns: { merchant, total, currency, date, category, summary } or {fallback,...}
app.post("/receipt", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b.messages)) { // back-compat
      const { status, text } = await callClaude(b);
      return res.status(status).type("application/json").send(text);
    }
    if (!b.image) return res.status(400).json({ error: "image required" });
    // Batch 120 audit: no size check — an oversized photo reached Anthropic.
    {
      const _v = checkImage(b.image, b.mediaType);
      if (!_v.ok) return res.status(200).json({ fallback: true, spoken: _v.spoken });
      b.image = _v.data; b.mediaType = _v.mediaType;
    }
    const r = await callClaude({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: "You are Vision, logging Shaun's expenses. Read receipts precisely." + NO_INVENT,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: b.mediaType || "image/jpeg", data: b.image } },
        { type: "text", text:
          `Extract this receipt as compact JSON ONLY (no markdown): keys ` +
          `"merchant","total"(number),"currency","date"(YYYY-MM-DD or ""),` +
          `"category"(one of: food, transport, lodging, shopping, fuel, other),` +
          `"summary"(one warm spoken sentence for Shaun, e.g. "Logged $18.50 at Joe's Cafe."). ` +
          `If unreadable, set fields to "" and say so in summary.` },
      ]}],
    });
    if (r.status !== 200) return res.status(200).json({ fallback: true, summary: "Couldn't read that receipt — try a clearer photo?" });
    const j = JSON.parse(r.text);
    const raw = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
    let out; try { out = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { out = { summary: raw }; }
    res.json(out);
  } catch (e) {
    res.status(200).json({ fallback: true, summary: "Receipt scan glitched — give it another go." });
  }
});

// --- Recall: Vision remembers short notes and finds them again ---
// NOTE: server-side store is in-memory (resets on redeploy). The app ALSO keeps
// its own per-device copy, which is the durable one until the native app.
// Body: { action:"save", text } | { action:"search", query }
const _notes = [];
app.post("/recall", requireAuth, async (req, res) => {
  const { action, text, query, lat, lng } = req.body || {};
  try {
    const uid = uidOf(req);
    const mem = STORE.mem[uid] = STORE.mem[uid] || [];
    if (action === "save") {
      if (!text) return res.status(400).json({ error: "text required" });
      // Accept structured coords when present (a saved spot) so recall can
      // navigate back to it, not just read the numbers out of the text.
      const coords = (lat != null) ? { lat, lng } : undefined;
      remember(uid, text, { kind: "note", coords });
      saveStore();
      return res.json({ ok: true, saved: text });
    }
    if (action === "search") {
      if (!mem.length) return res.json({ answer: "I don't have anything saved yet." });
      const list = recallFor(uid, query || "", 40).map((n, i) => `${i + 1}. ${when(n.at)}: ${n.t}`).join("\n");
      const r = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 160,
        system: "You are Vision recalling Shaun's own saved notes. Answer only from them, warmly and briefly." + SPOKEN_PLAIN,
        messages: [{ role: "user", content:
          `Shaun asks: "${query || "what have I saved?"}". From his notes below, answer in one or two spoken sentences. ` +
          `If nothing matches, say so gently.\n\n${list}` }],
      });
      let answer = "I couldn't find that in your notes.";
      if (r.status === 200) { const j = JSON.parse(r.text);
        answer = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim() || answer; }
      return res.json({ answer });
    }
    return res.status(400).json({ error: "action must be save or search" });
  } catch (e) {
    res.status(200).json({ fallback: true, answer: "My memory glitched for a moment — try again?" });
  }
});

// --- Keep-alive: a tiny public endpoint + self-ping so the free tier never sleeps ---
// /ping needs no auth (it's harmless) so an external uptime service can hit it too.
// ============================================================
// OPENAI-COMPATIBLE SHIM (batch 37) — for OpenVision / native clients.
// Speaks OpenAI's /v1/chat/completions format on the outside, calls CLAUDE
// on the inside (same key, same persona). "OpenAI-compatible" is the plug
// shape, not the engine. Client setup: base URL = this server + /v1,
// API key = APP_SHARED_TOKEN, model name = anything.
// Optional: set OPENAI_FALLBACK_KEY and, if Claude errors hard, the ORIGINAL
// request is passed through to api.openai.com unchanged. Dormant without it.
// ============================================================
const OPENAI_FALLBACK_KEY = process.env.OPENAI_FALLBACK_KEY; // optional

// One OpenAI message -> one Anthropic message (text + image parts).
function oaiMsgToAnthropic(m) {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  const parts = (m.content || []).map(p => {
    if (p.type === "text") return { type: "text", text: p.text || "" };
    if (p.type === "image_url") {
      const u = p.image_url?.url || "";
      const mt = (u.match(/^data:([^;]+);base64,/) || [])[1];
      if (mt) return { type: "image", source: { type: "base64", media_type: mt, data: u.split(",")[1] } };
    }
    return null;
  }).filter(Boolean);
  return { role: m.role, content: parts.length ? parts : "" };
}

app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  const b = req.body || {};
  const oaiMessages = Array.isArray(b.messages) ? b.messages : [];
  try {
    // Fast path: real token-by-token streaming (batch 85). Tools force the
    // buffered path because tool_calls must be assembled before dispatch.
    const wantsStream = !!b.stream && !(Array.isArray(b.tools) && b.tools.length);
    // Split system messages out (Anthropic takes system separately).
    const clientSystem = oaiMessages.filter(m => m.role === "system")
      .map(m => typeof m.content === "string" ? m.content : "").join(" ").trim();
    const convo = [];
    for (const m of oaiMessages) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        // OpenAI tool result -> Anthropic tool_result on a user turn
        convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") }] });
      } else if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const blocks = [];
        if (m.content) blocks.push({ type: "text", text: String(m.content) });
        for (const tc of m.tool_calls) {
          let args = {}; try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: args });
        }
        convo.push({ role: "assistant", content: blocks });
      } else {
        convo.push(oaiMsgToAnthropic(m));
      }
    }
    if (!convo.length) convo.push({ role: "user", content: "Hello" });

    // Client tools (OpenAI function format) -> Anthropic tools.
    const clientTools = Array.isArray(b.tools) ? b.tools
      .filter(t => t.type === "function" && t.function)
      .map(t => ({ name: t.function.name, description: t.function.description || "", input_schema: t.function.parameters || { type: "object", properties: {} } })) : [];

    // Persona: warm Vision core, honest about the native context — the client's
    // tools are whatever arrived in THIS request, not the web app's tiles.
    const lastUserText = [...convo].reverse().find(m => m.role === "user");
    const nuid = uidOf(req); const nprof = profileOf(nuid); const nb = briefOf(nuid); const nf = flagsOf(nuid);
    const NAME = nprof.name || "Shaun"; const AINAME = nprof.ainame || "Vision";
    const sys = [
      `You are ${AINAME}, ${NAME}'s warm AI companion, now speaking through smart glasses.`,
      "Replies are spoken aloud: SHORT, natural, no markdown, no lists — one to three sentences unless asked for more.",
      `Be genuinely useful first, friendly second. Address them as ${NAME} when natural.`,
      coreBrief(nuid),
      recallBrief(nuid, typeof lastUserText?.content === "string" ? lastUserText.content : ""),
      nprof.style ? `STYLE REQUEST: speak in this style — ${nprof.style}. Honour the tone; never let style override substance or honesty.` : "",
      "If tools are provided in this request, use them when they fit rather than guessing.",
      "You can search the web when you need current facts — never claim you lack internet access.",
      (nb && Date.now() - nb.at < 86400000) ? `WHAT YOU KNOW ABOUT ${NAME.toUpperCase()}'S SITUATION (synced from the app): ${nb.text}` : "",
      nf.whisper ? "WHISPER MODE is on: answer in ONE short sentence, calm and quiet in tone." : "",
      clientSystem,
    ].filter(Boolean).join(" ");

    const body = {
      model: nf.saver ? "claude-haiku-4-5-20251001" : pickModel(typeof lastUserText?.content === "string" ? lastUserText.content : "", null),
      max_tokens: Math.min(Number(b.max_tokens) || 600, 1500),
      system: sys,
      messages: convo,
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 2 },
        ...clientTools,
      ],
    };
    if (wantsStream) {
      // Ask Claude for a stream and relay each delta straight through as
      // OpenAI-shaped SSE. First word reaches the ear in ~400ms instead of
      // waiting for the whole answer to finish generating.
      const up = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({ ...body, stream: true }),
      });
      if (!up.ok || !up.body) {
        const why = await up.text().catch(() => "");
        dlog(null, "errors", `shim stream ${up.status}`, String(why).slice(0, 120));
        return res.status(502).json({ error: { message: "upstream_failed", type: "server_error" } });
      }
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      const sid = "chatcmpl-" + Date.now();
      const created = Math.floor(Date.now() / 1000);
      const send = (delta, fin) => res.write("data: " + JSON.stringify({
        id: sid, object: "chat.completion.chunk", created, model: body.model,
        choices: [{ index: 0, delta, finish_reason: fin || null }],
      }) + "\n\n");
      send({ role: "assistant" });
      const reader = up.body.getReader();
      const dec = new TextDecoder();
      let buf = "", usage = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let ev; try { ev = JSON.parse(raw); } catch { continue; }
            if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
              send({ content: ev.delta.text });
            } else if (ev.type === "message_delta" && ev.usage) {
              usage = { input_tokens: usage?.input_tokens ?? 0, output_tokens: ev.usage.output_tokens ?? 0 };
            } else if (ev.type === "message_start" && ev.message && ev.message.usage) {
              usage = { input_tokens: ev.message.usage.input_tokens ?? 0, output_tokens: 0 };
            }
          }
        }
      } catch (e) { dlog(null, "errors", "shim stream broke", String(e.message || e).slice(0, 80)); }
      if (usage) recordUsage(body.model, usage);
      send({}, "stop");
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    const { status, text } = await callClaude(body);
    if (status !== 200) {
      // Optional passthrough fallback — the request is ALREADY OpenAI format.
      if (OPENAI_FALLBACK_KEY) {
        try {
          const fb = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_FALLBACK_KEY}` },
            body: JSON.stringify({ ...b, model: b.model && String(b.model).startsWith("gpt") ? b.model : "gpt-4o-mini", stream: false }),
          });
          const fj = await fb.text();
          return res.status(fb.status).type("application/json").send(fj);
        } catch { /* fall through to error below */ }
      }
      let why = ""; try { why = JSON.parse(text)?.error?.message || ""; } catch {}
      return res.status(502).json({ error: { message: why || "upstream_failed", type: "server_error" } });
    }

    const j = JSON.parse(text);
    const textOut = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
    const toolUses = (j.content || []).filter(x => x.type === "tool_use" && clientTools.some(t => t.name === x.name));
    const message = { role: "assistant", content: toolUses.length ? (textOut || null) : textOut };
    if (toolUses.length) {
      message.tool_calls = toolUses.map(t => ({
        id: t.id, type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
      }));
    }
    const payload = {
      id: "chatcmpl-buddy-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message, finish_reason: toolUses.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: j.usage?.input_tokens ?? 0, completion_tokens: j.usage?.output_tokens ?? 0, total_tokens: (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0) },
    };

    // Streaming clients: emit the reply as OpenAI-style SSE (one delta + DONE).
    if (b.stream) {
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      const chunk = (delta, fin) => res.write("data: " + JSON.stringify({
        id: payload.id, object: "chat.completion.chunk", created: payload.created, model: payload.model,
        choices: [{ index: 0, delta, finish_reason: fin || null }],
      }) + "\n\n");
      chunk({ role: "assistant" });
      if (message.tool_calls) chunk({ tool_calls: message.tool_calls.map((tc, i) => ({ index: i, ...tc })) });
      if (textOut) chunk({ content: textOut });
      chunk({}, payload.choices[0].finish_reason);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: { message: "shim_failed", type: "server_error" } });
  }
});

// Some OpenAI clients probe /v1/models on setup — answer so setup succeeds.
app.get("/v1/models", requireAuth, (req, res) => {
  res.json({ object: "list", data: [
    { id: "buddy-claude", object: "model", created: 0, owned_by: "buddy" },
    { id: "claude-sonnet-4-6", object: "model", created: 0, owned_by: "buddy" },
  ] });
});

// --- SHIM SELF-TEST (batch 39): verify the native integration from a phone,
// no Mac needed. Open in Safari:  /v1/selftest?tok=YOUR_APP_SHARED_TOKEN
// The server calls its OWN /v1/chat/completions (exactly as OpenVision will)
// and reports what happened. Token via query because Safari can't set headers.
app.get("/v1/selftest", async (req, res) => {
  if (!safeEqual(req.query.tok || "", APP_TOKEN)) return res.status(401).send("unauthorized — add ?tok=your token");
  const t0 = Date.now();
  const out = { modelsProbe: null, chat: null, ms: 0 };
  try {
    const base = `http://127.0.0.1:${PORT}`;
    const auth = { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" };
    // 1) the setup probe OpenVision makes
    const mr = await fetch(`${base}/v1/models`, { headers: auth });
    out.modelsProbe = mr.ok ? "ok" : `failed (${mr.status})`;
    // 2) a real chat round trip through the shim -> Claude
    const cr = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ messages: [{ role: "user", content: "Reply with exactly: Vision link confirmed." }], max_tokens: 30 }),
    });
    const cj = await cr.json().catch(() => ({}));
    out.chat = cr.ok
      ? { status: "ok", reply: cj.choices?.[0]?.message?.content || "(empty)", model: cj.model || "?" }
      : { status: `failed (${cr.status})`, error: cj.error?.message || "" };
  } catch (e) { out.chat = { status: "failed", error: String(e.message || e) }; }
  out.ms = Date.now() - t0;
  const good = out.modelsProbe === "ok" && out.chat && out.chat.status === "ok";
  res.type("html").send(`<html><body style="font-family:system-ui;background:#0B1026;color:#EAE6DA;padding:24px;line-height:1.6">
    <h2>${good ? "✅ Native link ready" : "❌ Not ready yet"}</h2>
    <p><b>Models probe:</b> ${out.modelsProbe}</p>
    <p><b>Chat via shim:</b> ${out.chat?.status}${out.chat?.reply ? ` — Vision said: “${out.chat.reply}”` : ""}${out.chat?.error ? `<br><small>${out.chat.error}</small>` : ""}</p>
    <p><b>Model:</b> ${out.chat?.model || "-"} · <b>Round trip:</b> ${out.ms} ms</p>
    <p style="opacity:.7">${good ? "OpenVision setup: backend = OpenAI · base URL = this server + /v1 · API key = your app token." : "Fix the error above, redeploy the brain, and refresh this page."}</p>
  </body></html>`);
});

// --- ROUTER REGRESSION CHECK (batch 43): fire realistic phrasings at the LIVE
// classifier and report pass/fail — catches "wrong skill = nonsense answer"
// bugs (Shaun's flight/cinema/bank catches) after every deploy, from a phone.
// Open: /routecheck?tok=YOUR_TOKEN  (~24 haiku calls per run, cheap)
app.get("/routecheck", async (req, res) => {
  if (!safeEqual(req.query.tok || "", APP_TOKEN)) return res.status(401).send("unauthorized — add ?tok=your token");
  const cases = [
    ["cheapest flights Brisbane to Bali in September", ["flightsearch"]],
    ["how's my flight", ["flight"]],
    ["take me to the cinema", ["nearby", "navigate"]],
    ["take me to 12 Smith Street", ["navigate"]],
    ["find me a bank and take me there", ["nearby"]],
    ["where should I stay in Ubud", ["stay"]],
    ["what's worth doing around here", ["activities"]],
    ["plan 5 days in Bali", ["tripplan"]],
    ["what's on day 2", ["tripday"]],
    ["what should I pack", ["packlist"]],
    ["how much will 10 days in Bali cost", ["tripbudget"]],
    ["how do I get data in Bali", ["esim"]],
    ["log 15 for lunch", ["logspend"]],
    ["is this safe to eat", ["allergy"]],
    ["is 80000 dong fair for a taxi", ["scamcheck", "gooddeal"]],
    ["what's the weather like", ["weather"]],
    ["convert 50 dollars to baht", ["currency"]],
    ["read my texts", ["readtexts"]],
    ["check my email", ["mailbrief"]],
    ["where's my wife", ["whereis"]],
    ["tell her I'm on my way", ["onmyway", "tellpartner"]],
    ["remember this spot as the car", ["rememberspot"]],
    ["take me back to the car", ["backto"]],
    ["watch what I'm seeing", ["livelook"]],
  ];
  const rows = []; let pass = 0; const t0 = Date.now();
  for (const [phrase, expect] of cases) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/route`, {
        method: "POST",
        headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ message: phrase }),
      });
      const j = await r.json();
      const got = j.skill || "?";
      const ok = expect.includes(got);
      if (ok) pass++;
      rows.push(`<tr><td>${ok ? "✅" : "❌"}</td><td>${phrase}</td><td>${got}</td><td>${ok ? "" : "wanted: " + expect.join("/")}</td></tr>`);
    } catch (e) { rows.push(`<tr><td>❌</td><td>${phrase}</td><td colspan=2>error: ${String(e.message || e)}</td></tr>`); }
  }
  res.type("html").send(`<html><body style="font-family:system-ui;background:#0B1026;color:#EAE6DA;padding:18px">
    <h2>${pass === cases.length ? "✅" : "⚠️"} Router check: ${pass}/${cases.length} passed</h2>
    <p style="opacity:.7">${Date.now() - t0} ms total. Red rows = phrasings that would get a mismatched answer in the app.</p>
    <table cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows.join("")}</table>
  </body></html>`);
});

// --- PERFORMANCE DASHBOARD (batch 48): /perf?tok=YOUR_TOKEN ---
// Latency meters for EVERY api + system Vision touches, model-switch table,
// OpenVision integration status, and the token/spend estimate since deploy.
// Each run makes ~4 tiny model calls (cents territory). Bars: green <500ms,
// amber <1500ms, red beyond.
app.get("/perf", async (req, res) => {
  if (!safeEqual(req.query.tok || "", APP_TOKEN)) return res.status(401).send("unauthorized — add ?tok=your token");
  const t0 = Date.now();
  const lanes = [];
  const lane = async (name, fn) => {
    const s = Date.now();
    try { const ok = await fn(); lanes.push({ name, ms: Date.now() - s, ok: ok !== false, note: ok === null ? "not set up" : "" }); }
    catch (e) { lanes.push({ name, ms: Date.now() - s, ok: false, note: String(e.message || e).slice(0, 60) }); }
  };
  const base = `http://127.0.0.1:${PORT}`;
  const auth = { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" };

  await lane("Server (self ping)", async () => (await fetch(`${base}/ping`)).ok);
  await lane("Claude — Haiku (fast lane)", async () => (await callClaude({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })).status === 200);
  await lane("Claude — Sonnet (smart lane)", async () => (await callClaude({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })).status === 200);
  await lane("OpenVision shim (native path)", async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ messages: [{ role: "user", content: "Reply: ok" }], max_tokens: 5 }) });
    return r.ok;
  });
  await lane("OpenAI fallback", async () => {
    if (!OPENAI_FALLBACK_KEY) return null;
    const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_FALLBACK_KEY}` }, body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }) });
    return r.ok;
  });
  await lane("Google Maps", async () => {
    if (!GMAPS_KEY) return null;
    const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    u.searchParams.set("address", "Brisbane"); u.searchParams.set("key", GMAPS_KEY);
    return (await (await fetch(u)).json()).status === "OK";
  });
  await lane("Weather (Open-Meteo)", async () => (await fetch("https://api.open-meteo.com/v1/forecast?latitude=-27.5&longitude=153&current=temperature_2m")).ok);
  await lane("Currency (Frankfurter)", async () => (await fetch("https://api.frankfurter.app/latest?from=AUD&to=USD")).ok);
  await lane("Flights (AviationStack)", async () => { if (!FLIGHT_KEY) return null; return (await aviationFetch({ access_key: FLIGHT_KEY, limit: "1" })).ok; });
  await lane("Email (iCloud IMAP)", async () => { if (!mailReady()) return null; return await withInbox(async () => true); });

  // Model-switch table — pure logic, zero cost.
  const samples = ["what's the weather", "hi", "explain why the baht is falling", "plan my day in Hanoi", "log 15 for lunch", "compare grab and taxis", "translate a menu", "how far is the beach"];
  const pflags = flagsOf(uidOf(req));
  const switches = samples.map(p => `<tr><td>${p}</td><td>${(pflags.saver ? "claude-haiku-4-5-20251001 (saver)" : pickModel(p, null)).replace("claude-", "")}</td></tr>`).join("");

  // Usage + spend estimate since deploy.
  const upMin = Math.round(process.uptime() / 60);
  const rows = Object.entries(usageTotals).map(([m, u]) =>
    `<tr><td>${m.replace("claude-", "")}</td><td>${u.calls}</td><td>${u.inTok.toLocaleString()}</td><td>${u.outTok.toLocaleString()}</td></tr>`).join("") || "<tr><td colspan=4>no calls yet this deploy</td></tr>";

  const bar = l => {
    const w = Math.min(100, Math.round(l.ms / 25));
    const col = !l.ok ? "#e33" : l.note === "not set up" ? "#888" : l.ms < 500 ? "#3c8" : l.ms < 1500 ? "#F5A623" : "#e33";
    const tag = l.note === "not set up" ? "⚪ not set up" : l.ok ? `${l.ms} ms` : `❌ ${l.note || "down"}`;
    return `<div style="margin:7px 0"><div style="display:flex;justify-content:space-between"><span>${l.name}</span><b>${tag}</b></div>
      <div style="background:rgba(255,255,255,.08);border-radius:6px;height:10px"><div style="width:${l.note === "not set up" ? 3 : w}%;background:${col};height:10px;border-radius:6px"></div></div></div>`;
  };

  // log this run for the timeline
  const worst = lanes.filter(l => l.note !== "not set up").reduce((a, l) => Math.max(a, l.ms), 0);
  perfLog.push({ at: Date.now(), ok: lanes.every(l => l.ok), worst });
  if (perfLog.length > 30) perfLog.shift();

  // SVG timeline of REAL brain traffic (last 200 calls), colored by model
  const W = 340, H = 110;
  const maxMs = Math.max(600, ...brainLog.map(p => p.ms));
  const pt = (p, i) => `${(i / Math.max(1, brainLog.length - 1) * (W - 10) + 5).toFixed(1)},${(H - 8 - (p.ms / maxMs) * (H - 20)).toFixed(1)}`;
  const line = model => brainLog.map((p, i) => p.model === model ? pt(p, i) : null).filter(Boolean).join(" ");
  const chart = brainLog.length < 2 ? "<p style='opacity:.6'>No traffic logged yet this deploy — use Vision, then refresh.</p>" :
    `<svg width="${W}" height="${H}" style="background:rgba(255,255,255,.04);border-radius:10px">
      <text x="6" y="14" fill="#888" font-size="10">${maxMs}ms</text>
      <text x="6" y="${H - 2}" fill="#888" font-size="10">0</text>
      <polyline points="${line("claude-haiku-4-5-20251001")}" fill="none" stroke="#3c8" stroke-width="2"/>
      <polyline points="${line("claude-sonnet-4-6")}" fill="none" stroke="#F5A623" stroke-width="2"/>
    </svg>
    <p style="font-size:12px;opacity:.7"><span style="color:#3c8">━ Haiku (fast)</span> · <span style="color:#F5A623">━ Sonnet (smart)</span> · last ${brainLog.length} real calls</p>`;

  // per-model latency stats from real traffic
  const stat = model => {
    const xs = brainLog.filter(p => p.model === model).map(p => p.ms);
    if (!xs.length) return null;
    xs.sort((a, b) => a - b);
    return { n: xs.length, avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), p50: xs[Math.floor(xs.length * .5)], worst: xs[xs.length - 1] };
  };
  const statRows = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"].map(m => {
    const st = stat(m); if (!st) return "";
    return `<tr><td>${m.replace("claude-", "")}</td><td>${st.n}</td><td>${st.avg}ms</td><td>${st.p50}ms</td><td>${st.worst}ms</td></tr>`;
  }).join("") || "<tr><td colspan=5>no traffic yet</td></tr>";

  // perf-run timeline
  const runRows = perfLog.slice().reverse().map(r =>
    `<tr><td>${new Date(r.at).toLocaleTimeString("en-AU", { timeZone: "Australia/Brisbane" })}</td><td>${r.ok ? "✅ all up" : "⚠️ issue"}</td><td>worst ${r.worst}ms</td></tr>`).join("");

  res.type("html").send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="font-family:system-ui;background:#0B1026;color:#EAE6DA;padding:18px;line-height:1.5">
    <h2>⚡ Vision performance</h2>
    <h3>Brain latency — real traffic timeline</h3>${chart}
    <table cellpadding="5" style="font-size:13px"><tr><th>model</th><th>calls</th><th>avg</th><th>median</th><th>worst</th></tr>${statRows}</table>
    <p style="opacity:.7">Full sweep took ${Date.now() - t0} ms · <a style="color:#F5A623" href="/perf?tok=${req.query.tok}">run again</a> (~4 tiny model calls per run)</p>
    <h3>Latency — every system</h3>${lanes.map(bar).join("")}
    <h3>Check history (this deploy)</h3>
    <table cellpadding="5" style="font-size:13px">${runRows || "<tr><td>first run</td></tr>"}</table>
    <h3>When the brain switches models</h3>
    <table cellpadding="5" style="font-size:14px;border-collapse:collapse">${switches}</table>
    <p style="opacity:.6;font-size:13px">Haiku = fast lane, Sonnet = smart lane. Battery saver ${pflags.saver ? "is ON — everything forced to Haiku" : "off — routing is automatic"}.</p>
    <h3>Usage & spend (since deploy, ${upMin} min ago)</h3>
    <table cellpadding="5" style="font-size:14px"><tr><th>model</th><th>calls</th><th>tokens in</th><th>tokens out</th></tr>${rows}</table>
    <p><b>Estimated spend this deploy: $${usdEstimate().toFixed(4)} USD</b></p>
    <p style="opacity:.6;font-size:13px">Estimate from actual token counts. Your API key can't read the real balance — console.anthropic.com is the bill.</p>
    <h3>OpenVision integration</h3>
    <p style="font-size:14px">Trip-state sync: ${briefOf(uidOf(req)) ? `fresh (${Math.round((Date.now() - briefOf(uidOf(req)).at) / 60000)} min old)` : "not primed yet — use the web app once"}<br>
    Memory store: ${DURABLE ? "💾 durable disk (/var/data)" : "⚠️ EPHEMERAL — add a Render Disk at /var/data to survive redeploys"}<br>
    ${_loadState === "recovered" ? "⚠️ Last start: the main memory file was unreadable and Vision recovered from its backup.<br>"
      : _loadState === "corrupt" ? "🛑 Last start: memory was unreadable with no backup — Vision started fresh. The damaged file was kept for inspection.<br>"
      : ""}
    Modes: whisper ${pflags.whisper ? "ON" : "off"} · quiet ${pflags.quiet ? "ON" : "off"} · saver ${pflags.saver ? "ON" : "off"}</p>
  </body></html>`);
});

// --- 🔗 READPAGE (batch 50): the web-possible slice of the Vision Browser.
// Shaun pastes any link; server fetches the page (no CORS wall server-side),
// strips it to text, Haiku summarises. The native Safari extension makes this
// automatic later — this is the manual version, working today.
app.post("/readpage", requireAuth, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  let u;
  try { u = new URL(url); } catch { return res.status(400).json({ error: "bad url" }); }
  // SSRF guard: public http(s) only — never the server's own network.
  if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname))
    return res.status(400).json({ error: "blocked url" });
  try {
    // A hung page must never tie up the single dyno — 8s hard cap, like caldav.
    const _ac = new AbortController();
    const _to = setTimeout(() => _ac.abort(), 8000);
    let r, html;
    try {
      r = await fetch(u, { redirect: "follow", signal: _ac.signal, headers: { "user-agent": "Mozilla/5.0 (VisionReader)" } });
      html = await r.text();
    } finally { clearTimeout(_to); }
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || u.hostname;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&[a-z#\d]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 8000);
    if (text.length < 200) return res.status(422).json({ error: "page_unreadable", title });
    const body = {
      model: "claude-haiku-4-5-20251001", max_tokens: 400,
      system: "You are Vision, summarising a web page aloud for Shaun. JSON only: {\"spoken\": \"2-3 sentence summary of what actually matters\", \"points\": [\"up to 4 short key points\"]}. No markdown." + NO_INVENT,
      messages: [{ role: "user", content: `Page: ${title}\n\n${text}` }],
    };
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "summarise_failed" });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300), points: [] }; }
    res.json({ title, spoken: p.spoken || "", points: Array.isArray(p.points) ? p.points.slice(0, 4) : [] });
  } catch (e) { res.status(200).json({ fallback: true, spoken: "Couldn't do that just now — try me again in a moment.", detail: "fetch: " + String(e && e.message || e).slice(0, 140) }); }
});

// --- 🧠 RECALL ENGINE (batch 61) ---
// Score memories against the current question: keyword overlap + recency.
// Deliberately simple — at hundreds of notes this beats a vector DB for both
// speed and cost, and never surfaces the laundry receipt during a flight search.
const STOP = new Set("the a an and or but is are was were i me my you your it this that of to in on for with what where when how do does can could would should about".split(" "));
function when(ts) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return "today"; if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`; if (d < 30) return `${Math.floor(d / 7)} weeks ago`;
  return new Date(ts).toLocaleDateString("en-AU", { month: "short", day: "numeric" });
}
// Forward-looking counterpart of when() — "today at 1pm", "tomorrow at 8am",
// "Monday at 8am", or a dated form further out. Used to surface upcoming events.
function whenPhrase(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true }).replace(":00", "").replace(/\s?([ap]m)$/i, "$1");
  const days = Math.floor((new Date(ts).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${d.toLocaleDateString("en-AU", { weekday: "long" })} at ${time}`;
  return `${d.toLocaleDateString("en-AU", { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}
/* --- 🧠 remember(): the ONE way anything logs to memory (build 159) ---------
 * Every skill logs through this instead of hand-rolling mem.push + cap + save.
 * Change how memory works (tagging, cap, weighting) HERE and all callers inherit
 * it. opts.kind categorises the line (job, spend, moment, conversation, etc.)
 * so recall and future rollups can filter; opts.weight biases recall ranking;
 * opts.at overrides the timestamp (for back-dated day summaries); opts.origin
 * marks tool-written lines. Returns the stored entry.
 * Rule (locked 2026-07-22): brain capabilities are shared helpers, never per-tile.
 */
function remember(uid, text, opts = {}) {
  if (!uid || !text || !String(text).trim()) return null;
  STORE.mem[uid] = STORE.mem[uid] || [];
  const mem = STORE.mem[uid];
  const entry = { t: String(text).slice(0, 500), at: opts.at || Date.now() };
  if (opts.kind) entry.kind = opts.kind;
  if (opts.weight != null) entry.weight = opts.weight;
  if (opts.origin) entry.origin = opts.origin;
  if (opts.coords && opts.coords.lat != null) entry.coords = { lat: opts.coords.lat, lng: opts.coords.lng };
  mem.push(entry);
  while (mem.length > 400) mem.shift();
  if (opts.save !== false) saveStore();
  return entry;
}

/* --- 🚦 consider(): the salience gate (build 159) ---------------------------
 * The human-memory judge. Ambient streams (what he SAW through the glasses, what
 * he SAID, where he WENT) flow through here instead of straight into memory —
 * because logging every glance and every "what's the weather" would bury the
 * memories that matter. This decides: is this worth keeping, and how strongly?
 *
 * It scores like survivalScore already thinks (which is human-shaped):
 *  - OCCURRENCE (he did/saw/went) → real memory. Full weight.
 *  - VERDICT / reaction → highest. How he FELT outlives what he did.
 *  - PERSON / PLACE / PLAN / CONSEQUENCE present → salient, keep.
 *  - SUGGESTION (Vision proposed, he hasn't acted) → provisional, low weight,
 *    left to decay unless a later occurrence promotes it. Logging suggestions
 *    as fact would poison the recall that feeds prediction — the brain must
 *    learn from what he DID, not what it guessed.
 *  - NOVELTY → a first-time thing is worth more than the hundredth identical one
 *    (dedup against recent memory so "same scene" / repeated asks fade).
 *  - Otherwise → evaporates (returns null, nothing stored).
 *
 * event = { kind, text, occurred?:bool, verdict?:bool, person?, place?, plan?,
 *           consequence?, at?, coords? }
 * Returns the stored entry or null (didn't clear the bar).
 */
const CONSIDER_STOP = /\b(weather|time|what time|how do you say|translate|thanks|thank you|hello|hi|test|ok|okay)\b/i;
function consider(uid, event = {}) {
  const text = String(event.text || "").trim();
  if (!text || text.length < 4) return null;

  // Suggestions Vision made are NOT occurrences — hold them faintly, never as fact.
  if (event.suggestion && !event.occurred) return null;   // decays unheard unless acted on later

  let score = 0;
  // Base salience by nature of the event
  if (event.verdict) score += 55;                 // a reaction — the most durable human memory
  if (event.occurred) score += 25;                // it actually happened
  if (event.consequence) score += 30;             // money, safety, a commitment
  if (event.person) score += 20;                  // people are memorable
  if (event.place) score += 15;                   // grounded in a place
  if (event.plan) score += 20;                    // future intent is durable
  // Trivia filter — ambient chatter that reveals nothing durable
  if (CONSIDER_STOP.test(text) && !event.occurred && !event.person) return null;

  // Novelty: don't re-log something near-identical seen in the last day.
  const mem = STORE.mem[uid] || [];
  const dayAgo = Date.now() - 86400000;
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 4).slice(0, 6);
  const echoes = mem.filter(m => (m.at || 0) > dayAgo &&
    words.length && words.filter(w => String(m.t || "").toLowerCase().includes(w)).length >= Math.min(3, words.length)).length;
  if (echoes >= 1 && !event.verdict && !event.consequence) return null;  // already have today's version

  // Below the bar → let it evaporate, like a glance you don't recall by dinner.
  // A bare occurrence with nothing else (no place, person, consequence, plan,
  // verdict) is a "saw a wall" — real but not worth keeping. Needs a companion.
  const hasAnchor = event.verdict || event.consequence || event.person || event.place || event.plan;
  if (!hasAnchor && score < 40) return null;
  if (score < 20) return null;

  // Clear → store with a weight proportional to salience (feeds survivalScore's tiers).
  return remember(uid, text, { kind: event.kind || "ambient", weight: score, at: event.at, coords: event.coords });
}
function recallFor(uid, text, limit) {
  const mem = STORE.mem[uid] || [];
  if (!mem.length) return [];
  // Batch 68: questions about time/place should pull the life-log timeline.
  const timeish = /\b(yesterday|today|this morning|last week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|where was i|where were we|what did (i|we) do|been|visited)\b/i.test(text || "");
  // Day summaries are distilled gold — weight them above raw log lines.
  const words = String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));
  const now = Date.now();
  const scored = mem.map(m => {
    const t = String(m.t || "").toLowerCase();
    let score = 0;
    for (const w of words) if (t.includes(w)) score += 2;
    if (timeish && t.startsWith("log:")) score += 2;   // timeline questions want the timeline
    if (t.startsWith("day ")) score += timeish ? 3 : 1;  // distilled days beat raw noise
    // recency nudge so fresh memories win ties, without burying older gems
    score += Math.max(0, 1 - (now - (m.at || 0)) / (90 * 86400000));
    return { ...m, score };
  }).filter(m => m.score >= 1.5);          // must have a real keyword hit
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit || 6);
}
// The line injected into the brain's brief so EVERY skill benefits.
function recallBrief(uid, text) {
  const hits = recallFor(uid, text, 5);
  dlog(uid, "memory", `recall for "${String(text).slice(0, 40)}" -> ${hits.length} hits`, hits.map(h => h.t.slice(0, 60)));
  // Batch 100: honest uncertainty. If he's asking about HIS past and memory has
  // nothing, say so plainly instead of answering generically. Admitting a blank
  // is the most human thing an assistant can do — and it protects trust.
  if (!hits.length) {
    const personal = /\b(my|our|we|i)\b.*\b(favourite|usual|last time|before|remember|told you|said|went|ate|paid|stayed|met|booked)\b/i.test(String(text || ""))
      || /\b(what did (i|we)|where did (i|we)|when did (i|we)|who did (i|we)|did i ever)\b/i.test(String(text || ""));
    if (personal) {
      const total = (STORE.mem[uid] || []).length;
      return total < 20
        ? "YOU HAVE NO MEMORY OF THIS. Say so plainly — you're still getting to know him. Do not invent an answer or answer generically."
        : "YOU HAVE NOTHING STORED ABOUT THIS. Say honestly that he hasn't told you, or you didn't catch it. Offer to remember it now. Never guess.";
    }
    return "";
  }
  return "WHAT YOU REMEMBER THAT'S RELEVANT HERE (use naturally, only if it helps; never list it back mechanically): "
    + hits.map(h => `${when(h.at)}: ${h.t}`).join(" | ");
}

// Today's timeline in one line — used proactively in the opening brief.
// What's coming up — surfaced in the brief without being asked.
function upcomingBrief(uid) {
  const list = (STORE.bookings || {})[uid] || [];
  const now = Date.now();
  const soon = list.filter(b => b.whenISO && Date.parse(b.whenISO) > now && Date.parse(b.whenISO) - now < 172800000)
    .sort((a, b) => Date.parse(a.whenISO) - Date.parse(b.whenISO));
  if (!soon.length) return "";
  const b = soon[0];
  return `Coming up: ${b.type || "booking"} ${b.what || ""} ${b.when || ""}${b.ref ? ` (ref ${b.ref})` : ""}.`;
}
function todayShape(uid) {
  const mem = STORE.mem[uid] || [];
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const logs = mem.filter(m => m.at > since.getTime() && String(m.t).startsWith("log:"));
  if (!logs.length) return "";
  const places = [...new Set(logs.map(m => (String(m.t).match(/^log:\s*([^0-9—(]+)/) || [])[1]).filter(Boolean).map(p => p.trim()))];
  return places.length ? `Today so far: ${places.slice(0, 4).join(" → ")}.` : "";
}

// --- 🔤 ADDRESS AUTOCOMPLETE (batch 72) ---
// Type two or three letters, get real suggestions. Biased to where he is, so
// "wool" surfaces the Woolworths down the road, not one in Perth.
app.post("/autocomplete", requireAuth, async (req, res) => {
  const { q, lat, lng } = req.body || {};
  if (!GMAPS_KEY) return res.status(501).json({ error: "maps_key_missing" });
  if (!q || String(q).trim().length < 2) return res.json({ suggestions: [] });
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
    u.searchParams.set("input", String(q).slice(0, 120));
    u.searchParams.set("key", GMAPS_KEY);
    if (lat != null && lng != null) {
      // strictbounds keeps results inside the radius rather than merely
      // preferring them. Without it, "restaurant near me" still returned
      // Las Vegas and Tamil Nadu because Google treats location as a hint.
      u.searchParams.set("location", `${lat},${lng}`);
      u.searchParams.set("radius", "30000");
      u.searchParams.set("strictbounds", "true");
    } else {
      // Batch 151: no fix — but we usually know where he IS, because /arrival
      // records it. A city name beats searching the entire planet.
      const p = profileOf(uidOf(req)) || {};
      if (p.city || p.country) {
        u.searchParams.set("input", `${String(q).slice(0, 100)} ${p.city || ""} ${p.country || ""}`.trim());
      }
    }
    const j = await (await fetch(u)).json();
    const suggestions = (j.predictions || []).slice(0, 6).map(p => ({
      label: p.structured_formatting?.main_text || p.description,
      sub: p.structured_formatting?.secondary_text || "",
      value: p.description,
    }));
    res.json({ suggestions });
  } catch { res.json({ suggestions: [] }); }
});

// Scan recent mail for a confirmation matching a pending flow. This is the one
// place the handoff CAN be detected automatically — the confirmation email.


// --- 📧 HANDOVER (batch 106) ---
// Work that isn't finished shouldn't only live in Vision's memory. This writes
// up what was found — options, prices, numbers to ring, pre-filled links — and
// emails it, so he can act on it on a laptop, forward it to Jess, or come back
// to it in a week. The pending-flow follow-up still runs; this supports it.
app.post("/handover", requireAuth, async (req, res) => {
  const { context, to } = req.body || {};
  const uid = uidOf(req);
  const dest = to || ICLOUD_USER;
  if (!mailReady()) return res.status(501).json({ error: "mail_not_set_up",
    spoken: "Email isn't set up yet — add your iCloud details in Service keys and I can send these." });

  // Build from what actually happened: the conversation plus anything left open.
  const mem = STORE.mem[uid] || [];
  const recent = mem.slice(-25).map(m => m.t).join("\n");
  const pending = ((STORE.pending || {})[uid] || []).filter(p => p.state === "waiting")
    .map(p => `${p.kind}: ${p.what}`).join("; ");
  const bookings = ((STORE.bookings || {})[uid] || []).slice(-4)
    .map(b => `${b.type}: ${b.what} ${b.when || ""}${b.ref ? ` (${b.ref})` : ""}`).join("; ");

  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 1400,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    system:
      "You write a handover note for Shaun to act on later — on a laptop, or in a week. " +
      "He asked Vision to look into something and now wants it in his inbox. " +
      'JSON only: {"subject":"short and specific","intro":"one sentence on what this covers",' +
      '"items":[{"title":"what it is","detail":"prices, times, what you found — be concrete",' +
      '"link":"a real URL that opens a search or booking page already filled in, or empty",' +
      '"phone":"a real number if one is genuinely known, or empty","todo":"what he still has to do"}],' +
      '"closing":"one honest line about what you could not settle"}. ' +
      "RULES: never invent a phone number or a booking reference — leave it empty if you don't know it. " +
      "Prices are estimates unless you searched and found them; say which. " +
      "Links should be searches or booking pages pre-filled with his dates and party size, " +
      "not payment links — no one can generate those on his behalf. " +
      "Max 6 items. Write like a competent friend leaving notes, not a brochure. No markdown.",
    messages: [{ role: "user", content:
      `What he asked about: ${context || "the recent conversation"}\n\n` +
      `Recent activity:\n${recent}\n\n` +
      (pending ? `Still unfinished: ${pending}\n` : "") +
      (bookings ? `Already booked: ${bookings}` : "") }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "write_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const items = Array.isArray(p.items) ? p.items.slice(0, 6) : [];

    const esc = t => String(t || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    const html = `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;color:#1a1a2e">
      <p style="font-size:15px;line-height:1.6">${esc(p.intro)}</p>
      ${items.map((it, i) => `
        <div style="margin:18px 0;padding:16px;border-radius:12px;background:#f4f4f8;border-left:3px solid #F5A623">
          <div style="font-weight:700;font-size:16px;margin-bottom:6px">${i + 1}. ${esc(it.title)}</div>
          <div style="font-size:14px;line-height:1.6;color:#3a3a52">${esc(it.detail)}</div>
          ${it.todo ? `<div style="font-size:13px;margin-top:8px;color:#6a6a85"><b>You still need to:</b> ${esc(it.todo)}</div>` : ""}
          <div style="margin-top:12px">
            ${it.link ? `<a href="${esc(it.link)}" style="display:inline-block;padding:9px 14px;background:#F5A623;color:#1a1a2e;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;margin-right:8px">Open it →</a>` : ""}
            ${it.phone ? `<a href="tel:${esc(String(it.phone).replace(/[^\d+]/g, ""))}" style="display:inline-block;padding:9px 14px;background:#2a2a3e;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">Call ${esc(it.phone)}</a>` : ""}
          </div>
        </div>`).join("")}
      ${p.closing ? `<p style="font-size:13px;color:#6a6a85;line-height:1.6;margin-top:22px">${esc(p.closing)}</p>` : ""}
      <p style="font-size:12px;color:#9a9ab0;margin-top:26px">Prices and availability change — the links open live searches.<br>Sent by Vision.</p>
    </div>`;

    const plain = `${p.intro}\n\n` + items.map((it, i) =>
      `${i + 1}. ${it.title}\n   ${it.detail}` + (it.todo ? `\n   TO DO: ${it.todo}` : "") +
      (it.link ? `\n   ${it.link}` : "") + (it.phone ? `\n   Call: ${it.phone}` : "")).join("\n\n") +
      (p.closing ? `\n\n${p.closing}` : "");

    const r = await fetch(`http://127.0.0.1:${PORT}/mail/send`, {
      method: "POST", headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ to: dest, subject: p.subject || "From Vision", message: plain, html }),
    });
    const sent = r.ok;
    if (sent) {
      const m2 = STORE.mem[uid] = STORE.mem[uid] || [];
      m2.push({ t: `emailed handover: ${p.subject} (${items.length} things to follow up)`, at: Date.now() });
      while (m2.length > 400) m2.shift(); saveStore();
    }
    res.json({ ok: sent, subject: p.subject, count: items.length, to: dest,
      spoken: sent ? `Sent to your inbox — ${items.length} thing${items.length === 1 ? "" : "s"} with links and anything you still need to do.`
                   : "I wrote it up but couldn't send it — check the email setup in Service keys." });
  } catch { res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "write_failed" }); }
});

// --- ⏳ EXPIRY WATCH (batch 105) ---
// The highest-consequence gap in the system. Documents were stored but nothing
// watched their dates. A passport inside six months of expiry is a denied
// boarding at the airport, not an inconvenience — and Vietnam enforces it.
const EXPIRY_FIELDS = [
  { id: "passportExpiry",  label: "Passport",        warnDays: 240, rule: "Most of Asia refuses entry if your passport expires within 6 months." },
  { id: "visaExpiry",      label: "Visa",            warnDays: 30,  rule: "Overstaying is a fine and a stamp you don't want." },
  { id: "insuranceExpiry", label: "Travel insurance", warnDays: 30, rule: "Cover must span the whole trip, not just the start." },
  { id: "licenceExpiry",   label: "Driver's licence", warnDays: 60, rule: "Needed with an international permit to hire a scooter." },
  { id: "cardExpiry",      label: "Bank card",       warnDays: 60,  rule: "A card expiring mid-trip is a bad afternoon." },
];
function expiryScan(uid) {
  const d = (STORE.docs || {})[uid] || {};
  const out = [];
  for (const f of EXPIRY_FIELDS) {
    const raw = d[f.id];
    if (!raw) continue;
    const when = Date.parse(raw);
    if (isNaN(when)) continue;
    const days = Math.round((when - Date.now()) / 86400000);
    if (days < 0) out.push({ ...f, days, state: "expired", note: `${f.label} EXPIRED ${Math.abs(days)} days ago.` });
    else if (days <= f.warnDays) out.push({ ...f, days, state: days <= 30 ? "urgent" : "soon", note: `${f.label} expires in ${days} days. ${f.rule}` });
  }
  return out.sort((a, b) => a.days - b.days);
}
function expiryBrief(uid) {
  const e = expiryScan(uid);
  if (!e.length) return "";
  const worst = e[0];
  return `DOCUMENT WARNING — raise this if travel comes up at all: ${worst.note}`;
}
app.post("/expiry", requireAuth, (req, res) => res.json({ expiries: expiryScan(uidOf(req)), fields: EXPIRY_FIELDS }));

// --- 🧭 PROCEDURAL MEMORY (batch 105) ---
// Facts are "he loves Made's". Procedure is "he checks a price before agreeing,
// books flights before hotels, wants directions sent not spoken". The field
// calls this the next frontier and the tooling is still early everywhere.
// It's cheap here because the sequence data is already in the pool.
async function learnProcedure(uid) {
  const mem = STORE.mem[uid] || [];
  const recent = mem.filter(m => Date.now() - m.at < 30 * 86400000 && !isCore(m));
  if (recent.length < 60) return { skipped: "not enough activity" };
  const trail = recent.slice(-140).map(m => `${new Date(m.at).toISOString().slice(5, 16)} ${m.t}`).join("\n").slice(0, 6500);
  const known = mem.filter(m => String(m.t).startsWith("howto: ")).map(m => m.t).join(" | ").slice(0, 800);
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 500,
    system:
      "You extract HOW someone does things — their working habits — not what they like. " + NO_INVENT +
      'JSON only: {"procedures":["short present-tense habits, under 14 words each"]}. ' +
      "Look for ORDER (what he does before what), CONDITIONS (what he always checks first), " +
      "and PREFERENCES OF METHOD (how he wants things delivered). " +
      "Examples of the right shape: 'checks a price against past spending before agreeing', " +
      "'books the flight before looking at accommodation', 'wants directions opened not read aloud'. " +
      "Only include a habit the trail shows at least twice. Max 6. No markdown. If nothing repeats, return empty.",
    messages: [{ role: "user", content: `Already known: ${known || "nothing"}\n\nWhat he's done recently:\n${trail}` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return { skipped: "model_failed" };
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const found = (Array.isArray(p.procedures) ? p.procedures : []).slice(0, 6);
    let added = 0;
    for (const proc of found) {
      if (!mem.some(m => String(m.t).startsWith("howto: ") && m.t.toLowerCase().includes(String(proc).toLowerCase().slice(0, 20)))) {
        remember(uid, `howto: ${proc}`, { kind: "howto", save: false }); added++;
      }
    }
    if (added) saveStore();
    dlog(uid, "memory", `procedures learned: ${added}`, found.slice(0, 3));
    return { learned: found, added };
  } catch { return { skipped: "parse_failed" }; }
}
function procedureBrief(uid) {
  const p = (STORE.mem[uid] || []).filter(m => String(m.t).startsWith("howto: "))
    .slice(-8).map(m => m.t.slice(7));
  return p.length ? `HOW HE LIKES THINGS DONE (follow these without being told): ${p.join(" · ")}` : "";
}
app.post("/procedures", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  if ((req.body || {}).action === "list") {
    return res.json({ procedures: (STORE.mem[uid] || []).filter(m => String(m.t).startsWith("howto: ")).map(m => ({ t: m.t.slice(7), at: m.at })) });
  }
  if ((req.body || {}).action === "forget" && req.body.text) {
    const q = String(req.body.text).toLowerCase();
    const before = (STORE.mem[uid] || []).length;
    STORE.mem[uid] = (STORE.mem[uid] || []).filter(m => !(String(m.t).startsWith("howto: ") && m.t.toLowerCase().includes(q)));
    saveStore();
    return res.json({ removed: before - STORE.mem[uid].length });
  }
  res.json(await learnProcedure(uid));
});

// --- 🔑 PROFILE RECOVERY (batch 104) ---
// The user id is per-device. A new phone gets a new id, so a lifetime of memory
// would sit on the server invisible — present, but belonging to a stranger.
// This lets a device reclaim an existing profile. Nothing is ever merged
// silently: he sees what he's claiming before it happens.
app.post("/recover", requireAuth, (req, res) => {
  const { action, code, newUid } = req.body || {};
  STORE.recovery = STORE.recovery || {};

  if (action === "issue") {
    // A short, sayable code tied to the profile he's using right now.
    const uid = uidOf(req);
    let existing = Object.entries(STORE.recovery).find(([, v]) => v === uid);
    if (existing) return res.json({ code: existing[0] });
    // Batch 139 audit: 16 words squared plus a two-digit number is only 23,040
    // combinations. Behind the 120/min rate limit that's 31% of the space in an
    // hour and the whole thing inside a day — and a recovery code IS the entire
    // profile: every memory, every job report, his wife's shared lists.
    // A wider list, THREE words and a four-digit number takes it past 10^11,
    // while staying something he can read down a phone line.
    const words = [
      "amber", "harbour", "compass", "lantern", "meridian", "cedar", "quarry", "tide",
      "ember", "atlas", "pike", "willow", "cove", "flint", "orchard", "beacon",
      "anchor", "brook", "canyon", "delta", "everest", "fathom", "granite", "hollow",
      "island", "jetty", "kelp", "lagoon", "marsh", "north", "outpost", "prairie",
      "quartz", "ridge", "summit", "thicket", "upland", "valley", "warren", "yonder",
      "basalt", "cinder", "dune", "estuary", "fjord", "glacier", "heath", "inlet",
    ];
    const pick = () => words[crypto.randomInt(words.length)];   // not Math.random
    let c;
    do { c = `${pick()}-${pick()}-${pick()}-${crypto.randomInt(1000, 10000)}`; }
    while (STORE.recovery[c]);
    STORE.recovery[c] = uid;
    saveStore();
    return res.json({ code: c });
  }

  if (action === "preview" && code) {
    // Show what's behind the code BEFORE claiming it — no silent takeovers.
    const target = STORE.recovery[String(code).toLowerCase().trim()];
    if (!target) return res.status(404).json({ error: "no_such_code" });
    const mem = STORE.mem[target] || [];
    const prof = STORE.profiles[target] || {};
    return res.json({
      found: true, name: prof.name || "unknown",
      memories: mem.length, core: mem.filter(isCore).length,
      oldest: mem.length ? mem[0].at : null,
      watchers: ((STORE.watchers || {})[target] || []).length,
      bookings: ((STORE.bookings || {})[target] || []).length,
    });
  }

  if (action === "claim" && code && newUid) {
    const target = STORE.recovery[String(code).toLowerCase().trim()];
    if (!target) return res.status(404).json({ error: "no_such_code" });
    if (target === newUid) return res.json({ ok: true, already: true });
    // Move every per-user collection across to the new device id.
    const buckets = ["profiles", "briefs", "flags", "mem", "watchers", "results", "seen",
                     "convos", "bookings", "docs", "pending", "bugs", "daySummaries",
                     "budgets", "lastDistil", "spend", "smsHold", "smsSeen", "vmHold", "vmSeen", "conductorMute", "recovery",
                     "calPrefs", "calCache", "calSeen", "calHold", "calToday", "calPending", "jobs",
                     "convoLive", "convoLangs", "phrases",
                     "scenes", "timelines", "dismissed", "followLog", "trips"];
    let moved = 0;
    for (const b of buckets) {
      if (STORE[b] && STORE[b][target] !== undefined) {
        STORE[b][newUid] = STORE[b][target];
        delete STORE[b][target];
        moved++;
      }
    }
    STORE.recovery[String(code).toLowerCase().trim()] = newUid;   // code follows the profile
    saveStore();
    dlog(newUid, "memory", `profile recovered from ${String(target).slice(0, 8)} — ${moved} collections`);
    const mem = STORE.mem[newUid] || [];
    return res.json({ ok: true, moved, memories: mem.length, name: (STORE.profiles[newUid] || {}).name || "" });
  }
  res.status(400).json({ error: "bad action" });
});

// --- 💰 BUDGET & PRESSURE (batch 101) ---
// A number nobody set means nothing. Set a monthly budget and the spend figure
// becomes a gauge — with warnings that arrive WITH a fix, not just a fright.
app.post("/budget", requireAuth, (req, res) => {
  const { action, monthlyUSD } = req.body || {};
  const uid = uidOf(req);
  STORE.budgets = STORE.budgets || {};
  if (action === "set") {
    const v = Number(monthlyUSD);
    if (v > 0) STORE.budgets[uid] = v; else delete STORE.budgets[uid];
    saveStore();
    return res.json({ ok: true, monthlyUSD: STORE.budgets[uid] || null });
  }
  res.json({ monthlyUSD: STORE.budgets[uid] || null });
});

// One place that answers "how am I doing?" for both money and memory.
function pressureGauges(uid) {
  const sp = STORE.spend || {};
  const month = new Date().toISOString().slice(0, 7);
  let spent = 0;
  for (const [d, v] of Object.entries(sp)) if (d.startsWith(month)) spent += v;
  const budget = (STORE.budgets || {})[uid] || 0;

  // How far through the month are we? Spending 50% by day 15 is fine;
  // spending 50% by day 3 is not. Pace matters more than the total.
  const now = new Date();
  const daysIn = now.getDate();
  const daysTotal = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthPct = daysIn / daysTotal;
  const spendPct = budget ? spent / budget : 0;
  // Floor the divisor rather than disabling pace early in the month: a big
  // spend on day 2 is the most important thing to catch, not the least.
  const pace = budget ? spendPct / Math.max(monthPct, 0.05) : 1;

  const mem = STORE.mem[uid] || [];
  const memPct = mem.length / 400;
  const lastTidy = ((STORE.lastDistil || {})[uid] || {}).at || 0;
  const tidyDays = lastTidy ? (Date.now() - lastTidy) / 86400000 : 999;

  return {
    spend: {
      usd: Math.round(spent * 10000) / 10000, budget,
      pct: Math.round(spendPct * 100),
      pace: Math.round(pace * 100) / 100,
      // Pace decides, not the raw figure: half the budget at mid-month is on
      // track; half of it on day three is not.
      state: !budget ? "unset" : spendPct >= 0.9 ? "red" : (pace > 1.4 && spendPct >= 0.35) ? "amber" : "green",
    },
    memory: {
      total: mem.length, core: mem.filter(isCore).length,
      pct: Math.round(memPct * 100),
      state: memPct >= 0.9 ? "red" : memPct >= 0.7 ? "amber" : "green",
      needsTidy: memPct > 0.7 && tidyDays > 2,
    },
  };
}
app.post("/gauges", requireAuth, (req, res) => res.json(pressureGauges(uidOf(req))));

// A warning is only useful if it comes with something you can DO about it.
function pressureBrief(uid) {
  const g = pressureGauges(uid);
  const out = [];
  if (g.spend.state === "red") out.push(`SPEND: he's at ${g.spend.pct}% of his monthly budget. If it comes up, offer to run leaner (battery saver forces the cheap model, fewer watchers, less ambient capture).`);
  else if (g.spend.state === "amber") out.push(`SPEND: ${g.spend.pct}% of budget used and running ahead of pace. Mention only if he asks about cost.`);
  if (g.memory.state === "red") out.push(`MEMORY: nearly full (${g.memory.pct}%). Suggest a tidy-up — it promotes what matters and prunes noise.`);
  return out.join(" | ");
}

// --- 🕰️ ON THIS DAY (batch 100) ---
// Every memory is timestamped and nothing ever looked back. Real memory
// resurfaces on its own — "a year ago today you were in Hanoi" — and that's the
// moment an assistant stops feeling like software.
function onThisDay(uid) {
  const mem = STORE.mem[uid] || [];
  if (!mem.length) return null;
  const now = new Date(), day = 86400000;
  // Look at the same calendar day across earlier periods, widening as needed.
  const windows = [365, 180, 90, 30];
  for (const back of windows) {
    const target = now.getTime() - back * day;
    const hits = mem.filter(m => Math.abs(m.at - target) < 1.5 * day)
      .filter(m => /^(verdict|loved place|moment|conversation|day \d{4}|saw:|booking)/.test(String(m.t)));
    if (hits.length) {
      // Prefer the one that mattered most.
      hits.sort((a, b) => survivalScore(b, mem) - survivalScore(a, mem));
      const h = hits[0];
      const label = back >= 365 ? "A year ago" : back >= 180 ? "Six months ago"
                  : back >= 90 ? "Three months ago" : "A month ago";
      return { at: h.at, label, text: String(h.t).replace(/^[a-z ]+:\s*/i, "").slice(0, 160) };
    }
  }
  return null;
}
app.post("/onthisday", requireAuth, (req, res) => res.json({ memory: onThisDay(uidOf(req)) }));

// --- ❤️ SIGNIFICANCE (batch 99) ---
// A brilliant meal and a routine coffee were being stored identically. People
// don't remember like that — they remember what MATTERED. This attaches a
// verdict to whatever he was actually doing, so later Vision can say "you loved
// that place" instead of "you said delicious on Tuesday".
const GOOD = /\b(delicious|amazing|brilliant|beautiful|lovely|great|excellent|perfect|loved (it|that)|so good|the best|incredible|unreal)\b/i;
const BAD  = /\b(terrible|awful|rubbish|horrible|disgusting|worst|hated (it|that)|not great|disappointing|overpriced|rip.?off)\b/i;
const MEH  = /\b(alright|okay|ok|fine|average|nothing special|meh)\b/i;

app.post("/verdict", requireAuth, async (req, res) => {
  const { text, subject } = req.body || {};
  const uid = uidOf(req);
  const t = String(text || "");
  const sentiment = BAD.test(t) ? "bad" : GOOD.test(t) ? "good" : MEH.test(t) ? "mixed" : null;
  if (!sentiment) return res.json({ noted: false });

  // What was he actually talking about? Prefer what he named, else the most
  // recent thing he did — a place, a meal, a moment.
  let about = String(subject || "").trim();
  if (!about) {
    const mem = STORE.mem[uid] || [];
    const recent = mem.slice(-12).reverse();
    const hit = recent.find(m => /^(loved place|nearby|findfood|menu read|moment|saw:|booking|navigate)/.test(String(m.t)));
    if (hit) {
      about = String(hit.t).replace(/^[a-z ]+:?\s*/i, "").split(/[—\n\-]/)[0].slice(0, 60).trim();
    }
  }
  if (!about) return res.json({ noted: false, why: "nothing to attach it to" });

  const mem = STORE.mem[uid] = STORE.mem[uid] || [];
  const line = sentiment === "good" ? `verdict: LOVED ${about} — "${t.slice(0, 60)}"`
             : sentiment === "bad"  ? `verdict: DISLIKED ${about} — "${t.slice(0, 60)}" (do not suggest again)`
             : `verdict: mixed on ${about}`;
  remember(uid, line, { kind: "verdict" });
  saveStore();
  dlog(uid, "memory", `verdict ${sentiment}: ${about}`.slice(0, 60));
  res.json({ noted: true, sentiment, about });
});

// Verdicts are strong signals — they belong in every brief, and a disliked
// thing must never be recommended again.
function verdictBrief(uid) {
  const v = (STORE.mem[uid] || []).filter(m => String(m.t).startsWith("verdict: ")).slice(-8);
  if (!v.length) return "";
  const loved = v.filter(m => /LOVED/.test(m.t)).map(m => m.t.replace(/^verdict: LOVED /, "").split(" — ")[0]);
  const disliked = v.filter(m => /DISLIKED/.test(m.t)).map(m => m.t.replace(/^verdict: DISLIKED /, "").split(" — ")[0]);
  return [
    loved.length ? `THINGS HE LOVED (lean on these): ${loved.join(", ")}` : "",
    disliked.length ? `THINGS HE DISLIKED — never suggest these again: ${disliked.join(", ")}` : "",
  ].filter(Boolean).join(" | ");
}

// --- 🔮 PATTERN ANTICIPATION (batch 98) ---
// Reacting to a booking tomorrow is scheduling. Real anticipation is noticing
// what REPEATS and what's MISSING — he eats around seven and it's quarter past;
// he photographed a menu two days ago and never went; he logs spend daily and
// hasn't today. The data is already in the pool; this reads it.
function patternScan(uid) {
  const mem = STORE.mem[uid] || [];
  if (mem.length < 40) return [];
  const now = Date.now(), hour = new Date().getHours(), day = 86400000;
  const recent = mem.filter(m => now - m.at < 30 * day);
  const out = [];

  // 1. TIME-OF-DAY HABITS — what does he usually do around now?
  const nearNow = recent.filter(m => {
    const h = new Date(m.at).getHours();
    return Math.abs(h - hour) <= 1 && now - m.at > 2 * day;
  });
  const verbs = {};
  for (const m of nearNow) {
    const v = (String(m.t).match(/^(\w+)/) || [])[1];
    if (v && !/^(log|core|day|plan)$/.test(v)) verbs[v] = (verbs[v] || 0) + 1;
  }
  const habit = Object.entries(verbs).sort((a, b) => b[1] - a[1])[0];
  if (habit && habit[1] >= 3) {
    const doneToday = recent.some(m => now - m.at < 8 * 3600000 && String(m.t).startsWith(habit[0]));
    if (!doneToday) out.push({ kind: "habit", note: `Around this hour he usually does "${habit[0]}" (${habit[1]} times lately) and hasn't today.` });
  }

  // Batch 113 audit: the scanner predates the calendar/job layer and was blind
  // to it. A job closed without a report written is the single most actionable
  // loose end he has — it's money owed and it expires from his own recall fast.
  const jobLines = recent.filter(m => /^job \d{6,}/.test(String(m.t)));
  const reported = new Set(jobLines.filter(m => /: - /.test(String(m.t))).map(m => (String(m.t).match(/^job (\d+)/) || [])[1]));
  const captured = [...new Set(jobLines.map(m => (String(m.t).match(/^job (\d+)/) || [])[1]).filter(Boolean))];
  const unwritten = captured.filter(j => !reported.has(j));
  if (unwritten.length) {
    out.push({ kind: "job", note: `Job${unwritten.length > 1 ? "s" : ""} ${unwritten.slice(0, 3).join(", ")} logged but no service description written up yet — that's what closes it.` });
  }

  // 2. LOOSE ENDS — things he looked at and never acted on.
  const looked = recent.filter(m => /^(menu read|saw:|moment|nearby|log:.*—)/.test(String(m.t)) && now - m.at < 5 * day);
  for (const m of looked.slice(-6)) {
    const subject = String(m.t).replace(/^[a-z ]+:?/i, "").slice(0, 40).trim();
    if (!subject || subject.length < 6) continue;
    const words = subject.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4).slice(0, 3);
    if (!words.length) continue;
    const followed = recent.some(o => o.at > m.at &&
      /^(booking|completed|logspend|receipt|favourite|loved)/.test(String(o.t)) &&
      words.some(w => String(o.t).toLowerCase().includes(w)));
    if (!followed) { out.push({ kind: "loose-end", note: `He looked at "${subject}" ${Math.round((now - m.at) / day)} days ago and never followed it up.` }); break; }
  }

  // 3. REPEATS — a place or subject he keeps returning to.
  const counts = {};
  for (const m of recent) {
    for (const w of String(m.t).toLowerCase().split(/[^a-z]+/)) {
      if (w.length > 5 && !/^(vision|memory|because|through|nearby|around)$/.test(w)) counts[w] = (counts[w] || 0) + 1;
    }
  }
  const top = Object.entries(counts).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1])[0];
  if (top) out.push({ kind: "repeat", note: `"${top[0]}" keeps coming up (${top[1]} times) — it clearly matters to him.` });

  // 4. GONE QUIET — a routine that has stopped.
  const kinds = ["logspend", "log:", "moment", "conversation"];
  for (const k of kinds) {
    const all = recent.filter(m => String(m.t).startsWith(k));
    if (all.length >= 6) {
      const last = all[all.length - 1];
      const gapDays = (now - last.at) / day;
      const typical = (last.at - all[0].at) / day / all.length;
      if (typical > 0 && gapDays > typical * 4 && gapDays > 2) {
        out.push({ kind: "stopped", note: `He used to "${k.replace(":", "")}" every ${typical.toFixed(1)} days and hasn't for ${gapDays.toFixed(0)}.` });
        break;
      }
    }
  }
  return out.slice(0, 3);
}
// Patterns ride in the brief so the brain can raise them naturally — as an
// observation, never a nag.
function patternBrief(uid) {
  const p = patternScan(uid);
  if (!p.length) return "";
  return "PATTERNS YOU'VE NOTICED (raise at most ONE, only if it fits the conversation, phrased as an observation not a reminder): "
    + p.map(x => x.note).join(" | ");
}
app.post("/patterns", requireAuth, (req, res) => res.json({ patterns: patternScan(uidOf(req)) }));

// --- 🧪 DISTILLATION (batch 94) ---
// Memory fills in about four days of real use, then silently discards the
// OLDEST facts — the first place he loved, the first deal he struck. This is
// the fix: a nightly pass that promotes patterns into permanent facts, lets
// unreinforced noise fade, and keeps the pool lean enough to stay fast.
//
// Three tiers, following how the good systems do it:
//   CORE      — durable truths about him. Never expire. Always in the brief.
//   EPISODIC  — what happened. Decays unless reinforced.
//   NOISE     — routine chatter. Pruned first.
const CORE_PREFIX = "core: ";

function memAge(m) { return (Date.now() - (m.at || 0)) / 86400000; }        // days
function isCore(m) { return String(m.t || "").startsWith(CORE_PREFIX); }

// Score what deserves to survive. Reinforcement beats recency: something he
// keeps coming back to matters more than something that merely happened today.
function survivalScore(m, all) {
  if (isCore(m)) return 1e6;
  const t = String(m.t || "").toLowerCase();
  let s = 0;
  // Baseline salience from the gate: ambient events (vision/chat/nav) don't match
  // the prefix rules below, so without this they'd score ~0 and prune instantly.
  // consider() already judged how salient they were — honour it as the floor.
  if (typeof m.weight === "number") s += m.weight;
  // things he chose to keep
  if (/^howto: /.test(t)) s += 60;        // process knowledge is the hardest to relearn
  if (/^verdict: /.test(t)) s += 55;      // how he FELT outlives what he did
  if (/^(loved place|favourite|remember|note to self|reminder|booking|document)/.test(t)) s += 40;
  if (/^conversation with|agreed|commitment/.test(t)) s += 35;
  // Batch 111 audit: 109/110 write lines survivalScore had no weight for.
  // A job report is the hardest thing here to recreate — it's work he was paid
  // for and can't be reconstructed from the VPN-gated CRM — so it ranks with
  // process knowledge, not below life-log noise.
  if (/^job \d{6,}/.test(t)) s += 58;
  if (/^ticked off: /.test(t)) s += 12;   // follow-through signal, cheap to lose
  if (/^calendar: /.test(t)) s += 18;
  if (/^day \d{4}-/.test(t)) s += 30;                       // distilled day summaries
  if (/^(completed|abandoned):/.test(t)) s += 20;            // follow-through signal
  if (/^(moment|saw:|read:|receipt:)/.test(t)) s += 15;
  if (/^log:/.test(t)) s += 2;                              // life-log breadcrumbs are cheap
  // reinforcement: how often does this SUBJECT recur?
  // Batch 114 audit: the prefix word ("verdict", "booking", "conversation")
  // is itself long, so every verdict echoed every other verdict and the boost
  // flattened across the whole category. Strip the prefix before matching so
  // echoes measure the subject, not the kind.
  const subject = t.replace(/^(core|howto|verdict|loved place|favourite|remember|note to self|reminder|booking|document|conversation with|day \d{4}-\d{2}-\d{2}|completed|abandoned|moment|saw|read|receipt|log|job \d+|ticked off|calendar)\b[:\s]*/i, "");
  const words = subject.split(/[^a-z0-9]+/).filter(w => w.length > 4).slice(0, 6);
  let echoes = 0;
  for (const other of all) {
    if (other === m) continue;
    const ot = String(other.t || "").toLowerCase();
    if (words.some(w => ot.includes(w))) echoes++;
  }
  // Batch 114 audit: echoes added a flat +40 max, which is more than the base
  // weight of everything except howto/job. Thirty near-identical "log: walked
  // to the market" lines therefore outranked a unique job report — repetition
  // was beating value. Reinforcement should AMPLIFY what a memory is already
  // worth, not substitute for it, so it's now proportional and capped.
  const echoBoost = Math.min(echoes, 10) / 10;          // 0..1
  s += s * echoBoost * 0.5;                             // at most +50% of its OWN weight
  if (/^log:/.test(t)) s = Math.min(s, 12);             // breadcrumbs stay breadcrumbs
  // age penalty, gentler on the valuable kinds
  s -= Math.min(memAge(m), 120) * (s > 30 ? 0.15 : 0.6);
  return s;
}

async function distil(uid) {
  const mem = STORE.mem[uid] || [];
  if (mem.length < 120) return { skipped: "not enough to distil" };
  const recent = mem.filter(m => !isCore(m) && memAge(m) <= 14);
  if (recent.length < 40) return { skipped: "too little recent activity" };

  // 1. PROMOTE — ask the model what has become durably TRUE about him.
  let promoted = [];
  try {
    const sample = recent.slice(-160).map(m => `${when(m.at)}: ${m.t}`).join("\n").slice(0, 7000);
    const existing = mem.filter(isCore).map(m => m.t.slice(CORE_PREFIX.length)).join(" | ").slice(0, 1200);
    const body = {
      model: "claude-haiku-4-5-20251001", max_tokens: 600,
      system:
        "You distil an assistant's raw memory into durable facts about its user. " + NO_INVENT +
      'JSON only: {"facts":["short present-tense facts worth keeping forever"]}. ' +
        "A fact qualifies ONLY if the raw memory shows it repeatedly or he stated it deliberately: " +
        "preferences, people, places he returns to, restrictions, habits, how he likes things done. " +
        "NOT one-offs, NOT events, NOT anything he did once. Max 8 facts, each under 15 words. " +
        "Do not repeat facts already known. If nothing qualifies, return an empty list. No markdown.",
      messages: [{ role: "user", content: `Already known: ${existing || "nothing yet"}\n\nRaw memory:\n${sample}` }],
    };
    const { status, text } = await callClaude(body);
    if (status === 200) {
      const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
      promoted = (Array.isArray(p.facts) ? p.facts : []).slice(0, 8).filter(f => String(f).trim().length > 3);
    }
  } catch {}
  for (const f of promoted) {
    if (!mem.some(m => isCore(m) && m.t.toLowerCase().includes(String(f).toLowerCase().slice(0, 25)))) {
      remember(uid, CORE_PREFIX + f, { kind: "core", save: false });
    }
  }

  // 2. PRUNE — drop the weakest, but only once we're actually near the cap.
  let pruned = 0;
  if (mem.length > 300) {
    const scored = mem.map(m => ({ m, s: survivalScore(m, mem) })).sort((a, b) => b.s - a.s);
    const keep = scored.slice(0, 280).map(x => x.m);
    pruned = mem.length - keep.length;
    // preserve original chronology so recall's recency maths still works
    keep.sort((a, b) => (a.at || 0) - (b.at || 0));
    STORE.mem[uid] = keep;
  }
  STORE.lastDistil = STORE.lastDistil || {};
  STORE.lastDistil[uid] = { at: Date.now(), promoted: promoted.length, pruned };
  saveStore();
  dlog(uid, "memory", `distilled: +${promoted.length} core facts, -${pruned} pruned`, promoted.slice(0, 3));
  return { promoted, pruned, size: (STORE.mem[uid] || []).length };
}

// Core facts ride in EVERY brief — they're what make advice feel personal.
function coreBrief(uid) {
  const core = (STORE.mem[uid] || []).filter(isCore).slice(-12).map(m => m.t.slice(CORE_PREFIX.length));
  return core.length ? `WHAT YOU KNOW TO BE TRUE ABOUT HIM: ${core.join(" · ")}` : "";
}

app.post("/distil", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  if ((req.body || {}).action === "status") {
    const mem = STORE.mem[uid] || [];
    return res.json({
      total: mem.length, core: mem.filter(isCore).length,
      last: (STORE.lastDistil || {})[uid] || null,
      facts: mem.filter(isCore).slice(-12).map(m => m.t.slice(CORE_PREFIX.length)),
    });
  }
  if ((req.body || {}).action === "forget" && req.body.fact) {
    const q = String(req.body.fact).toLowerCase();
    const before = (STORE.mem[uid] || []).length;
    STORE.mem[uid] = (STORE.mem[uid] || []).filter(m => !(isCore(m) && m.t.toLowerCase().includes(q)));
    saveStore();
    return res.json({ removed: before - STORE.mem[uid].length });
  }
  const out = await distil(uid);
  res.json(out);
});

// Nightly sweep for everyone, plus a catch-up 5 min after boot.
setInterval(() => once("distil", async () => {
  for (const uid of Object.keys(STORE.mem || {})) {
    await distil(uid).catch(() => {});
    await learnProcedure(uid).catch(() => {});
  }
}), 86400000);
setTimeout(() => { for (const uid of Object.keys(STORE.mem || {})) distil(uid).catch(() => {}); }, 300000);

// --- 🐞 BUG LOG (batch 92) ---
// He finds bugs I can't — screenshots have caught fourteen so far. This turns
// "the orb looked wrong" into a snapshot I can actually act on, and triages
// known limits so he stops sending me things that aren't broken.
app.post("/bug", requireAuth, async (req, res) => {
  const { action, report, snapshot, id } = req.body || {};
  const uid = uidOf(req);
  STORE.bugs = STORE.bugs || {};
  const list = STORE.bugs[uid] = STORE.bugs[uid] || [];

  if (action === "log") {
    const b = { id: "bug" + Date.now(), at: Date.now(), report: String(report || "").slice(0, 500),
                snapshot: snapshot || {}, status: "open" };
    // Triage: is this a known limit, or something genuinely broken?
    try {
      const body = {
        model: "claude-haiku-4-5-20251001", max_tokens: 320,
        system:
          "You triage bug reports for Vision, a web-based AI travel companion (Safari on iPhone, Node server on Render). " +
          "KNOWN HARD LIMITS that are NOT bugs: cannot run in the background or listen when closed; cannot read Safari " +
          "history, battery, or Bluetooth; cannot tap Apple Pay or pay for anything; cannot phone a human; timers only " +
          "ring while open; no push notifications; cannot see inside other apps; live location needs the screen on. " +
          'JSON only: {"verdict":"known-limit|likely-bug|needs-info","spoken":"one honest sentence back to him",' +
          '"forClaude":"one line describing what to investigate, or empty if it is a known limit"}. No markdown.',
        messages: [{ role: "user", content: `He reports: "${report}"\nContext: ${JSON.stringify(snapshot || {}).slice(0, 900)}` }],
      };
      const { status, text } = await callClaude(body);
      if (status === 200) {
        const raw = (JSON.parse(text).content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
        const t = JSON.parse(raw.replace(/```json|```/g, "").trim());
        b.verdict = t.verdict; b.spoken = t.spoken; b.forClaude = t.forClaude;
      }
    } catch {}
    list.push(b); while (list.length > 60) list.shift();
    saveStore();
    dlog(uid, "errors", `bug logged: ${String(report).slice(0, 60)}`, b.verdict || "");
    return res.json({ ok: true, bug: b });
  }
  if (action === "list") return res.json({ bugs: list.filter(b => b.status === "open").slice(-20).reverse(), total: list.length });
  if (action === "close" && id) {
    const b = list.find(x => x.id === id); if (b) { b.status = "fixed"; b.closedAt = Date.now(); saveStore(); }
    return res.json({ ok: true });
  }
  if (action === "clear") { STORE.bugs[uid] = list.filter(b => b.status !== "fixed"); saveStore(); return res.json({ ok: true }); }
  if (action === "export") {
    // One block, formatted for pasting straight into a conversation with me.
    const open = list.filter(b => b.status === "open");
    const lines = open.map((b, i) => {
      const s2 = b.snapshot || {};
      return `${i + 1}. [${new Date(b.at).toLocaleString("en-AU")}] ${b.report}\n` +
        `   verdict: ${b.verdict || "untriaged"}${b.forClaude ? ` — ${b.forClaude}` : ""}\n` +
        `   build: ${s2.build || "?"} | skill: ${s2.lastSkill || "-"} | theme: ${s2.theme || "-"} | orb: ${s2.orb || "-"}\n` +
        `   said: ${s2.lastUser || "-"}\n   replied: ${String(s2.lastReply || "-").slice(0, 160)}` +
        (s2.diag ? `\n   diag: ${String(s2.diag).slice(0, 300)}` : "");
    }).join("\n\n");
    return res.json({ text: open.length ? `VISION BUG LOG — ${open.length} open\n\n${lines}` : "No open bugs logged.", count: open.length });
  }
  res.status(400).json({ error: "bad action" });
});

// --- 🎯 ORCHESTRATOR (batch 89) ---
// One command, a whole journey. Vision plans the steps, runs what it can, and
// STOPS to ask only where a real choice exists or where it must hand over.
// The judgement that matters: decide vs ask. Guessing his dinner is rude;
// asking which route to take is worse.
app.post("/plan", requireAuth, async (req, res) => {
  const { goal, place, country } = req.body || {};
  if (!goal) return res.status(400).json({ error: "goal required" });
  const uid = uidOf(req);
  const mem = recallFor(uid, goal, 6).map(m => `${when(m.at)}: ${m.t}`).join(" | ");
  // Favourites and loved places matter most for "my favourite" / "the usual".
  const loved = ((STORE.mem[uid] || []).filter(m => /loved place|favourite/i.test(String(m.t)))
    .slice(-5).map(m => m.t).join(" | "));
  const prof = profileOf(uid);
  const core = coreBrief(uid);
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 700,
    system:
      "You plan a short journey for a traveller's assistant. Reply JSON ONLY: " +
      '{"spoken":"one sentence saying what you\'re about to do","steps":[{"skill":"skill name","args":{},"why":"3-6 words",' +
      '"mode":"auto|ask|handoff","question":"only if mode=ask — what to ask him","options":[{"label":"short","value":"what to use"}]}]}. ' +
      "Available skills — use ONLY these: " +
      "FIND & GO: nearby, findfood, navigate, transit, ride, unlost, backto, rememberspot, meetmiddle, whereis. " +
      "EAT & BUY: menu, allergy, booktable, logspend, scamcheck, gooddeal, currency, splitbill, favourite. " +
      "PLAN & TRAVEL: tripplan, tripday, tripbudget, packlist, activities, stay, flightsearch, flight, esim, arrival, itinerary, planday, bookings. " +
      "SEE & READ: capture, livelook, landmark, seenrecall, readpage, converse, sayphrase. " +
      "REMEMBER: memory, dayview, lifelog, debrief, journal, savechat, recallchat, docs, spend. " +
      "TELL PEOPLE: whatsapp, tellpartner, onmyway, text, call, sharepin, livelocation, couplespend, sharedmoments. " +
      "LATER: watcher, timer. OTHER: weather, etiquette, safety, survival, music, mailbrief, readtexts, orderupdate, status. " +
      "TIME-SHIFTED STEPS: if something should happen LATER (leave at 6:30, check in tomorrow, " +
      "remind him the day before), use the watcher or timer skill with the time in args — do NOT try to do it now. " +
      "MODE RULES — this is the important part: " +
      "'auto' = do it now without asking (looking things up, checking weather, reading a menu, logging something). " +
      "'ask' = a genuine choice only he can make (which restaurant, what time, how many people, spend a lot or a little) — " +
      "give 2-4 concrete options. " +
      "'handoff' = it leaves your hands (booking, paying, ordering a ride) — he'll confirm when he's back. " +
      "Use what you REMEMBER about him to avoid asking things you already know (his allergies, places he's loved, his usual style). " +
      "If he says 'my favourite' or 'the usual', look it up in what you remember rather than asking which one. " +
      "If he mentions his partner, include telling her as a step. " +
      "NEVER invent a capability: you can open a dialer but cannot speak to a human; you can open a booking or " +
      "airline page but cannot pay. Use handoff for those and say so plainly. " +
      "PARALLEL: mark a step \"parallel\":true when it does NOT depend on any earlier step " +
      "(checking weather, converting currency, looking up etiquette). Those run at the same time, so the plan feels instant. " +
      "Anything that uses {{prev}} or needs an earlier answer must NOT be parallel. " +
      "FALLBACK: give any step that might come up empty a \"fallback\" object {\"skill\":\"...\",\"args\":{}} " +
      "to try automatically before bothering him (e.g. nearby with a wider area, or a different search term). " +
      "STEP RESULTS: later steps can use what earlier ones found — write {{prev}} in an argument to mean " +
      "'whatever the previous step produced' (e.g. booking the restaurant that step 1 found). " +
      "ABORT SENSIBLY: order steps so that if an early lookup finds nothing, the rest would be pointless — " +
      "the runner will stop and ask him rather than carry on blindly. " +
      "3-6 steps maximum. Prefer fewer, better steps. Do not narrate obvious steps. No markdown.",
    messages: [{ role: "user", content:
      `${prof.name || "He"} said: "${goal}"\nWhere: ${place || country || "unknown"}\n` +
      (mem ? `What you remember that's relevant: ${mem}\n` : "You don't know much about him yet — ask rather than assume.\n") +
      (core ? `${core}\n` : "") +
      (verdictBrief(uid) ? `${verdictBrief(uid)}\n` : "") +
      (procedureBrief(uid) ? `${procedureBrief(uid)}\n` : "") +
      (loved ? `Places he has told you he loves: ${loved}\n` : "") +
      (prof.partner ? `His partner is ${prof.partner}.` : "") }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "plan_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const steps = (Array.isArray(p.steps) ? p.steps : []).slice(0, 6);
    // Remember the plan itself — an abandoned plan is as informative as a finished one.
    const mm = STORE.mem[uid] = STORE.mem[uid] || [];
    mm.push({ t: `plan: "${String(goal).slice(0, 80)}" -> ${steps.map(x => x.skill).join(" → ")}`, at: Date.now() });
    while (mm.length > 400) mm.shift(); saveStore();
    dlog(uid, "routing", `plan: ${goal}`.slice(0, 60), steps.map(x => `${x.skill}:${x.mode}`));
    res.json({ spoken: p.spoken || "", steps });
  } catch { res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "plan_failed" }); }
});


// Pending work, phrased for the brief. Real anticipation: it remembers you were
// mid-something and picks it back up.
/* --- FLOW EXPIRY (batch 131 audit) ------------------------------------------
 * A flow opened and never closed stayed "waiting" forever. The ONLY thing that
 * removed it was the 20-item cap, so at a few flows a week Vision would still
 * be asking about a train he took — or decided against — in another country,
 * months later. Being nagged about something long settled is exactly how an
 * assistant loses trust.
 *
 * Two windows, because two different things go stale at different speeds:
 *   - a handoff he walked away from is dead within a day
 *   - a booking might genuinely still be open the next morning
 * Either way, lapsing is silent. It never announces that it gave up.
 * ------------------------------------------------------------------------ */
const FLOW_TTL_MS = {
  ride: 6 * 3600000,        // a ride is over or abandoned within hours
  order: 12 * 3600000,
  booktable: 24 * 3600000,
  booking: 48 * 3600000,    // he may genuinely finish this tomorrow
  stay: 48 * 3600000,
  default: 24 * 3600000,
};

function lapseFlows(uid) {
  const list = (STORE.pending || {})[uid];
  if (!list || !list.length) return 0;
  const now = Date.now();
  let n = 0;
  for (const f of list) {
    if (f.state !== "waiting") continue;
    const ttl = FLOW_TTL_MS[f.kind] || FLOW_TTL_MS.default;
    if (now - (f.at || 0) > ttl) {
      f.state = "expired"; f.closedAt = now; n++;
    }
  }
  if (n) { saveStore(); try { dlog(uid, "routing", `${n} pending flow(s) lapsed quietly`); } catch {} }
  return n;
}

function pendingBrief(uid) {
  // Reads STORE.pending — the store the app actually writes to. An earlier
  // /flow system used STORE.flows and is no longer called by anything.
  lapseFlows(uid);
  const list = ((STORE.pending || {})[uid] || []).filter(f => f.state === "waiting" && !f.ownedByPlan);
  if (!list.length) return "";
  const f = list.sort((a, b) => a.at - b.at)[0];
  const mins = Math.round((Date.now() - f.at) / 60000);
  const ago = mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  return `UNFINISHED (${ago}): he started ${f.kind} "${f.what || ""}" and never confirmed it. Ask how it went, once, naturally.`;
}

// --- 🐞 BUG LOG (batch 92) ---
// He finds bugs I can't — screenshots have caught fourteen so far. This turns
// "the orb looked wrong" into a snapshot I can actually act on, and triages
// known limits so he stops sending me things that aren't broken.


// --- 🎯 ORCHESTRATOR (batch 89) ---
// One command, a whole journey. Vision plans the steps, runs what it can, and
// STOPS to ask only where a real choice exists or where it must hand over.
// The judgement that matters: decide vs ask. Guessing his dinner is rude;
// asking which route to take is worse.


// --- ⏸️ PENDING FLOWS (batch 88) ---
// Vision can't tap Apple Pay for you — nobody can. But it CAN hold the thread
// open across the handoff: set the task up, hand you to the app, and pick the
// journey back up when you return instead of forgetting it happened.
app.post("/pending", requireAuth, async (req, res) => {
  const { action, flow, id, outcome, detail } = req.body || {};
  const uid = uidOf(req);
  STORE.pending = STORE.pending || {};
  const list = STORE.pending[uid] = STORE.pending[uid] || [];

  if (action === "open" && flow) {
    // ownedByPlan: the plan will do the asking, so resumePending stays quiet.
    const p = { id: "p" + Date.now(), at: Date.now(), state: "waiting", ...flow };
    list.push(p); while (list.length > 20) list.shift();
    saveStore();
    dlog(uid, "routing", `pending opened: ${p.kind} ${p.what || ""}`);
    return res.json({ ok: true, pending: p });
  }
  if (action === "active") {
    lapseFlows(uid);
    // Anything still waiting that ISN'T owned by a running plan — the plan asks
    // about its own steps, so we never double-prompt for one action.
    const waiting = list.filter(p => p.state === "waiting" && !p.ownedByPlan);
    return res.json({ pending: waiting.slice(-3).reverse(), count: waiting.length });
  }
  if (action === "close" && id) {
    const p = list.find(x => x.id === id);
    if (p) {
      // Batch 131 audit: the app offers THREE answers — Done / Not yet /
      // Didn't do it — but anything that wasn't "done" or "abandoned" fell
      // through to "done". So tapping "Not yet" marked the flow COMPLETE,
      // wrote "completed: booking the Sapa train" into memory as a fact the
      // brain then used to judge what he follows through on, and never asked
      // again — silently dropping the thing he'd just said he'd come back to.
      if (outcome === "waiting" || outcome === "later") {
        // Still open, but push the clock forward so it doesn't re-nag on the
        // next screen. Nothing is written to memory: nothing has happened yet.
        p.state = "waiting";
        p.at = Date.now();
        p.deferred = (p.deferred || 0) + 1;
        // Three "not yet"s is him telling you something. Let it lapse rather
        // than asking a fourth time.
        if (p.deferred >= 3) { p.state = "expired"; p.closedAt = Date.now(); }
        saveStore();
        dlog(uid, "routing", `pending deferred (${p.deferred}x): ${p.kind} ${p.what || ""}`);
        return res.json({ ok: true, pending: p, deferred: true });
      }

      p.state = outcome === "abandoned" ? "abandoned" : "done";
      p.closedAt = Date.now(); if (detail) p.detail = detail;
      // A completed flow is a fact worth keeping — it teaches the brain what he
      // actually follows through on.
      const mem = STORE.mem[uid] = STORE.mem[uid] || [];
      remember(uid, `${p.state === "done" ? "completed" : "abandoned"}: ${p.kind} ${p.what || ""}${detail ? ` — ${detail}` : ""}`, { kind: "procedure" });
      saveStore();
    }
    return res.json({ ok: true, pending: p || null });
  }
  if (action === "nextstep" && id) {
    // What would naturally come next, given what he just finished.
    const p = list.find(x => x.id === id);
    if (!p) return res.json({ moves: [] });
    const mem = recallFor(uid, `${p.kind} ${p.what || ""}`, 3).map(m => m.t).join(" | ");
    const body = {
      model: "claude-haiku-4-5-20251001", max_tokens: 220,
      system: 'He has just finished a task in another app and come back. Propose what naturally comes NEXT in the journey. ' +
        'JSON only: {"spoken":"one short sentence acknowledging it and offering the next step","moves":[{"label":"max 5 words","say":"the phrase to send"}]} with 1-3 moves. ' +
        'Examples: after booking a restaurant offer directions at the right time, a reminder, and telling their partner; after booking a flight offer storing the reference, a check-in reminder, and airport transfer; after paying for something offer logging the spend. No markdown.',
      messages: [{ role: "user", content: `Finished: ${p.kind} — ${p.what || ""} ${p.when || ""}\nOutcome: ${p.state}${p.detail ? ` (${p.detail})` : ""}` + (mem ? `\nRelevant history: ${mem}` : "") }],
    };
    try {
      const { status, text } = await callClaude(body);
      if (status !== 200) return res.json({ moves: [] });
      const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      return res.json(JSON.parse(raw.replace(/```json|```/g, "").trim()));
    } catch { return res.json({ moves: [] }); }
  }
  res.status(400).json({ error: "bad action" });
});

// Pending work belongs in the brief — that's how a flow survives being left.

// --- 🍽️ MENU READER (batch 86) ---
// Photograph a menu: translated, priced, and steered toward what's actually
// worth ordering. If he's stated restrictions they're honoured; if not, the
// "avoid" list becomes genuine risk — the stuff travellers regret.
app.post("/menu", requireAuth, async (req, res) => {
  const { image, mediaType, avoid, country, budget } = req.body || {};
  if (!image) return res.status(400).json({ error: "image required" });
  const uid = uidOf(req);
  const mem = recallFor(uid, "food eaten liked dish restaurant", 4).map(m => m.t).join(" | ");
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 900,
    system: "You read menus for a traveller. JSON only: " + NO_INVENT_STRICT + ANSWER_FIRST +
      '{"spoken":"2-3 sentences aloud: what kind of menu, roughly what things cost, your top pick and why",' +
      '"safe":[{"name":"dish as written","english":"what it is","price":"as printed","why":"one line"}],' +
      '"avoid":[{"name":"dish","reason":"why to skip it"}],' +
      '"unsure":["anything you genuinely cannot read or identify"]}. ' +
      "If he has stated restrictions, flag anything that breaks them and say so plainly. " +
      "If he has NO restrictions, do not invent any — use 'avoid' for real risk instead " +
      "(raw or undercooked items in places with poor refrigeration, tourist-priced dishes, " +
      "anything obviously past its best) and leave it empty if nothing warrants it. " +
      "Be honest in unsure — if you cannot read a dish, say so rather than guessing. No markdown.",
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } },
      { type: "text", text: `Menu${country ? ` in ${country}` : ""}. ` +
        (avoid ? `He must avoid: ${avoid}.` : "He has no dietary restrictions — judge on quality and value, not diet.") +
        `${budget ? ` Budget around ${budget}.` : ""}${mem ? ` What he's enjoyed before: ${mem}` : ""}` }] }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "read_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const m2 = STORE.mem[uid] = STORE.mem[uid] || [];
    m2.push({ t: `menu read: ${p.spoken}`.slice(0, 240), at: Date.now() });
    while (m2.length > 400) m2.shift(); saveStore();
    res.json(p);
  } catch { res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "read_failed" }); }
});

// --- 🗣️ TRANSLATE MEMORY (batch 86) ---
// Save a conversation you've had through translation: a distilled summary in
// BOTH languages plus any COMMITMENTS (price, time, what's included). Never
// raw audio. Tag it, recall it, and hold up their own words later.
app.post("/convomemory", requireAuth, async (req, res) => {
  const { action, tag, turns, query, place } = req.body || {};
  const uid = uidOf(req);
  STORE.convos = STORE.convos || {};
  const list = STORE.convos[uid] = STORE.convos[uid] || [];

  if (action === "save") {
    if (!Array.isArray(turns) || !turns.length) return res.status(400).json({ error: "turns required" });
    const script = turns.slice(-30).map(t => `${t.who || "?"} (${t.lang || "?"}): ${t.text}`).join("\n").slice(0, 4000);
    // What he's agreed with this person before — so repeat dealings compound.
    const prior = recallFor(uid, `conversation ${tag || ""} ${place || ""}`, 3).map(m => m.t).join(" | ");
    const body = {
      model: "claude-haiku-4-5-20251001", max_tokens: 500,
      system: 'Distil a translated conversation for Shaun\'s records. JSON only: ' +
        '{"summary":"2-3 sentences of what was discussed","commitments":[{"what":"the agreement","detail":"price/time/inclusions","theirWords":"their exact words in THEIR language","englishWords":"the English"}],' +
        '"phrases":["any phrase that worked well, in their language"],"followUp":"one thing worth checking later, or empty"}. ' +
        'Commitments are only things actually AGREED — prices settled, times promised, what is included. No markdown.',
      messages: [{ role: "user", content: `Conversation${place ? ` at ${place}` : ""}:\n${script}` +
        (prior ? `\n\nEarlier dealings worth cross-checking (flag it if this contradicts a previous agreement): ${prior}` : "") }],
    };
    try {
      const { status, text } = await callClaude(body);
      if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "distil_failed" });
      const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
      const rec = { tag: (tag || "conversation").toLowerCase().trim(), at: Date.now(), place: place || "", ...p };
      list.push(rec); while (list.length > 60) list.shift();
      // also into the shared pool so ALL skills can recall it
      const mem = STORE.mem[uid] = STORE.mem[uid] || [];
      const commits = (p.commitments || []).map(c => `${c.what}: ${c.detail}`).join("; ");
      remember(uid, `conversation with ${rec.tag}${place ? ` at ${place}` : ""}: ${p.summary}${commits ? ` — agreed: ${commits}` : ""}`, { kind: "conversation" });
      saveStore();
      return res.json({ ok: true, ...rec });
    } catch { return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "distil_failed" }); }
  }
  if (action === "recall") {
    const q = String(query || "").toLowerCase();
    const hits = q ? list.filter(c => c.tag.includes(q) || String(c.summary).toLowerCase().includes(q)
      || (c.commitments || []).some(x => String(x.what + x.detail).toLowerCase().includes(q))) : list.slice(-5);
    return res.json({ hits: hits.slice(-5) });
  }
  if (action === "list") return res.json({ tags: [...new Set(list.map(c => c.tag))], count: list.length });
  res.status(400).json({ error: "bad action" });
});

// --- 🎫 BOOKINGS (batch 86) ---
// Vision helps you book, then remembers it: reference, time, seat, gate.
app.post("/bookings", requireAuth, (req, res) => {
  const { action, booking, id, query } = req.body || {};
  const uid = uidOf(req);
  STORE.bookings = STORE.bookings || {};
  const list = STORE.bookings[uid] = STORE.bookings[uid] || [];
  if (action === "add" && booking) {
    const b = { id: "b" + Date.now(), at: Date.now(), ...booking };
    list.push(b); while (list.length > 80) list.shift();
    const mem = STORE.mem[uid] = STORE.mem[uid] || [];
    remember(uid, `booking: ${b.type || "reservation"} ${b.what || ""} ${b.when || ""}${b.ref ? ` ref ${b.ref}` : ""}`, { kind: "booking" });
    saveStore();
    return res.json({ ok: true, booking: b });
  }
  if (action === "remove" && id) { STORE.bookings[uid] = list.filter(b => b.id !== id); saveStore(); return res.json({ ok: true }); }
  if (action === "find") {
    const q = String(query || "").toLowerCase();
    const hits = q ? list.filter(b => JSON.stringify(b).toLowerCase().includes(q)) : list;
    const now = Date.now();
    const upcoming = hits.filter(b => !b.whenISO || Date.parse(b.whenISO) > now - 86400000)
      .sort((a, b) => (Date.parse(a.whenISO || 0) || 9e15) - (Date.parse(b.whenISO || 0) || 9e15));
    // Proactive: name what's imminent so the app can lead with it.
    const soon = upcoming.filter(b => b.whenISO && Date.parse(b.whenISO) - Date.now() < 172800000);
    return res.json({ bookings: upcoming.slice(0, 12), total: list.length,
      imminent: soon.length ? `${soon[0].type || "Booking"}: ${soon[0].what || ""} ${soon[0].when || ""}` : "" });
  }
  res.status(400).json({ error: "bad action" });
});

// --- 📋 EMERGENCY DOCS (batch 86) ---
// Insurance, embassy, passport details — the things you need when it's gone wrong.
app.post("/docs", requireAuth, (req, res) => {
  const { action, field, value } = req.body || {};
  const uid = uidOf(req);
  STORE.docs = STORE.docs || {};
  const d = STORE.docs[uid] = STORE.docs[uid] || {};
  const FIELDS = ["insurer", "policyNumber", "insurancePhone", "embassyPhone", "embassyAddress",
                  "passportNumber", "bloodType", "emergencyContact", "medicalNotes",
                  "passportExpiry", "visaExpiry", "insuranceExpiry", "licenceExpiry", "cardExpiry"];
  if (action === "set" && FIELDS.includes(field)) {
    const v = String(value || "").trim();
    if (v) d[field] = v.slice(0, 200); else delete d[field];
    // A pointer in the shared pool so "what's my insurance" reaches the brain
    // via normal recall, without ever putting the value itself in memory.
    if (v) {
      const mem = STORE.mem[uid] = STORE.mem[uid] || [];
      if (!mem.some(m => String(m.t).startsWith(`document on file: ${field}`))) {
        remember(uid, `document on file: ${field} — ask for my documents to see it`, { kind: "document" });
      }
    }
    saveStore(); return res.json({ ok: true });
  }
  if (action === "get") return res.json({ docs: d, fields: FIELDS });
  res.status(400).json({ error: "bad action" });
});

// --- 🔑 SERVICE KEYS (batch 84) ---
// Set optional API keys from the phone. Stored in the durable store, live on
// the next request. Values are never sent back — only whether they're set.
const KEY_FIELDS = [
  { id: "GOOGLE_MAPS_API_KEY", label: "Google Maps", hint: "Unlocks nearby, navigate, stays, autocomplete", where: "console.cloud.google.com → Credentials" },
  { id: "AVIATIONSTACK_KEY",  label: "Flight tracking", hint: "Live flight status", where: "aviationstack.com → free API key" },
  { id: "ICLOUD_USER",        label: "iCloud email", hint: "Your @icloud.com address for briefings", where: "your Apple ID" },
  { id: "ICLOUD_APP_PW",      label: "iCloud app password", hint: "App-specific password, NOT your real one", where: "appleid.apple.com → Sign-In & Security" },
];
app.post("/keys", requireAuth, async (req, res) => {
  const { action, id, value } = req.body || {};
  STORE.keys = STORE.keys || {};
  if (action === "set" && id && KEY_FIELDS.some(k => k.id === id)) {
    const v = String(value || "").trim();
    if (v) STORE.keys[id] = v; else delete STORE.keys[id];
    saveStore();
    dlog(uidOf(req), "services", `key ${v ? "set" : "cleared"}: ${id}`);
    return res.json({ ok: true, set: !!v });
  }
  if (action === "test" && id) {
    // Prove the key works before he walks away thinking it's fixed.
    try {
      if (id === "AVIATIONSTACK_KEY") { const r = await aviationFetch({ access_key: FLIGHT_KEY, limit: "1" }); return res.json({ ok: r.ok, detail: r.ok ? "live" : "rejected — wrong key or quota spent" }); }
      if (id === "GOOGLE_MAPS_API_KEY") {
        const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
        u.searchParams.set("address", "Brisbane"); u.searchParams.set("key", GMAPS_KEY || "");
        const j = await (await fetch(u)).json();
        return res.json({ ok: j.status === "OK", detail: j.status === "OK" ? "live" : (j.error_message || j.status) });
      }
      if (id === "ICLOUD_USER" || id === "ICLOUD_APP_PW") {
        if (!mailReady()) return res.json({ ok: false, detail: "needs both address and app password" });
        const ok = await withInbox(async () => true);
        return res.json({ ok: !!ok, detail: ok ? "live" : "sign-in failed" });
      }
    } catch (e) { return res.json({ ok: false, detail: String(e.message || e).slice(0, 80) }); }
    return res.json({ ok: false, detail: "no test for this key" });
  }
  // list: which are set, and from where — never the values themselves
  res.json({
    fields: KEY_FIELDS.map(k => ({
      ...k,
      set: !!(STORE.keys && STORE.keys[k.id]) || !!process.env[k.id],
      source: (STORE.keys && STORE.keys[k.id]) ? "app" : (process.env[k.id] ? "render" : "none"),
    })),
  });
});

// --- 🔍 DIAGNOSTICS (batch 70) ---
// What Vision DID — for testing, not for recall. Off by default (it costs a
// little overhead), capped, categorised, and copyable so a bad result can be
// pasted straight into a conversation with me.
const LOG_CATS = ["routing", "memory", "services", "cost", "errors", "voice"];
function dlog(uid, cat, msg, extra) {
  try {
    if (!STORE.diag || !STORE.diag.on) return;
    STORE.diag.lines = STORE.diag.lines || [];
    STORE.diag.lines.push({ at: Date.now(), uid: (uid || "?").slice(0, 8), cat, msg: String(msg).slice(0, 300), extra: extra || null });
    while (STORE.diag.lines.length > 500) STORE.diag.lines.shift();
    saveStore();
  } catch {}
}
app.post("/diag", requireAuth, (req, res) => {
  const { action, cat, limit } = req.body || {};
  STORE.diag = STORE.diag || { on: false, lines: [] };
  if (action === "on") { STORE.diag.on = true; saveStore(); return res.json({ on: true }); }
  if (action === "off") { STORE.diag.on = false; saveStore(); return res.json({ on: false }); }
  if (action === "clear") { STORE.diag.lines = []; saveStore(); return res.json({ ok: true }); }
  if (action === "note") { dlog(uidOf(req), req.body.cat || "voice", req.body.msg || ""); return res.json({ ok: true }); }
  const lines = (STORE.diag.lines || []).filter(l => !cat || cat === "all" || l.cat === cat);
  const counts = {};
  for (const c of LOG_CATS) counts[c] = (STORE.diag.lines || []).filter(l => l.cat === c).length;
  res.json({ on: !!STORE.diag.on, counts, total: (STORE.diag.lines || []).length, lines: lines.slice(-(limit || 40)) });
});

// --- 📖 DAY VIEW + SUMMARIES (batch 70) ---
// A browsable day, and a distilled paragraph. The summary is the important
// part: it gets stored as a durable fact so recall, briefings and advice all
// draw on "what Tuesday was like" instead of forty raw log lines.
app.post("/day", requireAuth, async (req, res) => {
  const { date, summarise } = req.body || {};
  const uid = uidOf(req);
  const mem = STORE.mem[uid] || [];
  const d = date ? new Date(date + "T00:00:00") : new Date();
  const start = new Date(d); start.setHours(0, 0, 0, 0);
  const end = new Date(d); end.setHours(23, 59, 59, 999);
  const items = mem.filter(m => m.at >= start.getTime() && m.at <= end.getTime());
  const cat = (t) => {
    t = String(t);
    if (t.startsWith("log:")) return "places";
    if (t.startsWith("moment")) return "moments";
    if (t.startsWith("saw:") || t.startsWith("read:")) return "photos";
    if (t.startsWith("receipt:") || /^logspend/.test(t)) return "spend";
    if (t.startsWith("reminder:")) return "reminders";
    return "conversations";
  };
  const grouped = {};
  for (const m of items) { const c = cat(m.t); (grouped[c] = grouped[c] || []).push({ at: m.at, t: m.t }); }

  let summary = "";
  const dayKey = start.toISOString().slice(0, 10);
  STORE.daySummaries = STORE.daySummaries || {};
  const cached = (STORE.daySummaries[uid] || {})[dayKey];
  if (summarise && items.length >= 3) {
    if (cached && cached.n === items.length) summary = cached.text;   // unchanged day, reuse
    else {
      const list = items.map(m => `${new Date(m.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })} ${m.t}`).join("\n").slice(0, 4000);
      const body = { model: "claude-haiku-4-5-20251001", max_tokens: 300,
        system: "You distil a day into one warm paragraph for Shaun's diary — where he went, what stood out, anything worth remembering later (prices, names, agreements, how it felt). 3-5 sentences, natural, no lists, no preamble." + NO_INVENT,
        messages: [{ role: "user", content: `${d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}:\n${list}` }] };
      try {
        const { status, text } = await callClaude(body);
        if (status === 200) {
          summary = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
          if (summary) {
            STORE.daySummaries[uid] = STORE.daySummaries[uid] || {};
            STORE.daySummaries[uid][dayKey] = { text: summary, n: items.length, at: Date.now() };
            // Keep 120 days of summaries, and file it as a durable memory so
            // recall, briefings and advice can all use the DAY, not the noise.
            const keys = Object.keys(STORE.daySummaries[uid]).sort();
            while (keys.length > 120) delete STORE.daySummaries[uid][keys.shift()];
            const already = mem.some(m => String(m.t).startsWith(`day ${dayKey}:`));
            if (!already) {
              remember(uid, `day ${dayKey}: ${summary}`, { kind: "day", at: end.getTime() });
            }
            saveStore();
          }
        }
      } catch {}
    }
  }
  res.json({
      spoken: (summary || (cached ? cached.text : "")) || (items.length ? `${items.length} things logged that day.` : "Nothing logged that day."), date: dayKey, count: items.length, grouped, summary: summary || (cached ? cached.text : "") });
});

// Recent day summaries — the distilled layer briefings and advice draw on.
function daySummaryBrief(uid, days) {
  const all = (STORE.daySummaries || {})[uid] || {};
  const keys = Object.keys(all).sort().slice(-(days || 3));
  if (!keys.length) return "";
  return keys.map(k => `${k}: ${all[k].text}`).join(" | ").slice(0, 900);
}

// --- 💰 SPEND (batch 68): what Vision has actually cost, in the app.
// Estimated from real token counts. console.anthropic.com remains the bill.
app.post("/spend", requireAuth, (_req, res) => {
  const sp = STORE.spend || {};
  const day = new Date().toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  let today = sp[day] || 0, thisMonth = 0, last7 = 0;
  const series = [];
  for (const [d, v] of Object.entries(sp)) {
    if (d.startsWith(month)) thisMonth += v;
    if (Date.parse(d) > Date.now() - 7 * 86400000) last7 += v;
  }
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({ d: d.slice(5), usd: Math.round((sp[d] || 0) * 10000) / 10000 });
  }
  res.json({ today, thisMonth, last7, series, note: "Estimate from real token counts — console.anthropic.com is the actual bill." });
});

// --- 📓 LIFE LOG (batch 68) ---
// Three tiers, cheapest first. Most of what's worth remembering isn't visual:
// where, when, weather, what's nearby — all free from GPS + APIs. The camera
// only fires when something actually changed.
// Shared-moment rule: if the couple room says they were together (<150m within
// the hour), the entry is promoted to the shared layer. Apart = private.
app.post("/lifelog", requireAuth, async (req, res) => {
  const { lat, lng, glance, note, roomCode, myName } = req.body || {};
  const uid = uidOf(req);
  if (lat == null || lng == null) return res.status(400).json({ error: "lat,lng required" });
  const out = { at: Date.now() };
  // --- Tier 1: free context. No camera, no model call.
  try {
    const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code`)).json();
    if (w.current) out.temp = Math.round(w.current.temperature_2m);
  } catch {}
  if (GMAPS_KEY) {
    try {
      const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      u.searchParams.set("latlng", `${lat},${lng}`); u.searchParams.set("key", GMAPS_KEY);
      const g = await (await fetch(u)).json();
      const best = (g.results || [])[0];
      if (best) {
        out.place = (best.address_components || []).filter(c => /locality|sublocality|neighborhood/.test(c.types.join()))
          .map(c => c.long_name)[0] || best.formatted_address.split(",")[0];
      }
      const nu = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
      nu.searchParams.set("location", `${lat},${lng}`); nu.searchParams.set("radius", "120");
      nu.searchParams.set("key", GMAPS_KEY);
      const n = await (await fetch(nu)).json();
      const near = (n.results || []).filter(p => (p.types || []).some(t => /point_of_interest|tourist_attraction|restaurant|cafe|lodging|park/.test(t)))
        .slice(0, 2).map(p => p.name);
      if (near.length) out.nearby = near;
    } catch {}
  }
  // --- Tier 2: one cheap glance, only if a frame was sent (client decides when).
  if (glance) {
    try {
      const body = { model: "claude-haiku-4-5-20251001", max_tokens: 120,
        // Batch 118 audit: no system prompt. Every line here becomes a
        // permanent life-log entry, so a confident guess about a place becomes
        // a false memory he can't distinguish from a real one later.
        system:
          "You label a single camera frame for a life-log in one short line. " +
          "Name only what you can actually see. Do not name a specific business, street or landmark unless it is legible in the frame — " +
          "say the kind of place instead. Most frames are worth nothing; say so rather than reaching." + NO_INVENT,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: glance } },
          { type: "text", text: "One short line: what is this place or scene? If it's a pocket, a wall, the ground or nothing of note, reply exactly: nothing." }] }] };
      const { status, text } = await callClaude(body);
      if (status === 200) {
        const line = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
        if (line && !/^nothing\.?$/i.test(line)) out.saw = line.slice(0, 200);
      }
    } catch {}
  }
  // --- Together? Ask the room. Proximity decides, not a toggle.
  let together = null;
  if (roomCode) {
    try {
      const r = room(roomCode);
      if (r) {
        const others = Object.values(r.members || {}).filter(m => m.name !== (myName || "me"));
        for (const o of others) {
          if (o.lat != null && Date.now() - (o.at || 0) < 3600000) {
            const d = haversineM(lat, lng, o.lat, o.lng);
            if (d < 150) { together = o.name; break; }
          }
        }
      }
    } catch {}
  }
  // --- Write the entry. Text only — glances are never stored as images.
  const bits = [out.place || "somewhere", out.temp != null ? `${out.temp}°` : "",
    out.nearby ? `near ${out.nearby.join(" / ")}` : "", out.saw ? `— ${out.saw}` : "", note || ""].filter(Boolean);
  const line = `log: ${bits.join(" ")}`;
  const mem = STORE.mem[uid] = STORE.mem[uid] || [];
  const last = mem[mem.length - 1];
  // Don't log the same place twice in a row — collapse instead of repeating.
  if (last && String(last.t).startsWith("log:") && String(last.t).includes(out.place || "~~") && !out.saw) {
    last.at = Date.now();
  } else {
    remember(uid, line + (together ? ` (with ${together})` : ""), { kind: "lifelog" });
  }
  // Shared layer: moments they were both present for.
  if (together) {
    STORE.shared = STORE.shared || {};
    const key = roomCode;
    const sh = STORE.shared[key] = STORE.shared[key] || [];
    sh.push({ t: line, at: Date.now(), who: [myName || "me", together] });
    while (sh.length > 200) sh.shift();
  }
  saveStore();
  res.json({ ...out, together, logged: true });
});

// Shared-layer read: what the two of them did together.
app.post("/shared", requireAuth, (req, res) => {
  const { roomCode, action, index, at } = req.body || {};
  STORE.shared = STORE.shared || {};
  const sh = STORE.shared[roomCode] || [];
  if (action === "remove") {
    // Match by stable timestamp — the app shows a sliced view, so a positional
    // index from the display would delete the wrong (older) moment. Fall back to
    // index only for an old app build mid-deploy.
    if (at != null) {
      const i = sh.findIndex(m => m.at === at);
      if (i !== -1) { sh.splice(i, 1); saveStore(); return res.json({ ok: true, count: sh.length }); }
      return res.json({ ok: false, count: sh.length, note: "not found" });
    }
    if (index != null) { sh.splice(index, 1); saveStore(); return res.json({ ok: true, count: sh.length }); }
  }
  res.json({ shared: sh.slice(-20), count: sh.length });
});

// --- 🎬 MOMENT CAPTURE (batch 67) ---
// A burst of frames analysed AS A SEQUENCE into a written account. Frames are
// never stored — the text is the artefact. Timestamped, place-stamped, saved
// to the same pool every skill recalls from.
app.post("/moment", requireAuth, async (req, res) => {
  const { frames, place, country, note, lat, lng } = req.body || {};
  if (!Array.isArray(frames) || !frames.length) return res.status(400).json({ error: "frames required" });
  const uid = uidOf(req);
  const content = [];
  for (const f of frames.slice(0, 6)) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f } });
  }
  content.push({ type: "text", text:
    `These frames are seconds apart from ${place || country || "somewhere"}${note ? ` — context: ${note}` : ""}. ` +
    `Write a short WRITTEN RECORD of this moment for Shaun's diary. Reply JSON ONLY: ` +
    `{"headline":"6 words max","account":"2-3 sentences: what's happening, what changed across the frames, anything worth remembering — prices, names, signs, agreements","tags":["short","keywords"],"worth_keeping":true|false}. ` +
    `Set worth_keeping false if this is just a street, a wall, a pocket, or nothing of note.` });
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    // Batch 118 audit: also had no system prompt. This writes into his diary
    // and the entries are read back months later, so an invented detail
    // becomes a false memory he can't tell from a real one.
    system:
      "You write short diary entries from a burst of camera frames. " +
      "Record ONLY what is visibly in the frames — a price on a sign, a name on a shopfront, what changed between frames. " +
      "Be strict about worth_keeping: most frames are a street, a wall or a pocket, and a diary full of those is worthless." +
      NO_INVENT + SPOKEN_PLAIN,
    messages: [{ role: "user", content }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "analyse_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    // Batch 118 audit: a bare parse here. The outer catch stopped a crash but
    // silently DISCARDED the moment — a captured memory lost with no sign it
    // ever existed. A prose reply is normal, not exotic; keep it as prose.
    let p;
    try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch {
      p = { headline: "Moment", account: raw.slice(0, 400), tags: [], worth_keeping: raw.length > 40 };
    }
    if (p.worth_keeping !== false) {
      // Route through the salience gate as a real placed occurrence — attaches
      // live coords so recall can bring him back to the exact stall/spot, not the
      // stale profile city. A captured moment he chose to make IS worth keeping.
      const coords = (lat != null) ? { lat, lng } : undefined;
      consider(uid, {
        kind: "moment",
        text: `moment${place ? ` at ${place}` : ""}: ${p.headline} — ${p.account}${p.tags && p.tags.length ? ` [${p.tags.join(", ")}]` : ""}`,
        occurred: true, place: place || undefined, coords,
      }) || remember(uid, `moment${place ? ` at ${place}` : ""}: ${p.headline} — ${p.account}`, { kind: "moment" });
    }
    res.json({ ...p, saved: p.worth_keeping !== false });
  } catch { res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "analyse_failed" }); }
});

// Should Vision spend a capture here? Cheap decision, no camera needed.
// Weighted by what he ACTUALLY recalls later — memory usage teaches the policy.
app.post("/shouldcapture", requireAuth, (req, res) => {
  const { place, skill, moving } = req.body || {};
  const uid = uidOf(req);
  const mem = STORE.mem[uid] || [];
  const seenHere = place ? mem.some(m => String(m.t).toLowerCase().includes(String(place).toLowerCase())) : false;
  const placeSkills = ["nearby", "navigate", "landmark", "findfood", "stay", "arrival", "transit", "ride"];
  let score = 0, why = [];
  if (place && !seenHere) { score += 3; why.push("somewhere new"); }
  if (placeSkills.includes(skill)) { score += 2; why.push("place-related request"); }
  if (moving) { score -= 3; why.push("in transit"); }
  if (seenHere) { score -= 2; why.push("been here before"); }
  res.json({ capture: score >= 3, score, why: why.join(", ") });
});

// --- ➡️ NEXT MOVES (batch 63) ---
// After ANY skill answers, the brain proposes the 2-3 things Shaun would
// actually want next — informed by what just happened, where he is, and what
// he's told Vision before. Beats 40 hand-written chip sets, and it adapts.
app.post("/nextmoves", requireAuth, async (req, res) => {
  const { skill, result, place, country } = req.body || {};
  const uid = uidOf(req);
  const mem = recallFor(uid, `${skill || ""} ${result || ""}`, 4).map(m => m.t).join(" | ");
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 260,
    system:
      "You propose what a traveller would ACTUALLY want next, right after their assistant answered. " +
      "Reply JSON ONLY: {\"moves\":[{\"label\":\"short tappable text (max 5 words)\",\"say\":\"the phrase to send as if he said it\"}]} with 2-3 moves. " +
      "Rules: be concrete and useful, never generic (\"tell me more\" is banned). " +
      "Match the skill: after finding a restaurant offer directions/call/menu/favourite it; after currency offer a nearby fee-free ATM or logging a spend; " +
      "after weather offer what to wear or an indoor alternative; after a scam check offer a fair counter-price or somewhere better; " +
      "after translate offer saving the phrase; after a landmark offer its history or nearby food. " +
      "Only offer things a phone assistant can do: navigate, call, search, translate, remember, log spend, set a watcher/reminder/timer, plan. No booking." + SPOKEN_PLAIN,
    messages: [{ role: "user", content:
      `Skill just used: ${skill || "unknown"}\nWhat it answered: ${String(result || "").slice(0, 600)}\n` +
      `Where he is: ${place || country || "unknown"}\n${mem ? `Relevant things he's told you: ${mem}` : ""}` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.json({ moves: [] });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
    res.json({ moves: Array.isArray(p.moves) ? p.moves.slice(0, 3) : [] });
  } catch { res.json({ moves: [] }); }
});

// --- 🖼️ VISUAL RECALL SUMMARY (batch 62): turn what Vision SAW into a spoken
// answer, not a list. The words were always the memory; this makes them talk.
app.post("/seensummary", requireAuth, async (req, res) => {
  const { query, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.json({ spoken: "I haven't looked at anything yet." });
  const list = items.slice(-12).map((i, n) => `${n + 1}. ${i.whenTxt || ""}${i.place ? ` in ${i.place}` : ""}: ${i.ans}`).join("\n");
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 320,
    system: "You are Vision, recalling aloud what you previously saw through Shaun's camera. Speak naturally in 2-4 sentences — summarise and connect the observations, mention when and where if useful, and answer his actual question. Never read the list back mechanically. If he seems to be checking a detail (a price, a name, a sign), lead with that detail." + SPOKEN_PLAIN +
      NO_INVENT,
    messages: [{ role: "user", content: `He asks: "${query || "what have you seen lately?"}"\n\nWhat you saw:\n${list}` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.json({ spoken: "" });
    const spoken = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    res.json({ spoken });
  } catch { res.json({ spoken: "" }); }
});

// --- 🔭 WATCHERS (batch 51): Vision's overnight eyes. Voice-created monitors
// parsed by Haiku into {type, args, threshold}; a scheduler runs them hourly;
// results wait in the store and surface in the opening brief. True unprompted
// push stays native-territory — this is checks-while-away, tells-on-open.
app.post("/watchers", requireAuth, async (req, res) => {
  const uid = uidOf(req); const { action, request, id } = req.body || {};
  const list = STORE.watchers[uid] = STORE.watchers[uid] || [];
  if (action === "list") return res.json({ watchers: list, results: (STORE.results[uid] || []).slice(-6) });
  if (action === "due") {
    // upcoming reminders, soonest first — "what are my reminders?"
    const rem = list.filter(w => w.type === "reminder")
      .map(w => ({ ...w, due: w.args && w.args.dueISO ? Date.parse(w.args.dueISO) : null }))
      .sort((a, b) => (a.due || 9e15) - (b.due || 9e15));
    return res.json({ reminders: rem });
  }
  if (action === "remove" && id) { STORE.watchers[uid] = list.filter(w => w.id !== id); saveStore(); return res.json({ ok: true, count: STORE.watchers[uid].length }); }
  if (action === "latest") {
    // Batch 132 audit: this marked EVERYTHING seen the instant it responded,
    // while the app only renders three. A fourth overnight finding was gone
    // forever with no trace — and if the network dropped between the response
    // and the render, every finding was lost silently. Marking seen is now a
    // separate call the app makes AFTER it has actually shown them.
    const seen = STORE.seen[uid] || 0;
    const fresh = (STORE.results[uid] || []).filter(r => r.at > seen && r.triggered);
    return res.json({ fresh, more: Math.max(0, fresh.length - 3) });
  }
  if (action === "seen") {
    // Acknowledge only up to the newest thing he was actually shown, so
    // anything that arrived in between still gets its turn.
    const upto = Number((req.body || {}).upto) || Date.now();
    STORE.seen[uid] = Math.max(STORE.seen[uid] || 0, upto);
    saveStore();
    return res.json({ ok: true, seen: STORE.seen[uid] });
  }
  if (action === "add" && request) {
    if (list.length >= 8) return res.status(400).json({ error: "watcher_limit", spoken: "You've got eight watchers already — remove one first." });
    const body = {
      model: "claude-haiku-4-5-20251001", max_tokens: 250,
      system: 'Parse a watch/reminder request into JSON only: {"type":"flightdeal|weather|events|currency|reminder","label":"short human label","args":{...},"threshold":null|number}. flightdeal args {from,to,when?} threshold=max price number if stated. weather args {place,days:5}. events args {area,when:"this weekend"|...}. currency args {from,to} threshold=rate number if stated. reminder args {what, dueISO (ISO datetime if a time/date is stated, else null), place (if they said a location like "where I parked" or "at the market")}. Use reminder for "remind me...", "don\'t let me forget...", "where I parked". No markdown.',
      messages: [{ role: "user", content: String(request).slice(0, 300) }],
    };
    try {
      const { status, text } = await callClaude(body);
      if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "parse_failed" });
      const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      const w = JSON.parse(raw.replace(/```json|```/g, "").trim());
      // Guard: a valid-JSON-but-junk type would store a watcher no loop handles —
      // a dead slot that silently never fires. Refuse it plainly instead.
      const VALID = ["flightdeal", "weather", "events", "currency", "reminder"];
      if (!w || !VALID.includes(w.type)) {
        return res.status(200).json({ fallback: true, spoken: "I couldn't tell what to watch there — try it like \"watch flights Brisbane to Bali under 300 dollars\" or \"remind me to grab the passport at 6\"." });
      }
      w.id = "w" + Date.now(); w.createdAt = Date.now();
      list.push(w); saveStore();
      if (w.type === "reminder") {   // recallable later: "what did I need at the market?"
        const mem = STORE.mem[uid] = STORE.mem[uid] || [];
        remember(uid, `reminder: ${w.args?.what || w.label}${w.args?.place ? ` (at ${w.args.place})` : ""}`, { kind: "reminder" });
      }
      // run it once right away so there's a result today, not tomorrow
      runWatcher(uid, w).catch(() => {});
      return res.json({ ok: true, watcher: w, spoken: `Watching: ${w.label}. I'll have news in your morning brief.` });
    } catch { return res.status(200).json({ fallback: true, spoken: "Couldn't get that just now — give me another go in a moment.", detail: "parse_failed" }); }
  }
  res.status(400).json({ error: "bad action" });
});

// Batch 108: texts are the one thing worth pulling out of a busy inbox. This
// looks ONLY at @sms.teltel.com.au senders, remembers what he's already seen,
// and holds anything new so Vision can lead with it whenever he next opens up —
// even if the app has been shut for hours.
async function checkTexts(uid) {
  if (!mailReady()) return { messages: [], unread: 0 };
  try {
    const seen = (STORE.smsSeen || {})[uid] || 0;
    const out = await withInbox(async (client) => {
      const items = [];
      const all = await client.search({ since: new Date(Date.now() - 3 * 864e5) });
      for await (const msg of client.fetch(all.slice(-40).reverse(), { envelope: true, internalDate: true, source: true })) {
        const addr = msg.envelope?.from?.[0]?.address || "";
        const num = smsNumberFrom(addr);
        if (!num) continue;                              // not a text — skip the noise
        const at = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
        const body = extractPlainText(msg.source?.toString("utf8") || "")
          .replace(/reply directly to this email[\s\S]*/i, "")
          .replace(/^\s*>.*$/gm, "").replace(/\s+/g, " ").trim();
        if (body) items.push({ number: num, text: body.slice(0, 400), at, isNew: at > seen });
        if (items.length >= 15) break;
      }
      return items;
    });
    const fresh = (out || []).filter(m => m.isNew);
    // Every text lands in memory — so "what did that bloke say about the
    // delivery" works weeks later, and Vision learns who he actually texts.
    if (fresh.length) {
      const mem = STORE.mem[uid] = STORE.mem[uid] || [];
      for (const f of fresh) {
        remember(uid, `text from ${f.number}: ${f.text.slice(0, 160)}`, { kind: "text", at: f.at || Date.now(), save: false });
      }
      saveStore();
      STORE.smsHold = STORE.smsHold || {};
      STORE.smsHold[uid] = fresh.slice(0, 5);
      saveStore();
      dlog(uid, "services", `${fresh.length} new text${fresh.length === 1 ? "" : "s"}`);
    }
    return { messages: out || [], unread: fresh.length };
  } catch (e) { return { messages: [], unread: 0, error: String(e.message || e).slice(0, 80) }; }
}
// Waiting texts lead the brief — they're the most time-sensitive thing he has.
function textsBrief(uid) {
  const held = (STORE.smsHold || {})[uid] || [];
  if (!held.length) return "";
  return `UNREAD TEXTS — mention these FIRST, before anything else: ` +
    held.map(t => `${t.number} said "${t.text.slice(0, 90)}"`).join(" | ");
}
app.post("/texts/check", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const r = await checkTexts(uid);
  if ((req.body || {}).action === "clear") { STORE.smsHold = STORE.smsHold || {}; STORE.smsHold[uid] = []; STORE.smsSeen = STORE.smsSeen || {}; STORE.smsSeen[uid] = Date.now(); saveStore(); }
  res.json({ ...r, held: ((STORE.smsHold || {})[uid] || []), muted: isMuted(uid) });
});

/* --- VOICEMAIL (TelTel voicemail-to-email) ----------------------------------
 * TelTel emails each voicemail to his iCloud inbox: sender display "Voicemail",
 * subject "New Voicemail in VoIP VOICEMAIL From: <number>", and — crucially —
 * the TRANSCRIPT is already in the body (TelTel transcribes it), followed by
 * Time:/Duration:/Mailbox:/Regards. So we just read the transcript; no audio
 * transcription needed. Same watch-and-hold shape as checkTexts.
 */
const VM_SUBJECT_RE = /voicemail/i;
function voicemailNumberFrom(subject = "") {
  const m = String(subject).match(/from[:\s]+(\+?[\d ]{6,15})/i);
  return m ? m[1].replace(/\s/g, "") : "";
}
// TIGHT match — his iCloud inbox also gets NORMAL email, so a subject merely
// containing "voicemail" (a person's reply, a newsletter tip, another service)
// must NOT be read out as a voicemail. Require the real TelTel signature:
// subject "New Voicemail in VoIP" AND "From: <number>", or the TelTel body.
function isTelTelVoicemail(subj = "", fromName = "", body = "") {
  const s = String(subj);
  const teltelSubject = /new voicemail in voip/i.test(s) && /from[:\s]+\+?[\d ]{6,}/i.test(s);
  const teltelBody = /voip voicemail/i.test(body) && /teltel/i.test(body);
  return teltelSubject || teltelBody;
}
function voicemailTranscript(body = "") {
  // The body starts "From: <number>" then the transcript, then Time:/Duration:/
  // Mailbox:/Regards. Cut everything from the Time: line onward, drop the From: line.
  return String(body)
    .replace(/^\s*from:\s*\+?[\d ]+/i, "")
    .replace(/\btime:\s*\d[\s\S]*/i, "")          // Time:/Duration:/Mailbox:/Regards footer
    .replace(/this email was sent by[\s\S]*/i, "")
    .replace(/\s+/g, " ").trim();
}
async function checkVoicemail(uid) {
  if (!mailReady()) return { messages: [], unread: 0 };
  try {
    const seen = (STORE.vmSeen || {})[uid] || 0;
    const out = await withInbox(async (client) => {
      const items = [];
      const all = await client.search({ since: new Date(Date.now() - 3 * 864e5) });
      for await (const msg of client.fetch(all.slice(-40).reverse(), { envelope: true, internalDate: true, source: true })) {
        const subj = msg.envelope?.subject || "";
        const fromName = msg.envelope?.from?.[0]?.name || "";
        const plain = extractPlainText(msg.source?.toString("utf8") || "");
        // Only REAL TelTel voicemail emails — normal mail mentioning "voicemail" is skipped.
        if (!isTelTelVoicemail(subj, fromName, plain)) continue;
        const num = voicemailNumberFrom(subj);
        const at = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
        const transcript = voicemailTranscript(plain);
        if (transcript) items.push({ number: num || "unknown", transcript: transcript.slice(0, 500), at, isNew: at > seen });
        if (items.length >= 10) break;
      }
      return items;
    });
    const fresh = (out || []).filter(m => m.isNew);
    // A voicemail is a real occurrence with a person + consequence (someone needs
    // a callback) — log it through the salience gate so it survives and is recallable.
    if (fresh.length) {
      for (const f of fresh) {
        consider(uid, { kind: "voicemail", text: `voicemail from ${f.number}: ${f.transcript.slice(0, 160)}`, occurred: true, person: f.number !== "unknown", consequence: true, at: f.at || Date.now() });
      }
      STORE.vmHold = STORE.vmHold || {};
      STORE.vmHold[uid] = fresh.slice(0, 5);
      saveStore();
      dlog(uid, "services", `${fresh.length} new voicemail${fresh.length === 1 ? "" : "s"}`);
    }
    return { messages: out || [], unread: fresh.length };
  } catch (e) { return { messages: [], unread: 0, error: String(e.message || e).slice(0, 80) }; }
}
// Waiting voicemails lead the brief alongside texts — someone's waiting on a callback.
function voicemailBrief(uid) {
  const held = (STORE.vmHold || {})[uid] || [];
  if (!held.length) return "";
  return `UNHEARD VOICEMAILS — mention these, they may need a callback: ` +
    held.map(v => `${v.number}: "${v.transcript.slice(0, 110)}"`).join(" | ");
}

/* --- 🎼 THE CONDUCTOR (build 159) -------------------------------------------
 * The fusion layer. Everything above builds ingredients (calendar, jobs, texts,
 * voicemails, memory, weather, situation). The conductor is the only thing that
 * COMPOSES several of them into ONE human briefing for a moment — instead of him
 * tapping four tiles. It READS the shared briefs; it does NOT reach into any tile.
 *
 * moment: "morning" (day ahead, fused with where he is) | "here" (surroundings /
 * what he needs to know right now) | "evening" (what happened, what's still open).
 *
 * It gathers the briefs relevant to the moment, hands them to the model with a
 * fusion prompt, and returns { spoken, parts }. The CALLER decides whether Vision
 * is allowed to say it (that's the attention engine's job) — the conductor only
 * composes. Returns { spoken:"" } when there's genuinely nothing worth saying.
 */
function gatherBriefs(uid, moment, coords) {
  const safe = (fn) => { try { const v = fn(); return (typeof v === "string" && v.trim()) ? v.trim() : ""; } catch { return ""; } };
  const parts = {};
  // Always useful anchors.
  parts.now = safe(() => nowLine(uid, coords));
  parts.core = safe(() => coreBrief(uid));
  // Time-sensitive things that matter at ANY moment — someone waiting on him.
  parts.texts = safe(() => textsBrief(uid));
  parts.voicemails = safe(() => voicemailBrief(uid));
  if (moment === "morning") {
    parts.calendar = safe(() => calendarBrief(uid));
    parts.jobs = safe(() => jobBrief(uid));
    parts.upcoming = safe(() => upcomingBrief(uid));
    parts.expiry = safe(() => expiryBrief(uid));      // visas/SIM/docs about to lapse
    parts.pending = safe(() => pendingBrief(uid));    // promises he hasn't closed
  } else if (moment === "here") {
    parts.calendar = safe(() => calendarBrief(uid));
    parts.jobs = safe(() => jobBrief(uid));
    parts.recall = safe(() => recallBrief(uid, "where I am right now, this place, nearby"));
  } else if (moment === "evening") {
    parts.today = safe(() => daySummaryBrief(uid, 1));
    parts.pending = safe(() => pendingBrief(uid));
    parts.upcoming = safe(() => upcomingBrief(uid));
    parts.verdicts = safe(() => verdictBrief(uid));
  }
  return parts;
}
async function composeBriefing(uid, { moment = "morning", coords } = {}) {
  const parts = gatherBriefs(uid, moment, coords);
  // Nothing time-sensitive AND nothing scheduled → don't manufacture a briefing.
  const substantive = Object.entries(parts).filter(([k, v]) => v && k !== "now" && k !== "core");
  if (!substantive.length) return { spoken: "", parts, empty: true };

  const framing = {
    morning: "It's the start of his day. Give him a short, natural spoken briefing of what matters today — lead with anything time-sensitive (a text or voicemail waiting, an early job, a clash), then the shape of the day. He's travelling and working, so weave in where he is when it's relevant.",
    here: "He wants to know about where he is right now — his surroundings and anything he needs to operate here. Fuse what you know: where he is, what's on today, anything he's flagged about this place. Keep it to what's genuinely useful right now.",
    evening: "It's the end of his day. Give him a short spoken wind-down: what got done, anything still open (a promise he made, a callback owed), and what tomorrow holds. Warm, brief, not a report.",
  }[moment] || "Give him a short, natural spoken briefing of what matters.";

  const context = Object.entries(parts).filter(([, v]) => v).map(([k, v]) => `[${k}] ${v}`).join("\n");
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: "You are Vision, Shaun's AI companion in his glasses. You are the ONE voice that pulls together everything he'd otherwise check separately, into a single natural spoken briefing. " + framing +
      " Speak it the way a sharp, calm friend would — one flowing spoken passage, no lists, no headers, no preamble. Only include what's actually here; never invent events, times, or places not in the context. If two things connect (a voicemail from the same customer as a job), say so. Keep it under 60 words unless there's genuinely more he needs." + NO_INVENT_STRICT + SPOKEN_PLAIN +
      "\n\n" + nowLine(uid, coords),
    messages: [{ role: "user", content: `Here's what's on Shaun's plate right now:\n\n${context}\n\nGive him the briefing.` }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return { spoken: "", parts, error: "model" };
    const spoken = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    return { spoken, parts };
  } catch (e) { return { spoken: "", parts, error: String(e.message || e).slice(0, 80) }; }
}
app.post("/voicemail/check", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const r = await checkVoicemail(uid);
  if ((req.body || {}).action === "clear") { STORE.vmHold = STORE.vmHold || {}; STORE.vmHold[uid] = []; STORE.vmSeen = STORE.vmSeen || {}; STORE.vmSeen[uid] = Date.now(); saveStore(); }
  res.json({ ...r, held: ((STORE.vmHold || {})[uid] || []), muted: isMuted(uid) });
});

// The conductor, on demand. "brief me" (morning), "what's here" (here),
// "how'd today go" (evening). He PULLS the fusion — always allowed, no gating.
app.post("/brief", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const b = req.body || {};
  const moment = ["morning", "here", "evening"].includes(b.moment) ? b.moment : "morning";
  const coords = (b.lat != null) ? { lat: b.lat, lng: b.lng } : undefined;
  const r = await composeBriefing(uid, { moment, coords });
  if (r.empty) return res.json({ spoken: moment === "evening" ? "Quiet day — nothing outstanding." : "Nothing pressing right now — you're clear.", empty: true });
  res.json({ spoken: r.spoken || "I couldn't pull that together just now — try again in a moment.", moment });
});

// The volume knob HE holds. "stop"/"quiet" = mute proactive until lifted (-1).
// "later"/"not now" = hold for a while (default 2h). "go on"/"resume" = lift.
// Muting only silences PROACTIVE speech — collection keeps running (checkTexts,
// checkVoicemail, watchers) so nothing is lost; he can still PULL /brief anytime.
// Is proactive speech currently silenced by HIS choice? (arrival announcements
// check this so "stop"/"later" quiets texts/voicemail read-aloud too — the item
// still SHOWS silently, nothing lost, it just doesn't speak.)
function isMuted(uid) {
  const m = (STORE.conductorMute || {})[uid] || 0;
  return m === -1 || (m > Date.now());
}
app.post("/conductor", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const b = req.body || {};
  STORE.conductorMute = STORE.conductorMute || {};
  if (b.action === "stop") { STORE.conductorMute[uid] = -1; saveStore(); return res.json({ spoken: "Righto — I'll go quiet. I'll keep everything and you can say 'brief me' whenever.", state: "muted" }); }
  if (b.action === "later") { const mins = Math.min(Math.max(Number(b.minutes) || 120, 5), 720); STORE.conductorMute[uid] = Date.now() + mins * 60000; saveStore(); return res.json({ spoken: `No worries — I'll hold onto it and bring it up later.`, state: "held", until: STORE.conductorMute[uid] }); }
  if (b.action === "resume" || b.action === "lift") { STORE.conductorMute[uid] = 0; saveStore(); return res.json({ spoken: "Back with you.", state: "active" }); }
  const m = STORE.conductorMute[uid] || 0;
  res.json({ state: m === -1 ? "muted" : (m > Date.now() ? "held" : "active"), until: m > 0 ? m : undefined });
});

/* --- WATCHERS (batch 132 audit) ---------------------------------------------
 * Two bugs, both only visible over time:
 *
 * 1. A TRIGGERED WATCHER NEVER STOPPED. "Tell me if the fare drops below $800"
 *    fired the moment it did — correct — and then fired again every hour after
 *    that, with the same sentence, burning a web-search model call each time to
 *    re-discover something he'd already acted on. A watcher that repeats itself
 *    gets muted, which costs the next one that mattered.
 *
 * 2. The currency and weather branches used a bare fetch() with no timeout.
 *    Since batch 113 the hourly pass runs SEQUENTIALLY inside once(), so one
 *    hung endpoint stalls all eight watchers rather than just itself.
 * ------------------------------------------------------------------------ */
const WATCH_TIMEOUT_MS = 10000;

async function watchFetch(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), WATCH_TIMEOUT_MS);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); }
  finally { clearTimeout(t); }
}

// Has this watcher already said this, recently enough that saying it again is
// nagging rather than news? Compared on the SPOKEN LINE, so a fare that moves
// still gets through while a fare that hasn't doesn't.
function watchIsRepeat(uid, w, spoken) {
  const results = (STORE.results || {})[uid] || [];
  const last = results.filter(r => r.id === w.id && r.triggered).slice(-1)[0];
  if (!last) return false;
  const sameThing = String(last.spoken || "").trim() === String(spoken || "").trim();
  const hoursSince = (Date.now() - (last.at || 0)) / 3600000;
  // Identical wording within a day is a repeat. After that, a nudge is fair.
  return sameThing && hoursSince < 24;
}

async function runWatcher(uid, w) {
  let spoken = "", triggered = false;
  try {
    if (w.type === "reminder") {
      const due = w.args && w.args.dueISO ? Date.parse(w.args.dueISO) : null;
      if (due && Date.now() >= due) {
        spoken = `⏰ Reminder: ${w.args.what || w.label}`;
        triggered = true;
        // one-shot: dated reminders retire once delivered
        STORE.watchers[uid] = (STORE.watchers[uid] || []).filter(x => x.id !== w.id);
        saveStore();
      } else if (!due) {
        // place/undated reminders live in memory for recall, not repetition
        spoken = ""; triggered = false;
      }
      if (spoken) {
        const results = STORE.results[uid] = STORE.results[uid] || [];
        results.push({ at: Date.now(), id: w.id, label: w.label, spoken, triggered });
        while (results.length > 30) results.shift();
        saveStore();
      }
      return;
    }
    if (w.type === "currency") {
      const r = await watchFetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(w.args.from || "AUD")}&to=${encodeURIComponent(w.args.to || "USD")}`);
      const rate = Object.values(r.rates || {})[0];
      if (rate != null) {
        triggered = w.threshold ? rate >= w.threshold : true;
        spoken = `${w.args.from || "AUD"} is at ${rate} ${w.args.to || ""}${w.threshold ? (triggered ? ` — past your ${w.threshold} mark.` : ` (watching for ${w.threshold}).`) : "."}`;
      }
    } else if (w.type === "weather") {
      const g = await watchFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(w.args.place || "")}&count=1`);
      const loc = (g.results || [])[0];
      if (loc) {
        const f = await watchFetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&daily=temperature_2m_max,precipitation_probability_max&forecast_days=${Math.min(w.args.days || 5, 7)}`);
        const d = f.daily || {};
        const days = (d.time || []).map((t, i) => `${t.slice(5)}: ${Math.round(d.temperature_2m_max[i])}°, ${d.precipitation_probability_max[i]}% rain`).join("; ");
        spoken = `${w.args.place} next days — ${days}.`; triggered = true;
      }
    } else {
      // flightdeal + events: live web search via the brain
      const q = w.type === "flightdeal"
        ? `Current cheapest one-way and return fares ${w.args.from || ""} to ${w.args.to || ""} ${w.args.when || ""}. Reply JSON only: {"price": <lowest typical AUD number>, "note": "one short sentence"}`
        : `Events on in ${w.args.area || ""} ${w.args.when || "this weekend"}. Reply JSON only: {"note": "one short spoken sentence naming the best 1-2, or say nothing found"}`;
      const body = { model: "claude-haiku-4-5-20251001", max_tokens: 300,
        // Batch 118 audit: no system prompt. This runs unattended on a watcher
        // and its output LEADS his brief, so an invented event is something he
        // acts on without ever having asked a question.
        system:
          "You answer a standing watch with one short spoken sentence. " +
          "Only report what the search results actually show. If they show nothing useful, say nothing found — " +
          "an empty answer is correct and expected most of the time." + NO_INVENT_STRICT + SPOKEN_PLAIN,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }], messages: [{ role: "user", content: q }] };
      const { status, text } = await callClaude(body);
      if (status === 200) {
        const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
        let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { note: raw.slice(0, 200) }; }
        if (w.type === "flightdeal" && p.price != null) {
          triggered = w.threshold ? p.price <= w.threshold : true;
          spoken = `${w.label}: around $${p.price}${w.threshold ? (triggered ? ` — under your $${w.threshold} mark!` : ` (waiting for $${w.threshold}).`) : "."} ${p.note || ""}`;
        } else { spoken = `${w.label}: ${p.note || "nothing new."}`; triggered = !/nothing/i.test(spoken); }
      }
    }
  } catch { /* one failed run is fine; next hour tries again */ }
  if (spoken) {
    // Batch 132 audit: a triggered watcher used to re-fire the SAME sentence
    // every hour, forever. Recording it as untriggered keeps it in the log
    // (so "what have my watchers found" still shows it) without pushing it at
    // him again — the alert stays news rather than becoming noise.
    if (triggered && watchIsRepeat(uid, w, spoken)) {
      triggered = false;
    }
    const results = STORE.results[uid] = STORE.results[uid] || [];
    results.push({ at: Date.now(), id: w.id, label: w.label, spoken, triggered });
    while (results.length > 30) results.shift();
    saveStore();
  }
}
// Hourly sweep + first run a minute after boot.
setInterval(() => once("watchers", async () => {
  for (const [uid, list] of Object.entries(STORE.watchers)) for (const w of list) await runWatcher(uid, w).catch(() => {});
}), 3600000);
// Texts are checked far more often than watchers — every 4 minutes — because a
/* --- SCHEDULER ORCHESTRATION (batch 112 audit) -----------------------------
 * Audit found five independent setIntervals with no coordination:
 *   distil+learnProcedure 24h | watchers 1h | checkTexts 4min
 *   self-ping 10min | checkCalendar 15min
 * Two real problems:
 *   1. They all land on the same tick every hour — watchers (model calls) +
 *      texts (IMAP) + calendar (CalDAV) + ping, simultaneously, on a 512MB dyno.
 *   2. No re-entrancy guard, so a slow run and the next tick overlap and stack.
 * This fixes both: a named guard that skips rather than queues, and a small
 * offset per job so they no longer share a tick.
 * ------------------------------------------------------------------------ */
const _running = Object.create(null);
async function once(name, fn) {
  if (_running[name]) { dlog(null, "errors", `scheduler ${name} still running — skipped this tick`); return; }
  _running[name] = Date.now();
  try { await fn(); }
  catch (e) { try { dlog(null, "errors", `scheduler ${name} failed: ${String(e.message || e).slice(0, 120)}`); } catch {} }
  finally { delete _running[name]; }
}
// Stagger so the hourly marks don't coincide. Prime-ish offsets, not round.
const OFFSET = { watchers: 0, texts: 37000, calendar: 71000, distil: 113000 };

// text sitting unseen for an hour is useless. Cheap: one IMAP call, no model.
setTimeout(() => setInterval(() => once("texts", async () => {
  for (const uid of Object.keys(STORE.profiles || { "shaun-default": 1 })) { await checkTexts(uid).catch(() => {}); await checkVoicemail(uid).catch(() => {}); }
}), 240000), OFFSET.texts);
setTimeout(() => { for (const [uid, list] of Object.entries(STORE.watchers)) for (const w of list) runWatcher(uid, w).catch(() => {}); }, 60000);

app.get("/ping", (_req, res) => res.type("text/plain").send("ok"));

// Self-ping every 10 min to stay warm (fixes the ~30-50s cold-start on first use).
// SELF_URL should be this service's own address, e.g. https://my-buddy-xu2x.onrender.com
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/ping`).catch(() => {}); // best-effort, ignore errors
  }, 10 * 60 * 1000);
}


/* ===========================================================================
 * BATCH 109 — CALENDAR + LISTS + GEEKS2U WORK LAYER
 *
 * Three things, all sharing the same CalDAV plumbing:
 *   A. iCloud calendars + reminder lists (read, monitor, tick off, add)
 *   B. Geeks2U job layer (ICS feed, dual timezone, dictated job reports)
 *   C. Screenshot -> job record (sidesteps the VPN-gated CRM)
 *
 * Credentials reused from the existing mail setup: ICLOUD_USER / ICLOUD_APP_PW.
 * New optional env: GEEKS2U_ICS_URL
 * ======================================================================== */

const CAL = require("./caldav");

Object.defineProperty(globalThis, "GEEKS2U_ICS", { get: () => envKey("GEEKS2U_ICS_URL", process.env.GEEKS2U_ICS_URL) });

// Shaun works AEST hours from Asia — every work time gets shown in both.
const WORK_TZ = "Australia/Brisbane" + SPOKEN_PLAIN;

function calReady() { return !!(ICLOUD_USER && ICLOUD_APP_PW); }

function calPrefsOf(uid) {
  STORE.calPrefs = STORE.calPrefs || {};
  return STORE.calPrefs[uid] || {};
}

/* --- source discovery, cached ------------------------------------------ */
// Discovery is several round-trips to Apple, so it's cached for an hour.
// The picker forces a refresh so a list made a minute ago shows up.
async function calSources(uid, { force = false } = {}) {
  STORE.calCache = STORE.calCache || {};
  const cached = STORE.calCache[uid];
  if (!force && cached && (Date.now() - cached.at) < 3600000) {
    return { ok: true, sources: CAL.mergePrefs(cached.sources, calPrefsOf(uid)), cached: true };
  }
  if (!calReady()) return { ok: false, error: "iCloud isn't set up yet — add ICLOUD_USER and ICLOUD_APP_PW.", sources: [] };

  const r = await CAL.discover({ user: ICLOUD_USER, pw: ICLOUD_APP_PW });
  if (!r.ok) return { ok: false, error: r.error, sources: [] };

  STORE.calCache[uid] = { at: Date.now(), sources: r.sources };
  // Batch 139 sweep: calPrefs kept a key per source forever, so a list he
  // deleted in iCloud left its preference behind indefinitely. Discovery
  // already knows exactly what exists — prune against it. Feed prefs are
  // kept because they aren't CalDAV sources and won't appear here.
  try {
    const live = new Set(r.sources.map(s => s.id));
    const prefs = (STORE.calPrefs || {})[uid];
    if (prefs) {
      for (const id of Object.keys(prefs)) {
        if (!live.has(id) && !id.startsWith("ics:")) delete prefs[id];
      }
    }
  } catch {}
  saveStore();
  return { ok: true, sources: CAL.mergePrefs(r.sources, calPrefsOf(uid)), cached: false };
}

function icsFeeds(uid) {
  const prefs = calPrefsOf(uid);
  const id = "ics:geeks2u";
  if (!GEEKS2U_ICS) return [];
  const p = prefs[id] || {};
  return [{ id, url: GEEKS2U_ICS, name: "Geeks2U jobs", read: !!p.read, monitor: !!p.monitor }];
}

/* --- dual timezone ------------------------------------------------------ */
// A Geeks2U job is booked in AEST but Shaun is 2-3h behind in Asia. Saying
// only one of those is how a job gets missed, so work events carry both.
function bothZones(d) {
  if (!d) return "";
  const au = d.toLocaleTimeString("en-AU", { timeZone: WORK_TZ, hour: "numeric", minute: "2-digit", hour12: true });
  const here = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true });
  return au === here ? au : `${au} AEST (${here} your time)`;
}

function isWorkEvent(e) {
  return /geeks2u|job\s*[:#]?\s*\d{6,}/i.test(`${e.title || ""} ${e.sourceName || ""}`);
}

function jobNumberOf(text) {
  const m = /\b(\d{6,8})\b/.exec(String(text || ""));
  return m ? m[1] : "";
}

/* --- gather everything the user has switched on ------------------------- */
async function calGather(uid, { days = 14, force = false } = {}) {
  const s = await calSources(uid, { force });
  if (!s.ok) return { ok: false, error: s.error, events: [], todos: [] };

  const on = s.sources.filter(x => x.read || x.monitor);
  const feeds = icsFeeds(uid).filter(f => f.read || f.monitor);

  const from = CAL.startOfDay();
  const to = new Date(Date.now() + days * 864e5);

  const g = await CAL.gather(on, {
    user: ICLOUD_USER, pw: ICLOUD_APP_PW,
    from, to,
    icsFeeds: feeds.map(f => ({ url: f.url, name: f.name })),
    todoLimit: 120,
  });

  return { ok: true, ...g, sources: s.sources };
}

/* --- endpoints: picker -------------------------------------------------- */

app.post("/calendar/sources", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { refresh } = req.body || {};
  const s = await calSources(uid, { force: !!refresh });
  if (!s.ok) return res.status(200).json({ ok: false, error: s.error, sources: [], feeds: [] });
  res.json({
    ok: true,
    cached: s.cached,
    sources: s.sources.map(x => ({
      id: x.id, name: x.name, kind: x.kind,
      sharedByOther: x.sharedByOther, readOnly: x.readOnly,
      read: x.read, monitor: x.monitor,
    })),
    feeds: icsFeeds(uid).map(f => ({ id: f.id, name: f.name, kind: "calendar", readOnly: true, read: f.read, monitor: f.monitor })),
  });
});

// One-tap health check: is iCloud actually connected, and is the Geeks2U feed
// live? Reports each leg plainly ("iCloud: 4 calendars ✓ · Geeks2U: not set")
// so he never has to infer connection from whether events happen to show.
app.post("/calendar/selftest", requireAuth, async (req, res) => {
  const out = { ok: true, icloud: {}, geeks2u: {} };

  // Leg 1 — iCloud CalDAV discovery
  if (!ICLOUD_USER || !ICLOUD_APP_PW) {
    out.icloud = { ok: false, spoken: "iCloud isn't set up — add ICLOUD_USER and an app-specific ICLOUD_APP_PW." };
  } else {
    try {
      const r = await CAL.discover({ user: ICLOUD_USER, pw: ICLOUD_APP_PW });
      if (!r.ok) out.icloud = { ok: false, spoken: `iCloud connected but discovery failed: ${r.error}` };
      else {
        const calSrcs = (r.sources || []).filter(x => x.kind !== "reminders");
        const cals = calSrcs.length;
        const lists = (r.sources || []).filter(x => x.kind === "reminders").length;
        // Is the Geeks2U calendar visible via CalDAV discovery? Subscribed feeds
        // sometimes aren't — if so he needs GEEKS2U_ICS_URL instead.
        const g2uInDiscovery = calSrcs.some(x => /geeks2u/i.test(x.name || ""));
        out.icloud = { ok: true, calendars: cals, lists,
          names: calSrcs.map(x => x.name), geeks2uFound: g2uInDiscovery,
          spoken: `iCloud connected — ${cals} calendar${cals === 1 ? "" : "s"} and ${lists} reminder list${lists === 1 ? "" : "s"} found${g2uInDiscovery ? ", including your Geeks2U calendar" : ""}.` };
      }
    } catch (e) {
      out.icloud = { ok: false, spoken: `iCloud check failed: ${String(e && e.message || e).slice(0, 120)}` };
    }
  }

  // Leg 2 — Geeks2U ICS feed
  if (!GEEKS2U_ICS) {
    out.geeks2u = out.icloud.geeks2uFound
      ? { ok: true, configured: false, viaICloud: true,
          spoken: "Geeks2U jobs are already coming through your iCloud (the subscribed calendar) — no separate feed URL needed. Just make sure it's switched on in the picker." }
      : { ok: false, configured: false,
          spoken: "Geeks2U jobs feed isn't set — and it didn't show up in your iCloud calendars either. Either switch on 'My Geeks2U Calendar' in Apple Calendar so it syncs, or add GEEKS2U_ICS_URL (the .ics subscribe link) on the server." };
  } else {
    try {
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 8000);
      let text = "";
      try {
        const gr = await fetch(GEEKS2U_ICS, { signal: ac.signal, headers: { "user-agent": "Mozilla/5.0 (VisionCal)" } });
        if (!gr.ok) { out.geeks2u = { ok: false, configured: true, spoken: `Geeks2U feed is set but returned ${gr.status} — check the URL is still valid.` }; }
        else { text = await gr.text(); }
      } finally { clearTimeout(to); }
      if (text) {
        const isCal = /BEGIN:VCALENDAR/i.test(text);
        const events = (text.match(/BEGIN:VEVENT/gi) || []).length;
        out.geeks2u = isCal
          ? { ok: true, configured: true, events, spoken: `Geeks2U feed connected — ${events} job${events === 1 ? "" : "s"} in the feed.` }
          : { ok: false, configured: true, spoken: "Geeks2U URL responded but it doesn't look like a calendar feed — double-check it's the .ics link." };
      }
    } catch (e) {
      out.geeks2u = { ok: false, configured: true,
        spoken: `Geeks2U feed is set but wouldn't load: ${String(e && e.message || e).slice(0, 120)}.` };
    }
  }

  out.spoken = `${out.icloud.spoken} ${out.geeks2u.spoken}`;
  res.json(out);
});

// Two independent switches per source. Both off = Vision ignores it entirely.
app.post("/calendar/prefs", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const { id, read, monitor, all } = req.body || {};
  STORE.calPrefs = STORE.calPrefs || {};
  const prefs = STORE.calPrefs[uid] = STORE.calPrefs[uid] || {};

  if (all && typeof all === "object") {
    for (const [k, v] of Object.entries(all)) prefs[k] = { read: !!v.read, monitor: !!v.monitor };
  } else if (id) {
    prefs[id] = { read: !!read, monitor: !!monitor };
  } else {
    return res.status(400).json({ error: "id or all required" });
  }
  saveStore();
  dlog(uid, "memory", `calendar prefs updated (${Object.keys(prefs).length} sources)`);
  res.json({ ok: true, prefs });
});

/* --- endpoints: reading ------------------------------------------------- */

app.post("/calendar/day", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const g = await calGather(uid, { days: Number((req.body || {}).days) || 7 });
  if (!g.ok) return res.status(200).json({ ok: false, spoken: g.error, events: [], todos: [] });

  const brief = CAL.buildDayBrief(g.events, g.todos);
  // Work jobs get both timezones; personal events don't need it.
  const spoken = brief.spoken + (() => {
    const jobs = brief.events.filter(isWorkEvent);
    if (!jobs.length) return "";
    return " " + jobs.map(j => `${j.title} is ${bothZones(j.start)}`).join(", ") + ".";
  })();

  res.json({
    ok: true,
    spoken: spoken.trim() || "Nothing on today.",
    counts: brief.counts,
    events: brief.events.map(e => ({
      title: e.title, start: e.start, allDay: e.allDay, location: e.location,
      source: e.sourceName, shared: e.sharedByOther,
      work: isWorkEvent(e), job: isWorkEvent(e) ? jobNumberOf(e.title) : "",
      whenBoth: isWorkEvent(e) ? bothZones(e.start) : "",
    })),
    dueToday: brief.dueToday.map(t => ({ title: t.title, source: t.sourceName, due: t.due })),
    overdue: brief.overdue.map(t => ({ title: t.title, source: t.sourceName, due: t.due })),
    errors: g.errors,
  });
});

app.post("/calendar/list", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });

  const s = await calSources(uid);
  if (!s.ok) return res.status(200).json({ ok: false, spoken: s.error });

  const on = s.sources.filter(x => x.read || x.monitor);
  const m = CAL.matchList(name, on, "reminders");

  if (m.status === "none") {
    return res.json({ ok: false, spoken: `I couldn't find a list called "${name}". Turn it on in the picker if it's new.` });
  }
  if (m.status === "ambiguous") {
    // "to do" hits three of his lists — ask rather than pick the shortest.
    return res.json({ ok: false, ambiguous: true, candidates: m.candidates.map(c => ({ id: c.id, name: c.name })),
      spoken: `Which one — ${m.candidates.map(c => c.name).join(", ")}?` });
  }

  const r = await CAL.readTodos(m.source, { user: ICLOUD_USER, pw: ICLOUD_APP_PW, limit: 60 });
  if (!r.ok) return res.status(200).json({ ok: false, spoken: `Couldn't read ${m.source.name} — ${r.error}` });

  const names = r.todos.map(t => t.title);
  res.json({
    ok: true,
    list: m.source.name,
    shared: m.source.sharedByOther,
    total: r.total,
    truncated: r.truncated,
    items: names,
    spoken: names.length
      ? `${m.source.name}: ${names.slice(0, 12).join(", ")}${r.total > 12 ? `, and ${r.total - 12} more` : ""}.`
      : `${m.source.name} is empty.`,
  });
});

/* --- endpoints: writing (always confirmed first) ------------------------ */

// Step 1 of ticking off. Never writes — returns what it WOULD do plus the
// sentence to speak. Four of his lists are his wife's, so a mis-parse is
// someone else's problem, not just his.
app.post("/calendar/tick/prepare", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { list, utterance } = req.body || {};
  if (!utterance) return res.status(400).json({ error: "utterance required" });

  const s = await calSources(uid);
  if (!s.ok) return res.status(200).json({ ok: false, spoken: s.error });

  const on = s.sources.filter(x => x.read || x.monitor);
  const m = CAL.matchList(list || "", on, "reminders");
  if (m.status !== "match") {
    return res.json({ ok: false, ambiguous: m.status === "ambiguous",
      candidates: (m.candidates || []).map(c => ({ id: c.id, name: c.name })),
      spoken: m.status === "ambiguous" ? `Which list — ${m.candidates.map(c => c.name).join(", ")}?` : `Which list did you mean?` });
  }

  const p = await CAL.prepareTickOff(utterance, m.source, { user: ICLOUD_USER, pw: ICLOUD_APP_PW });
  if (!p.ok) return res.json({ ok: false, spoken: p.error, missing: p.missing || [], ambiguous: p.ambiguous || [] });

  STORE.calPending = STORE.calPending || {};
  const _tickToken = "tk" + Date.now() + "-" + String(p.items.length) + "-" + Math.random().toString(36).slice(2, 8);
  STORE.calPending[uid] = {
    at: Date.now(),
    token: _tickToken,
    sourceId: m.source.id,
    items: p.items.map(x => ({ uid: x.todo.uid, title: x.todo.title, href: x.todo.href, etag: x.todo.etag, raw: x.todo.raw })),
  };
  saveStore();

  res.json({
    ok: true, needsConfirmation: true, spoken: p.confirm, token: _tickToken,
    list: m.source.name, shared: m.source.sharedByOther,
    items: p.items.map(x => x.todo.title),
    missing: p.missing, ambiguous: p.ambiguous.map(a => ({ spoken: a.spoken, options: a.options.map(o => o.title) })),
  });
});

// Step 2 — only after he says yes.
app.post("/calendar/tick/confirm", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { token } = req.body || {};
  const pend = (STORE.calPending || {})[uid];
  if (!pend || (Date.now() - pend.at) > 600000) {
    return res.json({ ok: false, spoken: "That's expired — say what you want ticked off again." });
  }
  // Confirm exactly what was read back. If a newer prepare replaced it (e.g. he
  // prepared a second list before tapping yes), the token won't match — refuse
  // rather than tick the wrong list. Critical for the shared lists that are hers.
  if (token && pend.token && token !== pend.token) {
    return res.json({ ok: false, spoken: "That changed since I read it back — say what you want ticked off again so I don't tick the wrong list." });
  }

  const done = [], failed = [];
  for (const it of pend.items) {
    const r = await CAL.completeTodo(it, { user: ICLOUD_USER, pw: ICLOUD_APP_PW });
    if (r.ok) done.push(it.title); else failed.push({ title: it.title, error: r.error });
  }

  // Ticking something off says he actually does the thing — worth remembering.
  for (const t of done) { remember(uid, `ticked off: ${t}`, { kind: "task", save: false }); }

  STORE.calPending[uid] = null;
  saveStore();
  dlog(uid, "memory", `ticked ${done.length} item(s)`);

  res.json({
    ok: !!done.length, done, failed,
    spoken: done.length
      ? `Done — ${done.join(" and ")} ticked off.${failed.length ? ` ${failed.length} didn't go through.` : ""}`
      : "None of those went through.",
  });
});

app.post("/calendar/add", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { list, item, due } = req.body || {};
  if (!item) return res.status(400).json({ error: "item required" });

  const s = await calSources(uid);
  if (!s.ok) return res.status(200).json({ ok: false, spoken: s.error });

  const on = s.sources.filter(x => x.read || x.monitor);
  const m = CAL.matchList(list || "", on, "reminders");
  if (m.status !== "match") {
    return res.json({ ok: false, ambiguous: m.status === "ambiguous",
      candidates: (m.candidates || []).map(c => ({ id: c.id, name: c.name })),
      spoken: `Which list — ${(m.candidates || []).map(c => c.name).join(", ") || "say the name"}?` });
  }

  const r = await CAL.addTodo(m.source, {
    user: ICLOUD_USER, pw: ICLOUD_APP_PW,
    title: item, due: due ? new Date(due) : null,
  });
  if (!r.ok) return res.status(200).json({ ok: false, spoken: `Couldn't add that — ${r.error}` });

  res.json({ ok: true, spoken: `Added ${item} to ${m.source.name}.`, list: m.source.name, shared: m.source.sharedByOther });
});

app.post("/calendar/event", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { calendar, title, start, end, location, notes } = req.body || {};
  if (!title || !start) return res.status(400).json({ error: "title and start required" });

  const s = await calSources(uid);
  if (!s.ok) return res.status(200).json({ ok: false, spoken: s.error });

  const on = s.sources.filter(x => (x.read || x.monitor) && !x.readOnly && x.kind === "calendar");
  const m = CAL.matchList(calendar || "", on, "calendar");
  const target = m.status === "match" ? m.source : on[0];
  if (!target) return res.json({ ok: false, spoken: "No writable calendar is switched on." });

  const startD = new Date(start);
  const r = await CAL.createEvent(target, {
    user: ICLOUD_USER, pw: ICLOUD_APP_PW,
    title, start: startD, end: end ? new Date(end) : null, location, notes,
  });
  if (!r.ok) return res.status(200).json({ ok: false, spoken: `Couldn't add that — ${r.error}` });

  res.json({ ok: true, spoken: `Put "${title}" in ${target.name} for ${bothZones(startD)}.`, calendar: target.name });
});

/* --- free/busy for the planner ------------------------------------------ */
// The planner used to propose into a void. Now it can check.
app.post("/calendar/free", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { start, end, minutes, days } = req.body || {};
  const g = await calGather(uid, { days: Number(days) || 7 });
  if (!g.ok) return res.status(200).json({ ok: false, error: g.error });

  if (start && end) {
    const r = CAL.isFree(g.events, new Date(start), new Date(end));
    return res.json({
      ok: true, free: r.free,
      clashes: r.clashes.map(c => ({ title: c.title, start: c.start, end: c.end, source: c.sourceName })),
      spoken: r.free ? "You're free then." : `That clashes with ${r.clashes.map(c => c.title).join(" and ")}.`,
    });
  }

  const slots = CAL.findSlots(g.events, {
    from: new Date(), to: new Date(Date.now() + (Number(days) || 7) * 864e5),
    minutes: Number(minutes) || 60,
  });
  res.json({ ok: true, slots: slots.map(s => ({ start: s.start, end: s.end, whenBoth: bothZones(s.start) })) });
});

/* --- B. GEEKS2U JOB REPORTS --------------------------------------------- */

// His actual house format, taken from a closed invoice: dashed bullets,
// past tense, one action per line, ending with the two standard closers.
const JOB_REPORT_STYLE =
  "Write it as a Geeks2U service description in EXACTLY this house style:\n" +
  "- dashed bullet lines, one action per line, past tense, plain English\n" +
  "- no preamble, no heading, no sign-off, no markdown\n" +
  "- keep each line short and factual, the way a tech writes it up\n" +
  "- ALWAYS finish with these two lines exactly:\n" +
  "- All issues resolved\n" +
  "- Provided general advice and support\n" +
  "Example of the expected shape:\n" +
  "- Resolved issue with Imap folders and PST files in Outlook profile\n" +
  "- Advise on managing Imap emails folders and storage\n" +
  "- All issues resolved\n" +
  "- Provided general advice and support";

// STORE.jobs is keyed by job number, so the usual array trims don't apply and
// it would grow one key per job forever — every save rewrites the whole store,
// so this bloats every write, not just job lookups. ~3 jobs/day is ~1000/year.
// Keep the most recent 300 and drop the oldest; the reports still live in mem.
function trimJobs(uid) {
  const jobs = (STORE.jobs || {})[uid];
  if (!jobs) return;
  const keys = Object.keys(jobs);
  if (keys.length <= 300) return;
  keys.sort((a, b) => (jobs[a].at || 0) - (jobs[b].at || 0));
  for (const k of keys.slice(0, keys.length - 300)) delete jobs[k];
}

app.post("/job/report", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { job, dictation, customer } = req.body || {};
  const jobNo = jobNumberOf(job) || String(job || "").trim();
  if (!dictation) return res.status(400).json({ error: "dictation required" });

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system:
      "You turn a technician's spoken account of a remote IT support job into the service description that closes the job in the Geeks2U system. " +
      "Write ONLY what he actually says he did — never invent steps, findings, parts or outcomes. " +
      "If he was vague, stay vague rather than inventing detail. " +
      JOB_REPORT_STYLE,
    messages: [{ role: "user", content: `What I did on the job:\n${dictation}` }],
  };

  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't write that up — try again in a moment." });
    const report = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();

    STORE.jobs = STORE.jobs || {};
    const jobs = STORE.jobs[uid] = STORE.jobs[uid] || {};
    const rec = jobs[jobNo] = jobs[jobNo] || { job: jobNo, at: Date.now() };
    rec.report = report;
    rec.dictation = String(dictation).slice(0, 1200);
    rec.reportedAt = Date.now();
    if (customer) rec.customer = String(customer).slice(0, 120);
    trimJobs(uid);

    // Into the shared pool so recall works months later, by number or name.
    const mem = STORE.mem[uid] = STORE.mem[uid] || [];
    remember(uid, `job ${jobNo}${rec.customer ? ` (${rec.customer})` : ""}: ${report.replace(/\n/g, " ").slice(0, 300)}`, { kind: "job" });
    saveStore();

    dlog(uid, "memory", `job report written for ${jobNo}`);
    res.json({ ok: true, job: jobNo, report, spoken: `Written up for ${jobNo}. Copy it across when you're ready.` });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Report hiccup — say it again and I'll write it up." });
  }
});

// C. Screenshot -> job record. The CRM is behind a VPN with no API, so the
// way in is showing Vision the screen rather than reaching the system.
app.post("/job/capture", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { images, image, mediaType, job } = req.body || {};
  const shots = Array.isArray(images) ? images.slice(0, 3) : (image ? [image] : []);
  if (!shots.length) return res.status(400).json({ error: "image(s) required" });

  const content = [
    ...shots.map(d => ({ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: d } })),
    { type: "text", text:
      "These are screenshots of a Geeks2U job in the BMS (they may be different tabs of the SAME job — merge them). " +
      "Extract what is actually visible. Reply as compact JSON ONLY (no markdown) with keys: " +
      "\"job\" (job ID number), \"customerId\", \"customer\" (name), \"phone\", \"type\", \"pricing\", \"appointment\" (as shown), " +
      "\"problem\" (the problem/description text), \"devices\", \"os\". " +
      "Use \"\" for anything not visible — NEVER guess a phone number or a job ID." },
  ];

  try {
    const { status, text: out } = await callClaude({
      model: "claude-sonnet-4-6", max_tokens: 600,
      system: "You read IT job-management screenshots and extract the fields exactly as shown. Accuracy matters more than completeness — an empty field is always better than a guessed one.",
      messages: [{ role: "user", content }],
    });
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't read that screen — try a clearer shot." });

    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = {}; }

    const jobNo = jobNumberOf(job) || jobNumberOf(p.job) || "";
    if (!jobNo) return res.json({ ok: false, spoken: "I couldn't see a job number on that — say it and I'll file it." , parsed: p });

    STORE.jobs = STORE.jobs || {};
    const jobs = STORE.jobs[uid] = STORE.jobs[uid] || {};
    const rec = jobs[jobNo] = jobs[jobNo] || { job: jobNo, at: Date.now() };
    for (const k of ["customerId", "customer", "phone", "type", "pricing", "appointment", "problem", "devices", "os"]) {
      if (p[k]) rec[k] = String(p[k]).slice(0, 400);
    }
    rec.capturedAt = Date.now();
    trimJobs(uid);

    const mem = STORE.mem[uid] = STORE.mem[uid] || [];
    remember(uid, `job ${jobNo}${rec.customer ? ` — ${rec.customer}` : ""}${rec.phone ? ` (${rec.phone})` : ""}: ${(rec.problem || "").slice(0, 200)}`, { kind: "job" });
    saveStore();

    dlog(uid, "memory", `job ${jobNo} captured from screenshot`);
    // Read back rather than assert — OCR gets phone numbers wrong.
    res.json({
      ok: true, job: jobNo, record: rec,
      spoken: `Filed job ${jobNo}${rec.customer ? ` for ${rec.customer}` : ""}${rec.phone ? `, ${rec.phone}` : ""}. Check that's right.`,
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't read that screen — try again." });
  }
});

app.post("/job/recall", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const { query } = req.body || {};
  const jobs = (STORE.jobs || {})[uid] || {};
  const all = Object.values(jobs);
  if (!all.length) return res.json({ ok: false, spoken: "No jobs filed yet — capture one or dictate a report and I'll keep it." });

  const q = String(query || "").trim();
  if (!q) {
    const recent = all.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 5);
    return res.json({ ok: true, jobs: recent, spoken: `Last few: ${recent.map(j => `${j.job}${j.customer ? ` (${j.customer})` : ""}`).join(", ")}.` });
  }

  const byNumber = jobNumberOf(q);
  let hits = byNumber ? all.filter(j => j.job === byNumber) : [];
  if (!hits.length) {
    // fall back to fuzzy on the customer name — "the Brecht job"
    hits = all
      .map(j => ({ j, score: Math.max(CAL.similarity(q, j.customer || ""), CAL.similarity(q, j.problem || "") * 0.6) }))
      .filter(x => x.score > 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(x => x.j);
  }
  if (!hits.length) return res.json({ ok: false, spoken: `Nothing filed matching "${q}".` });

  const top = hits[0];
  res.json({
    ok: true, jobs: hits, job: top,
    spoken: `Job ${top.job}${top.customer ? ` — ${top.customer}` : ""}. ${top.report ? top.report.replace(/\n/g, ". ") : (top.problem || "No report written up.")}`,
  });
});

/* --- briefs into the brain ---------------------------------------------- */

function calendarBrief(uid) {
  const held = (STORE.calHold || {})[uid];
  if (!held || !held.spoken) return "";
  return `CALENDAR — worth raising: ${held.spoken}`;
}

function jobBrief(uid) {
  const today = (STORE.calToday || {})[uid];
  if (!today || !today.jobs || !today.jobs.length) return "";
  // Batch 113 audit: this said "get the VPN up" all day regardless of when the
  // job was — a standing instruction, not anticipation. Timing is the whole
  // difference: the nudge is only useful in the window before it starts, and
  // afterwards what matters is the report that closes it.
  const now = Date.now();
  const withTime = today.jobs.map(j => ({ ...j, ms: j.startMs || 0 }));
  const next = withTime.filter(j => j.ms && j.ms > now).sort((a, b) => a.ms - b.ms)[0];
  const done = withTime.filter(j => j.ms && j.ms < now);

  const lines = [`WORK TODAY (Geeks2U — AEST and his local time): ` +
    withTime.map(j => `${j.title} at ${j.whenBoth}`).join(" | ")];

  if (next) {
    const mins = Math.round((next.ms - now) / 60000);
    if (mins <= 20) lines.push(`${next.title} starts in ${mins} min — VPN up and the jobs tab open NOW if it isn't already. Say this first.`);
    else if (mins <= 60) lines.push(`${next.title} is in ${mins} min. Worth a quiet word about the VPN if the conversation lulls.`);
  }
  if (done.length) {
    lines.push(`${done.length} job${done.length > 1 ? "s" : ""} already past today — if he hasn't dictated the service description, that's what closes it and gets him paid.`);
  }
  return lines.join(" ");
}

/* --- watcher ------------------------------------------------------------ */
// 15 minutes: calendars don't move like texts do, but a job added this
// morning shouldn't wait an hour. Holds changes so they lead next open.
async function checkCalendar(uid) {
  if (!calReady()) return { ok: false, error: "no icloud" };
  const g = await calGather(uid, { days: 14 });
  if (!g.ok) return { ok: false, error: g.error };

  const s = await calSources(uid);
  const monitored = new Set([
    ...s.sources.filter(x => x.monitor).map(x => x.name),
    ...icsFeeds(uid).filter(f => f.monitor).map(f => f.name),
  ]);
  const watched = g.events.filter(e => monitored.has(e.sourceName));

  STORE.calSeen = STORE.calSeen || {};
  const changes = CAL.detectChanges(watched, STORE.calSeen[uid] || {});
  STORE.calSeen[uid] = changes.nextSeen;

  // Today's work jobs, cached for the brief so /chat doesn't wait on Apple.
  STORE.calToday = STORE.calToday || {};
  const todayEnd = CAL.endOfDay();
  const _prefs = calPrefsOf(uid);
  // Whose event is it? Jess is the only person who shares calendars TO him, so
  // any sharedByOther calendar is hers by default (Payments, Work, School
  // Holidays, her Calendar — all "Shared by Jessica"). The picker can override
  // per-calendar via prefs[id].person ("jess" | "me" | "ignore") if he wants.
  const personOf = (e) => {
    const pref = _prefs[e.sourceId] && _prefs[e.sourceId].person;
    if (pref) return pref;
    return e.sharedByOther ? "jess" : "me";
  };
  const soonEnd = CAL.endOfDay(new Date(Date.now() + 3 * 86400000)); // next ~3 days
  STORE.calToday[uid] = {
    at: Date.now(),
    jobs: g.events.filter(e => isWorkEvent(e) && e.start <= todayEnd && e.start >= CAL.startOfDay())
      .map(e => ({ title: e.title, job: jobNumberOf(e.title), whenBoth: bothZones(e.start), startMs: e.start ? e.start.getTime() : 0 })),
    // Upcoming events over the next few days, attributed. Used by the people-advisor.
    upcoming: g.events
      .filter(e => e.start && e.start.getTime() > Date.now() && e.start <= soonEnd)
      .map(e => ({
        title: e.title,
        startMs: e.start.getTime(),
        source: e.sourceName || "",
        person: personOf(e),
      }))
      .filter(e => e.person !== "ignore")
      .sort((a, b) => a.startMs - b.startMs)
      .slice(0, 40),
  };

  if (changes.any) {
    STORE.calHold = STORE.calHold || {};
    STORE.calHold[uid] = { at: Date.now(), spoken: CAL.changesToSpoken(changes) };
    dlog(uid, "memory", `calendar: ${changes.added.length} new, ${changes.moved.length} moved, ${changes.removed.length} gone`);
  }
  saveStore();
  return { ok: true, changed: changes.any, added: changes.added.length, moved: changes.moved.length, removed: changes.removed.length };
}

app.post("/calendar/check", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const r = await checkCalendar(uid);
  if ((req.body || {}).action === "clear") {
    STORE.calHold = STORE.calHold || {}; STORE.calHold[uid] = null; saveStore();
  }
  res.json({ ...r, held: ((STORE.calHold || {})[uid] || null), today: ((STORE.calToday || {})[uid] || null) });
});

setTimeout(() => setInterval(() => once("calendar", async () => {
  if (!calReady()) return;
  for (const uid of Object.keys(STORE.calPrefs || {})) await checkCalendar(uid).catch(() => {});
}), 900000), OFFSET.calendar);


/* ===========================================================================
 * BATCH 110 — CONVERSATION MODE (translation, rebuilt)
 *
 * Audit of what was there found four overlapping paths and one real problem:
 * /converse was a good backend behind a prompt()-per-line UI, and it REQUIRED
 * being told the other language up front. This replaces the "which language?"
 * step with genuine detection, and adds the things the big three do well:
 *
 *   from Meta    — full-screen two-sided conversation, speak-aloud by default
 *   from Google  — romanisation (so he can attempt the sounds), big readable
 *                  "hold this up" text, tap-to-replay
 *   from Apple   — a phrasebook of the lines he actually reuses
 *   from none    — it all lands in Vision's memory, tied to where and who
 *
 * The honest limits, told to him plainly: no offline packs on the web (that's
 * native + Apple's Translation framework), and a round trip has a floor of
 * roughly a second or two.
 * ======================================================================== */

// Languages worth naming so detection has a prior. Vietnamese and Thai first
// because that's the trip; the rest cover the region he'll pass through.
const CONVO_LANGS = [
  "Vietnamese", "Thai", "English", "Indonesian", "Malay", "Khmer", "Lao",
  "Mandarin Chinese", "Cantonese", "Japanese", "Korean", "Tagalog",
  "Burmese", "Hindi", "Nepali", "Spanish", "French", "German", "Italian",
  "Portuguese", "Dutch", "Russian", "Arabic", "Turkish", "Greek",
];

function convoProfile(uid) {
  const p = profileOf(uid) || {};
  return {
    mine: p.myLang || "English",
    // Learned, not asked: whatever he's actually been hearing lately.
    likely: ((STORE.convoLangs || {})[uid] || []).slice(0, 3),
  };
}

function noteConvoLang(uid, lang) {
  if (!lang || /english/i.test(lang)) return;
  STORE.convoLangs = STORE.convoLangs || {};
  const list = STORE.convoLangs[uid] = STORE.convoLangs[uid] || [];
  const i = list.indexOf(lang);
  if (i > -1) list.splice(i, 1);
  list.unshift(lang);
  while (list.length > 5) list.pop();
}

/* --- the turn ----------------------------------------------------------- */
// One line in, translated line out, direction worked out rather than declared.
app.post("/converse/turn", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { text, theirLang, history } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });

  const { mine, likely } = convoProfile(uid);
  const country = (profileOf(uid) || {}).country || "";

  // Prior context makes detection far better on short lines — "cảm ơn" alone
  // is ambiguous, but not after three Vietnamese turns.
  const prior = Array.isArray(history) ? history.slice(-4)
    .map(h => `${h.who === "me" ? "Shaun" : "Them"} (${h.lang || "?"}): ${h.text}`).join("\n") : "";

  const hint = theirLang ? `The other person has been speaking ${theirLang}. `
    : likely.length ? `Recently he's been hearing ${likely.join(" or ")} — but detect from the line itself. `
    : "";

  const body = {
    model: "claude-haiku-4-5-20251001", // conversation needs speed above all
    max_tokens: 420,
    system:
      "You power a live two-way conversation translator for Shaun, an Australian traveller. " +
      "You are given ONE spoken line. Work out what language it is, then translate it the RIGHT WAY: " +
      "if it's Shaun's own language it goes to the other person's; otherwise it comes back to Shaun's. " +
      "Translate how a person actually speaks — colloquial, not literal, and keep it short. " +
      `Languages you'll usually see: ${CONVO_LANGS.join(", ")}.`,
    messages: [{
      role: "user",
      content:
        `Shaun speaks ${mine}.${country ? ` He's in ${country}.` : ""} ${hint}` +
        (prior ? `\n\nThe conversation so far:\n${prior}\n` : "") +
        `\nThe new line:\n"${text}"\n\n` +
        `Reply as compact JSON ONLY (no markdown) with keys: ` +
        `"detected" (language name of the line), ` +
        `"direction" ("to-them" if Shaun said it, "to-me" if they did), ` +
        `"translation" (natural spoken translation), ` +
        `"roman" (the translation written in Latin letters as it SOUNDS, for a non-native to attempt — "" if the translation is already Latin script), ` +
        `"tone" (one or two words: friendly, annoyed, urgent, hurried, warm, neutral), ` +
        `"note" (SHORT, only if a cultural nuance or a likely misunderstanding matters, else ""), ` +
        `"confidence" (0 to 1 — how sure you are about the language).`,
    }],
  };

  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, translation: "Didn't catch that — say it again?" });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { translation: raw }; }

    const detected = p.detected || "";
    const direction = p.direction || (detected && detected.toLowerCase() !== mine.toLowerCase() ? "to-me" : "to-them");
    if (direction === "to-me") noteConvoLang(uid, detected);

    // Every turn goes into the live session so it can be saved whole.
    STORE.convoLive = STORE.convoLive || {};
    const live = STORE.convoLive[uid] = STORE.convoLive[uid] || { at: Date.now(), turns: [] };
    live.at = Date.now();
    live.turns.push({
      who: direction === "to-me" ? "them" : "me",
      lang: detected, text,
      translation: p.translation || raw,
      roman: p.roman || "", tone: p.tone || "", at: Date.now(),
    });
    while (live.turns.length > 60) live.turns.shift();
    saveStore();

    res.json({
      detected, direction,
      translation: p.translation || raw,
      roman: p.roman || "",
      tone: p.tone || "",
      note: p.note || "",
      confidence: typeof p.confidence === "number" ? p.confidence : 0.7,
      turns: live.turns.length,
    });
  } catch (e) {
    res.status(200).json({ fallback: true, translation: "Translation hiccup — try again." });
  }
});

/* --- saving a conversation into real memory ----------------------------- */
// Meta and Google both keep a flat history list. This is the actual
// difference: a conversation lands in the same pool everything else recalls
// from, so "what did the guesthouse bloke promise" works months later.
app.post("/converse/save", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { tag, discard } = req.body || {};
  STORE.convoLive = STORE.convoLive || {};
  const live = STORE.convoLive[uid];

  if (discard) { STORE.convoLive[uid] = null; saveStore(); return res.json({ ok: true, discarded: true }); }
  if (!live || !live.turns.length) return res.json({ ok: false, spoken: "No conversation to save yet." });

  const transcript = live.turns.map(t =>
    `${t.who === "me" ? "Shaun" : "Them"} (${t.lang || "?"}): ${t.text}${t.who === "them" ? ` [${t.translation}]` : ""}`
  ).join("\n");

  let summary = "";
  try {
    const { status, text: out } = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 260,
      system: "You summarise a translated conversation into what Shaun would actually want to recall later. Lead with anything agreed, promised, priced or arranged. Two or three sentences. Never invent detail." + SPOKEN_PLAIN,
      messages: [{ role: "user", content: `${tag ? `This was with: ${tag}\n\n` : ""}${transcript}` }],
    });
    if (status === 200) summary = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
  } catch {}

  STORE.convos = STORE.convos || {};
  const saved = STORE.convos[uid] = STORE.convos[uid] || [];
  const rec = {
    id: `c${Date.now().toString(36)}`,
    tag: tag || "", at: Date.now(),
    langs: [...new Set(live.turns.map(t => t.lang).filter(Boolean))],
    turns: live.turns, summary,
  };
  saved.push(rec);
  while (saved.length > 60) saved.shift();

  // Into the shared pool so every other skill can recall it too.
  const mem = STORE.mem[uid] = STORE.mem[uid] || [];
  remember(uid, `conversation${tag ? ` with ${tag}` : ""}: ${summary || transcript.slice(0, 240)}`, { kind: "conversation" });

  STORE.convoLive[uid] = null;
  saveStore();
  dlog(uid, "memory", `conversation saved${tag ? ` (${tag})` : ""} — ${rec.turns.length} turns`);

  res.json({ ok: true, id: rec.id, summary, spoken: summary ? `Saved. ${summary}` : "Saved that conversation." });
});

/* --- phrasebook: the lines he actually reuses ---------------------------- */
// Apple's Translate keeps favourites; this earns its place by noticing which
// lines he repeats rather than making him star them.
app.post("/converse/phrases", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { action, text, translation, lang, id } = req.body || {};
  STORE.phrases = STORE.phrases || {};
  const list = STORE.phrases[uid] = STORE.phrases[uid] || [];

  if (action === "add" && text && translation) {
    const existing = list.find(p => p.text.toLowerCase() === String(text).toLowerCase() && p.lang === lang);
    if (existing) { existing.uses = (existing.uses || 1) + 1; existing.at = Date.now(); }
    else list.push({ id: `p${Date.now().toString(36)}`, text, translation, lang: lang || "", uses: 1, at: Date.now() });
    while (list.length > 80) list.shift();
    saveStore();
    return res.json({ ok: true, count: list.length });
  }
  if (action === "remove" && id) {
    STORE.phrases[uid] = list.filter(p => p.id !== id);
    saveStore();
    return res.json({ ok: true });
  }
  // Most-used first — that's what a phrasebook is for.
  const sorted = [...list].sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.at || 0) - (a.at || 0));
  res.json({ ok: true, phrases: sorted.slice(0, 40), langs: ((STORE.convoLangs || {})[uid] || []) });
});

/* --- recall past conversations ------------------------------------------ */
app.post("/converse/history", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const { query } = req.body || {};
  const saved = (STORE.convos || {})[uid] || [];
  if (!saved.length) return res.json({ ok: false, spoken: "No saved conversations yet." });

  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return res.json({
      ok: true,
      conversations: saved.slice(-8).reverse().map(c => ({ id: c.id, tag: c.tag, at: c.at, langs: c.langs, summary: c.summary, turns: c.turns.length })),
      spoken: `${saved.length} saved. Most recent${saved[saved.length - 1].tag ? ` was with ${saved[saved.length - 1].tag}` : ""}.`,
    });
  }

  const hits = saved.filter(c =>
    (c.tag || "").toLowerCase().includes(q) ||
    (c.summary || "").toLowerCase().includes(q) ||
    c.turns.some(t => `${t.text} ${t.translation}`.toLowerCase().includes(q))
  ).slice(-5).reverse();

  if (!hits.length) return res.json({ ok: false, spoken: `Nothing in your conversations about "${query}".` });
  const top = hits[0];
  res.json({
    ok: true,
    conversations: hits.map(c => ({ id: c.id, tag: c.tag, at: c.at, langs: c.langs, summary: c.summary, turns: c.turns.length })),
    conversation: top,
    spoken: top.summary || `Found a conversation${top.tag ? ` with ${top.tag}` : ""} — ${top.turns.length} lines.`,
  });
});


/* ===========================================================================
 * ADVISORY LAYER (batch 129)
 *
 * Everything before this answers the question asked. Nothing looked across the
 * WHOLE picture and asked "what's about to go wrong, and what would he not
 * have thought of?"
 *
 * The pieces were all there — calendar, jobs, spend, weather, bookings,
 * memory, patterns — but each skill only ever saw its own slice. A 4:30pm AEST
 * job and a market trip that runs till 2pm his time is a collision neither the
 * calendar skill nor the day planner can see, because each is only looking at
 * one of them.
 *
 * TWO HARD RULES, both deliberate:
 *
 *   1. IT NEVER ACTS. It returns words. Every suggestion is something he can
 *      say yes to, never something already done. Booking, texting his wife,
 *      ticking her shared list — those need a human, and an assistant that
 *      guesses is worse than one that asks.
 *
 *   2. IT STAYS QUIET WHEN IT HAS NOTHING. An advisor that always finds
 *      something to say gets ignored inside a week. Silence is the default and
 *      the correct answer most of the time.
 * ======================================================================== */

/* His local hour has to come from where HE is, not where the server is.
 * Render runs UTC; the countries he travels are UTC+7 to UTC+10. Getting this
 * wrong means silent all morning and chatty at midnight. */
const COUNTRY_TZ = {
  australia: "Australia/Brisbane", vietnam: "Asia/Ho_Chi_Minh", thailand: "Asia/Bangkok",
  indonesia: "Asia/Jakarta", malaysia: "Asia/Kuala_Lumpur", singapore: "Asia/Singapore",
  philippines: "Asia/Manila", cambodia: "Asia/Phnom_Penh", laos: "Asia/Vientiane",
  myanmar: "Asia/Yangon", japan: "Asia/Tokyo", "new zealand": "Pacific/Auckland",
};

/* --- 📍 LIVE-GPS TIMEZONE (build 159) ---------------------------------------
 * So the moment he opens Vision in Hanoi it's on Vietnam time — no Arrival tap
 * needed. Bounding boxes for the countries he actually travels; deliberately
 * dependency-free (a global tz library is ~2MB of boundary data and another
 * thing to break npm install on his Windows PC, for coverage he won't use).
 * Approximate at borders, but adjacent boxes here share the same offset
 * (Vietnam/Laos/Cambodia/Thailand all UTC+7), so a border wobble is harmless.
 * Indonesia is split because it genuinely spans +7/+8/+9 and Bali (+8) matters.
 * Returns a named IANA zone or "" if he's outside the known region (then the
 * caller falls back to profile country, then Brisbane).
 * Box = [minLat, maxLat, minLng, maxLng, zone].
 */
const TZ_BOXES = [
  // Australia — east coast / Brisbane is home; keep it simple to AEST unless
  // he's clearly in WA or SA/NT.
  [-39, -10,  138, 154, "Australia/Brisbane"],   // QLD/NSW/VIC/east (AEST, his home)
  [-35, -12,  129, 138, "Australia/Adelaide"],   // SA/NT centre
  [-35, -13,  112, 129, "Australia/Perth"],      // WA
  // SE Asia (all UTC+7 except where noted)
  [ 8,  24,  102, 110, "Asia/Ho_Chi_Minh"],      // Vietnam
  [ 5,  21,   97, 106, "Asia/Bangkok"],          // Thailand
  [ 10, 15,  102, 108, "Asia/Phnom_Penh"],       // Cambodia
  [ 13, 23,  100, 108, "Asia/Vientiane"],        // Laos
  [ 9,  29,   92, 102, "Asia/Yangon"],           // Myanmar (UTC+6:30)
  [ 1,   8,  100, 105, "Asia/Kuala_Lumpur"],     // Malaysia (west) + Singapore
  // Indonesia — split by longitude into its three real zones
  [-11,  6,   95, 115, "Asia/Jakarta"],          // WIB +7 (Java, Sumatra)
  [-11,  1,  115, 125, "Asia/Makassar"],         // WITA +8 (Bali, Lombok, Sulawesi)
  [-11,  0,  125, 141, "Asia/Jayapura"],         // WIT +9 (Papua)
  [ 5,  20,  116, 127, "Asia/Manila"],           // Philippines
  [ 24, 46,  122, 146, "Asia/Tokyo"],            // Japan
  [-47,-34,  166, 179, "Pacific/Auckland"],      // New Zealand
];
function tzFromLatLng(lat, lng) {
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return "";
  for (const [a, b, c, d, zone] of TZ_BOXES) {
    if (lat >= a && lat <= b && lng >= c && lng <= d) return zone;
  }
  return "";
}


// Timezone collisions are the single most likely thing to bite him: he works
// AEST hours from a country 2-4 hours behind, so "4:30" means two things.
function tzGap(uid) {
  const p = profileOf(uid) || {};
  if (!p.country || /australia/i.test(p.country)) return 0;
  try {
    // Batch 149: this used to compare Brisbane against the SERVER's clock,
    // which is not where he is. On Render (UTC) it returned +10 — right for
    // Vietnam by pure coincidence. Run the same code on a Brisbane PC and it
    // returns 0, so the advisor went completely silent about a job he'd be
    // three hours out on. Neither answer was actually correct.
    //
    // The question is: how far is Brisbane from WHERE HE IS? So both sides
    // must be named zones. COUNTRY_TZ already maps the places he travels.
    const hisZone = COUNTRY_TZ[String(p.country).toLowerCase()];
    if (!hisZone) return 0;   // unknown country — don't guess a gap
    const now = new Date();
    const au = new Date(now.toLocaleString("en-US", { timeZone: WORK_TZ }));
    const there = new Date(now.toLocaleString("en-US", { timeZone: hisZone }));
    return Math.round((au - there) / 3600000);
  } catch { return 0; }
}

/* --- the checks ---------------------------------------------------------
 * Each returns a note or null. Ordered by consequence: money and missed work
 * first, nice-to-know last. Each says WHY, so he can judge it rather than
 * being told.
 * --------------------------------------------------------------------- */
const ADVISORS = [

  // A work job in a country that isn't Australia. The number on the calendar
  // is AEST; the number on his wrist isn't.
  function timezoneCollision(uid, ctx) {
    if (!ctx.jobsToday.length) return null;
    const gap = tzGap(uid);
    if (!gap) return null;
    const next = ctx.jobsToday.find(j => j.startMs > ctx.now);
    if (!next) return null;
    const mins = Math.round((next.startMs - ctx.now) / 60000);
    if (mins > 240) return null;
    return {
      kind: "timezone", weight: 95,
      note: `${next.title} is ${next.whenBoth}. You're ${Math.abs(gap)} hours ${gap > 0 ? "behind" : "ahead of"} Brisbane — worth saying the local time out loud so you don't book something over it.`,
    };
  },

  // What's coming up for Jess (and anyone else sharing calendars to him) over
  // the next few days — her flights, appointments, work shifts. He asked for
  // this to be surfaced actively rather than only when he opens the calendar.
  // Equal weight across her events (his choice); once-per-event so the same
  // appointment doesn't lead every brief.
  function peopleUpcoming(uid, ctx) {
    const up = (ctx.upcoming || []).filter(e => e.person === "jess" && e.startMs > ctx.now);
    if (!up.length) return null;
    STORE.advSeen = STORE.advSeen || {};
    const seen = STORE.advSeen[uid] = STORE.advSeen[uid] || {};
    // Prune seen keys older than 5 days so it can resurface a rescheduled event.
    for (const k of Object.keys(seen)) { if (Date.now() - seen[k] > 5 * 86400000) delete seen[k]; }
    // Nearest not-yet-mentioned event (keyed by title+start so a moved event re-fires).
    const next = up.find(e => !seen[`${e.title}|${e.startMs}`]);
    if (!next) return null;
    seen[`${next.title}|${next.startMs}`] = Date.now();
    const dt = new Date(next.startMs);
    const when = whenPhrase(next.startMs); // "tomorrow at 1pm", "Monday 8am"
    return {
      kind: "people", weight: 72,
      note: `Jess has "${next.title}" ${when}${next.source ? ` (${next.source})` : ""} — worth knowing so it's on your radar.`,
    };
  },

  // Two things booked close together in a city he doesn't know.
  function tightGap(uid, ctx) {
    const ev = ctx.events.filter(e => e.startMs > ctx.now).sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < ev.length - 1; i++) {
      const gapMin = Math.round((ev[i + 1].startMs - (ev[i].endMs || ev[i].startMs + 3600000)) / 60000);
      if (gapMin >= 0 && gapMin < 45) {
        return {
          kind: "tight", weight: 80,
          note: `Only ${gapMin} minutes between ${ev[i].title} and ${ev[i + 1].title}. In a city you don't know, that's tighter than it looks — worth moving one.`,
        };
      }
    }
    return null;
  },

  // A job that happened and was never written up. That's unpaid work.
  function unwrittenJob(uid, ctx) {
    const jobs = Object.values((STORE.jobs || {})[uid] || {});
    const open = jobs.filter(j => !j.report && (ctx.now - (j.at || 0)) < 7 * 864e5);
    if (!open.length) return null;
    const oldest = open.sort((a, b) => (a.at || 0) - (b.at || 0))[0];
    const days = Math.floor((ctx.now - (oldest.at || 0)) / 864e5);
    return {
      kind: "job", weight: 90,
      note: `Job ${oldest.job}${oldest.customer ? ` for ${oldest.customer}` : ""} has no service description yet${days >= 1 ? `, ${days} day${days > 1 ? "s" : ""} on` : ""}. That's what closes it and gets you paid — want to talk it through now while you still remember it?`,
    };
  },

  // Spending well ahead of pace, early enough in the trip to matter.
  function spendPace(uid, ctx) {
    const led = (STORE.spend || {})[uid] || {};
    const todayKey = new Date().toISOString().slice(0, 10);
    // Batch 129 stress test caught this: today was included in its own
    // baseline, so a genuine spike dragged the average up and hid itself. A
    // 70% overspend read as normal. Compare today against the days BEFORE it.
    const prior = Object.keys(led).filter(d => d < todayKey).sort().slice(-7);
    if (prior.length < 3) return null;
    const totals = prior.map(d => Number(led[d]?.total || led[d] || 0)).filter(n => n > 0);
    if (totals.length < 3) return null;
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
    const today = Number(led[todayKey]?.total || 0);
    if (!today || today < avg * 1.6) return null;
    return {
      kind: "spend", weight: 60,
      note: `Today's running about ${Math.round((today / avg - 1) * 100)}% above your usual day. Not a problem on its own — just worth knowing before tonight rather than after.`,
    };
  },

  // Something booked, weather against it, and he hasn't looked.
  function weatherAgainstPlan(uid, ctx) {
    const outdoor = ctx.events.find(e =>
      e.startMs > ctx.now && e.startMs - ctx.now < 12 * 3600000 &&
      /beach|hike|walk|tour|market|bay|trek|boat|cruise|island/i.test(e.title || ""));
    if (!outdoor) return null;
    return {
      kind: "weather", weight: 55,
      note: `${outdoor.title} is outdoors and it's coming up. Worth me checking the forecast before you head off — say "weather" and I'll look.`,
    };
  },

  // He's in a country whose norms he hasn't asked about yet.
  function newCountryUnbriefed(uid, ctx) {
    const p = profileOf(uid) || {};
    if (!p.country || /australia/i.test(p.country)) return null;
    const mem = STORE.mem[uid] || [];
    const arrived = mem.filter(m => /^arrived in /i.test(String(m.t)))
      .sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    if (!arrived) return null;
    const hoursSince = (ctx.now - (arrived.at || 0)) / 3600000;
    if (hoursSince > 48 || hoursSince < 1) return null;
    const asked = mem.some(m => (m.at || 0) > (arrived.at || 0) &&
      /etiquette|scam|tipping|safe/i.test(String(m.t)));
    if (asked) return null;
    return {
      kind: "arrival", weight: 50,
      note: `You've been in ${p.country} less than two days. If you want, I can run you through the tipping norm and the one scam that catches people here — takes ten seconds.`,
    };
  },

  // A booking coming up that he hasn't mentioned since making it.
  function forgottenBooking(uid, ctx) {
    const list = (STORE.bookings || {})[uid] || [];
    const soon = list.filter(b => b.whenISO && Date.parse(b.whenISO) > ctx.now &&
      Date.parse(b.whenISO) - ctx.now < 36 * 3600000);
    if (!soon.length) return null;
    const b = soon[0];
    return {
      kind: "booking", weight: 70,
      note: `${b.type || "Booking"} ${b.what || ""} is inside 36 hours${b.ref ? ` (ref ${b.ref})` : ""}. Worth having the reference handy before you're standing at a counter.`,
    };
  },

  // A pending flow he started and never finished.
  function stalledFlow(uid, ctx) {
    const flows = (STORE.pending || {})[uid] || [];
    // Batch 131 audit: this checked state === "open", which NOTHING ever sets.
    // The real store uses "waiting" (and "expired" once it lapses), so this
    // advisor could never fire — it looked correct and did nothing.
    const stale = flows.filter(f => f.state === "waiting" && !f.ownedByPlan && (ctx.now - (f.at || 0)) > 3 * 3600000);
    if (!stale.length) return null;
    const f = stale[0];
    return {
      kind: "pending", weight: 65,
      note: `You started ${f.kind} ${f.what || ""} a few hours back and it's still open. Did that come off, or should I drop it?`,
    };
  },
];

/* --- alternatives -------------------------------------------------------
 * Different from a warning: this is the travel-agent instinct. When he asks
 * for one thing, name the option he didn't ask about, with the trade-off
 * stated plainly so he can decide. Never a recommendation — a comparison.
 * --------------------------------------------------------------------- */
const ALTERNATIVE_PROMPT =
  "You are the part of Vision that says the thing a good travel agent would say unprompted. " +
  "He has just asked for ONE option. Your job is to name the alternative he did NOT ask about — " +
  "a different mode, a different time, a different order of doing things — and state the trade-off plainly. " +
  "Rules: exactly ONE alternative, never more. Say what it costs him as well as what it gains. " +
  "If the obvious choice is genuinely the right one, say so in one line and offer nothing — " +
  "that is a correct and useful answer. Never invent a price, a schedule or a service that may not exist; " +
  "describe the KIND of option and say it needs checking." + SPOKEN_PLAIN;

async function suggestAlternative(uid, { intent, detail, country }) {
  const mem = recallFor(uid, `${intent} ${detail}`, 3).map(m => m.t).join(" | ");
  try {
    const { status, text } = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: ALTERNATIVE_PROMPT,
      messages: [{
        role: "user",
        content: `He's in ${country || "somewhere"} and just asked about: ${intent}${detail ? ` — ${detail}` : ""}.` +
          (mem ? `\n\nWhat you know about how he travels: ${mem}` : "") +
          `\n\nReply as compact JSON ONLY: "alternative" (one short spoken sentence naming the other option and its trade-off, or "" if the obvious choice is right), "worth_saying" (true|false).`,
      }],
    });
    if (status !== 200) return null;
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return null; }
    if (!p.alternative || p.worth_saying === false) return null;
    return String(p.alternative).slice(0, 300);
  } catch { return null; }
}

/* --- assembly ----------------------------------------------------------- */
function adviseContext(uid) {
  const today = (STORE.calToday || {})[uid] || {};
  const jobsToday = (today.jobs || []).filter(j => j.startMs);
  // Calendar events come from the cached day so this never waits on Apple.
  const events = (today.events || jobsToday).map(e => ({
    title: e.title, startMs: e.startMs || 0, endMs: e.endMs || 0,
  })).filter(e => e.startMs);
  const upcoming = (today.upcoming || []).filter(e => e.startMs);
  return { now: Date.now(), jobsToday, events, upcoming };
}

function advise(uid, { max = 2 } = {}) {
  const ctx = adviseContext(uid);
  const out = [];
  for (const fn of ADVISORS) {
    try { const r = fn(uid, ctx); if (r) out.push(r); }
    catch (e) { /* one bad advisor must never silence the rest */ }
  }
  out.sort((a, b) => b.weight - a.weight);

  // Deliberately capped. Three warnings at once is noise, and noise gets
  // ignored — which costs the one that mattered.
  return out.slice(0, max);
}

// Into the brief, so it colours every reply rather than needing to be asked.
function adviceBrief(uid) {
  const a = advise(uid, { max: 2 });
  if (!a.length) return "";
  return "WORTH RAISING (say at most ONE of these, only where it fits what he's actually asking — " +
    "never lead with it if he asked a direct question, and never repeat one he's already brushed off): " +
    a.map(x => x.note).join(" | ");
}

/* --- endpoints ---------------------------------------------------------- */

// Ask outright: "anything I should know?"
app.post("/advise", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const a = advise(uid, { max: Number((req.body || {}).max) || 3 });
  if (!a.length) {
    return res.json({ ok: true, notes: [], spoken: "Nothing worth flagging — you're on top of it." });
  }
  res.json({
    ok: true,
    notes: a.map(x => ({ kind: x.kind, note: x.note })),
    spoken: a.map(x => x.note).join(" "),
  });
});

// "What haven't I thought of?" — the alternative to what he just asked for.
app.post("/alternative", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { intent, detail } = req.body || {};
  if (!intent) return res.status(400).json({ error: "intent required" });
  const country = (profileOf(uid) || {}).country || "";
  const alt = await suggestAlternative(uid, { intent, detail, country });
  if (!alt) return res.json({ ok: true, alternative: "", spoken: "" });
  res.json({ ok: true, alternative: alt, spoken: alt });
});


/* ===========================================================================
 * NATIVE HANDSHAKE (batch 140)
 *
 * A native app that hardcodes what the brain can do goes stale the moment a
 * skill is added — and every fix means another Mac rental. So the app asks
 * instead. One call on launch returns everything Swift needs to behave
 * correctly without knowing anything in advance:
 *
 *   - which skills exist, and which need a camera before they can run
 *   - which capabilities are actually configured on THIS server
 *   - what the client should do that the brain can't do for it
 *   - whether the token works at all
 *
 * The last one matters more than it sounds: the single most likely thing to go
 * wrong on a rented Mac is a wrong token or URL, and without this it surfaces
 * as a mystery 401 in the middle of a capture flow.
 * ======================================================================== */

// Skills that cannot run without a photo. A native client must know BEFORE it
// routes, so it can open the camera first rather than failing after.
const SKILLS_NEEDING_IMAGE = new Set([
  "vision", "landmark", "menu", "allergy", "capture", "jobcapture", "receipt", "readpage",
]);

// Skills that only make sense with a location fix.
const SKILLS_NEEDING_LOCATION = new Set([
  "nearby", "navigate", "unlost", "backto", "rememberspot", "whereis",
  "meetmiddle", "sharepin", "livelocation", "onmyway", "transit", "ride", "landmark",
]);

// Skills that write to something shared with his wife. A native client should
// confirm before sending, exactly as the web app does.
const SKILLS_NEEDING_CONFIRM = new Set([
  "tickoff", "addlist", "addevent", "sendtext", "tellpartner", "sharepin", "onmyway",
]);

app.post("/native/hello", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const prof = profileOf(uid) || {};

  // Parsed from the same constant the router uses, so this can never drift
  // from what the model is actually offered.
  const skills = [...ROUTER_SKILLS.matchAll(/"(\w+)" \(([^)]*)\)/g)].map(m => {
    const name = m[1];
    const desc = m[2].split(";")[0].trim();
    return {
      name,
      what: desc.slice(0, 120),
      needsImage: SKILLS_NEEDING_IMAGE.has(name),
      needsLocation: SKILLS_NEEDING_LOCATION.has(name),
      confirmFirst: SKILLS_NEEDING_CONFIRM.has(name),
    };
  });

  // What's actually configured HERE — not what the code supports. A native app
  // should hide a tile rather than offer something that will 501.
  const have = {
    maps: !!GMAPS_KEY,
    flights: !!FLIGHT_KEY,
    mail: !!(ICLOUD_USER && ICLOUD_APP_PW),
    calendar: !!(ICLOUD_USER && ICLOUD_APP_PW),
    geeks2u: !!GEEKS2U_ICS,
    durableMemory: DURABLE,
  };

  res.json({
    ok: true,
    // Bump when the client contract changes in a way Swift must handle.
    contract: 1,
    brain: {
      version: "159",
      // Every model-backed endpoint returns `spoken`. This is the promise the
      // whole thin-connector design rests on, stated explicitly so a client
      // can rely on it rather than inferring it.
      alwaysSpeaks: true,
      routeEndpoint: "/route",
      chatEndpoint: "/chat",
      // A native client should let the brain decide, not pattern-match locally.
      routeFirst: true,
    },
    you: {
      name: prof.name || "Shaun",
      country: prof.country || "",
      city: prof.city || "",
      homeCurrency: prof.homeCurrency || "AUD",
      // The native app needs this to show work times correctly, and getting
      // it wrong is how a job gets missed.
      workTimezone: WORK_TZ,
    },
    skills,
    have,
    // Things the brain genuinely cannot do for the client — named so a native
    // build doesn't waste Mac time discovering them one at a time.
    clientMustHandle: [
      { what: "wake word / continuous listening", why: "no server can hold the mic" },
      { what: "speech to text", why: "send the transcript, not the audio" },
      { what: "speaking the reply", why: "every response carries a `spoken` field — say that" },
      { what: "camera capture", why: "send base64 JPEG in `image`, max ~5MB decoded" },
      { what: "push notifications", why: "poll /watchers on foreground, then POST action:'seen'" },
      { what: "location", why: "send lat/lng with any skill flagged needsLocation" },
      { what: "confirmation before a shared write", why: "skills flagged confirmFirst touch his wife's lists" },
    ],
    // A capture that arrives too large is rejected by Anthropic AFTER the
    // upload, which on hotel wifi is a long wait for nothing.
    limits: {
      imageMaxBase64Bytes: IMG_MAX_B64,
      imageMinEdgePx: 200,
      imageRecommendedMaxEdgePx: 1400,
      callsPerMinute: CALL_MAX,
      requestTimeoutMs: CLAUDE_TIMEOUT_MS,
    },
  });
});

// A deliberately trivial call for the Mac burst: does the URL work, is the
// token right, is the brain awake? Answers in one line so it can be curl'd
// before a single line of Swift is written.
app.post("/native/ping", requireAuth, (req, res) => {
  res.json({
    ok: true,
    spoken: "Brain's awake and the token's good.",
    contract: 1,
    durable: DURABLE,
    at: Date.now(),
  });
});


/* ===========================================================================
 * THE INVESTIGATOR (batch 141)
 *
 * Not a detective. A detective decides who did it; this notices what changed.
 * The distinction matters because a model shown a photo will produce a
 * confident explanation whether or not it has grounds for one — and in his
 * trade that means being told a board is fried when it isn't.
 *
 * So everything here is built on comparison against something real:
 *
 *   SCENE      capture a place as it actually is — equipment, wiring, labels,
 *              what's flashing, where things sit relative to each other
 *   DIFF       this visit against the last one at the same address. Not a
 *              guess — an actual difference between two records
 *   ANOMALY    inconsistencies WITHIN one scene: a port skipped, a cable that
 *              doesn't go where the rest of the install would suggest
 *   NEXT       ordered candidates to check, each with what would rule it out.
 *              Never a verdict
 *   FALSIFY    the aviation question — what evidence would prove him wrong.
 *              This is the one that catches the wrong call before he drives off
 *
 * The one thing it will not do is name a cause. It narrows, and it says when
 * it cannot narrow further.
 * ======================================================================== */

const SCENE_KEEP_SITES = 400;
const SCENE_KEEP_MS = 2 * 365 * 86400000;   // two years

function trimScenes(uid) {
  const all = (STORE.scenes || {})[uid];
  if (!all) return;
  const now = Date.now();
  // Age first: a site he hasn't visited in two years is almost certainly gone.
  for (const [k, list] of Object.entries(all)) {
    if (!list || !list.length || (now - (list[0].at || 0)) > SCENE_KEEP_MS) delete all[k];
  }
  // Then a hard ceiling, oldest-touched first, in case he's busier than that.
  const keys = Object.keys(all);
  if (keys.length > SCENE_KEEP_SITES) {
    keys.sort((a, b) => (all[a][0]?.at || 0) - (all[b][0]?.at || 0));
    for (const k of keys.slice(0, keys.length - SCENE_KEEP_SITES)) delete all[k];
  }
}

async function withWeatherTimeout(url, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

const SCENE_MAX_PER_PLACE = 12;     // enough history to diff against
const SCENE_MAX_FRAMES = 4;

function placeKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

/* Batch 142: matching scenes by typed name alone is fragile — "Chermside" and
 * "chermside job" become two places and the diff silently compares nothing.
 * Coordinates fix that. ~40m tolerance: tight enough to distinguish two
 * addresses, loose enough that a phone's GPS drift inside a building doesn't
 * split one site into three. */
const SAME_SITE_METRES = 40;

function metresBetween(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/* Find the place he means — by coordinates first, falling back to the name.
 * Returns the existing key when he's standing somewhere he's been before, even
 * if he calls it something different this time. */
function resolvePlace(uid, place, coords) {
  STORE.scenes = STORE.scenes || {};
  const all = STORE.scenes[uid] = STORE.scenes[uid] || {};
  const named = placeKey(place);

  if (coords && coords.lat != null) {
    for (const [k, list] of Object.entries(all)) {
      const withFix = (list || []).find(s => s.coords && s.coords.lat != null);
      if (!withFix) continue;
      const d = metresBetween(coords, withFix.coords);
      if (d != null && d <= SAME_SITE_METRES) {
        return { key: k, matchedBy: k === named ? "name and location" : "location", metres: d, knownAs: withFix.place };
      }
    }
  }
  return { key: named, matchedBy: "name", metres: null, knownAs: null };
}

function scenesFor(uid, place, coords) {
  STORE.scenes = STORE.scenes || {};
  const all = STORE.scenes[uid] = STORE.scenes[uid] || {};
  // Trim where the store is actually touched, not from one caller — any future
  // caller then inherits the bound for free.
  trimScenes(uid);
  const r = resolvePlace(uid, place, coords);
  return { all, k: r.key, list: (all[r.key] = all[r.key] || []), resolved: r };
}

/* --- capture -------------------------------------------------------------
 * A walkthrough, not a photo. Up to four frames of the same place, described
 * as a structured record so a later visit has something to compare against.
 * ---------------------------------------------------------------------- */
app.post("/scene/capture", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { place, images, image, mediaType, note, job, lat, lng } = req.body || {};
  if (!place) return res.status(400).json({ error: "place required", spoken: "Tell me where this is and I'll record it." });
  const coords = (lat != null && lng != null) ? { lat: Number(lat), lng: Number(lng) } : null;

  const shots = (Array.isArray(images) ? images : (image ? [image] : [])).slice(0, SCENE_MAX_FRAMES);
  if (!shots.length) return res.status(400).json({ error: "image required", spoken: "Show me the scene and I'll record it." });

  for (const s of shots) {
    const v = checkImage(s, mediaType);
    if (!v.ok) return res.status(200).json({ fallback: true, spoken: v.spoken });
  }

  const content = [
    ...shots.map(d => ({ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: d.startsWith("data:") ? d.split(",")[1] : d } })),
    { type: "text", text:
      `Record this scene at ${place}.${note ? ` He says: ${note}` : ""} ` +
      "Reply as compact JSON ONLY with: " +
      '"summary" (one spoken sentence of what this place is), ' +
      '"equipment" (array of {what, model, labels, state} — model and labels ONLY if legible in the frame), ' +
      '"connections" (array of short strings describing what is plugged into what, only where visible), ' +
      '"indicators" (array of short strings: lights, displays, error codes, exactly as shown), ' +
      '"notable" (array of short strings — anything that stands out as unusual, incomplete or inconsistent), ' +
      '"unclear" (array of short strings — what you genuinely could not make out).' },
  ];

  try {
    const { status, text } = await callClaude({
      model: "claude-sonnet-4-6",
      max_tokens: 900,
      system:
        "You record equipment scenes the way a technician photographs a job before touching anything. " +
        "Record ONLY what is visibly there. Never state a model number, a label or an error code unless it is legible in the frame — " +
        "put it in \"unclear\" instead. Do not explain what is wrong; that is not your job here. " +
        "Describing something absent as present is the worst thing you can do, because a later visit will be compared against this." +
        NO_INVENT + SPOKEN_PLAIN,
      messages: [{ role: "user", content }],
    });
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't read that scene — try again in a moment." });

    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { summary: raw.slice(0, 300), equipment: [], connections: [], indicators: [], notable: [], unclear: [] }; }

    const { all, k, list, resolved } = scenesFor(uid, place, coords);
    const scene = {
      id: `s${Date.now().toString(36)}`,
      place, placeKey: k, at: Date.now(),
      // Batch 142: coordinates, so a later visit matches this site even if he
      // calls it something different. Not tracking — reliable matching.
      coords,
      job: jobNumberOf(job) || "",
      note: String(note || "").slice(0, 300),
      summary: p.summary || "",
      equipment: (p.equipment || []).slice(0, 20),
      connections: (p.connections || []).slice(0, 20),
      indicators: (p.indicators || []).slice(0, 20),
      notable: (p.notable || []).slice(0, 12),
      unclear: (p.unclear || []).slice(0, 12),
      frames: shots.length,
    };
    list.unshift(scene);
    if (list.length > SCENE_MAX_PER_PLACE) list.length = SCENE_MAX_PER_PLACE;
    all[k] = list;
    // Batch 142 sweep caught this: SCENE_MAX_PER_PLACE caps visits to ONE site,
    // but nothing capped how many SITES exist. At three jobs a day that's ~750
    // a year, kept forever, in a store rewritten on every save.
    //
    // (trimScenes runs inside scenesFor, where the store is touched.)

    // Into the shared pool so recall by symptom works months later.
    const mem = STORE.mem[uid] = STORE.mem[uid] || [];
    remember(uid, `scene at ${place}: ${scene.summary}${scene.indicators.length ? ` — showing ${scene.indicators.slice(0, 3).join(", ")}` : ""}`, { kind: "scene" });
    saveStore();
    dlog(uid, "memory", `scene recorded at ${place}`);

    // Weather is captured only when the scene suggests it could matter — an
    // outdoor install, damp, anything exposed. Recording it in a server
    // cupboard is a field nobody ever reads.
    const outdoorish = /outdoor|outside|roof|wall|pit|pole|garden|exposed|weather|damp|wet|corros|rust|water/i
      .test(`${scene.summary} ${scene.notable.join(" ")} ${scene.equipment.map(e => e.what || "").join(" ")}`);
    if (outdoorish && coords) {
      try {
        const u = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lng}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code`;
        const wr = await withWeatherTimeout(u);
        if (wr && wr.current) {
          scene.weather = {
            tempC: wr.current.temperature_2m,
            humidity: wr.current.relative_humidity_2m,
            rainMm: wr.current.precipitation,
          };
        }
      } catch { /* weather is a nice-to-have — never fail a capture over it */ }
    }

    const prior = list.length - 1;
    res.json({
      ok: true, scene,
      priorVisits: prior,
      matchedBy: resolved.matchedBy,
      knownAs: resolved.knownAs,
      spoken: `Recorded. ${scene.summary}` +
        (scene.unclear.length ? ` I couldn't make out ${scene.unclear.slice(0, 2).join(" or ")}.` : "") +
        (prior ? ` You've been here ${prior} time${prior > 1 ? "s" : ""} before` +
          (resolved.matchedBy === "location" && resolved.knownAs ? ` — you had it down as "${resolved.knownAs}"` : "") +
          `. Say "what's different" and I'll compare.` : ""),
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't record that scene — give it another go." });
  }
});

/* --- diff ----------------------------------------------------------------
 * The genuinely useful one, and the only part that can be certain: two records
 * of the same place, and what is different between them. Absence is the hardest
 * thing for a person to notice and the easiest thing to check against a record.
 * ---------------------------------------------------------------------- */
app.post("/scene/diff", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { place, lat, lng } = req.body || {};
  const coords = (lat != null && lng != null) ? { lat: Number(lat), lng: Number(lng) } : null;
  const { list } = scenesFor(uid, place, coords);
  if (list.length < 2) {
    return res.json({ ok: false, spoken: list.length
      ? `I've only got one record of ${place}. Capture it again next visit and I'll tell you what moved.`
      : `Nothing recorded at ${place} yet.` });
  }

  const now = list[0], then = list[1];
  const days = Math.max(1, Math.round((now.at - then.at) / 86400000));

  try {
    const { status, text } = await callClaude({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system:
        "You compare two records of the same place, taken on different visits, and report ONLY what actually differs. " +
        "State plainly what is present now that was not before, what is gone, and what has changed state. " +
        "If something appears in one record's \"unclear\" list, say the difference is uncertain rather than asserting it — " +
        "a difference that is really just a clearer photo is worse than no answer." +
        NO_INVENT + SPOKEN_PLAIN,
      messages: [{ role: "user", content:
        `Earlier visit (${days} days ago):\n${JSON.stringify(then, null, 1)}\n\n` +
        `This visit:\n${JSON.stringify(now, null, 1)}\n\n` +
        `Reply as compact JSON ONLY: "spoken" (one or two sentences he can hear), ` +
        `"appeared" (array), "gone" (array), "changed" (array), "uncertain" (array of differences you are not confident about).` }],
    });
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't compare those just now." });

    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300) }; }

    res.json({
      ok: true, daysBetween: days,
      appeared: p.appeared || [], gone: p.gone || [], changed: p.changed || [], uncertain: p.uncertain || [],
      spoken: p.spoken || "Nothing obvious has changed.",
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't compare those just now." });
  }
});

/* --- anomaly -------------------------------------------------------------
 * Inconsistency within a single scene, with no prior visit to lean on. Weaker
 * than a diff and honest about it.
 * ---------------------------------------------------------------------- */
app.post("/scene/anomaly", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { place, sceneId, lat, lng } = req.body || {};
  const coords = (lat != null && lng != null) ? { lat: Number(lat), lng: Number(lng) } : null;
  const { list } = scenesFor(uid, place, coords);
  const scene = sceneId ? list.find(s => s.id === sceneId) : list[0];
  if (!scene) return res.json({ ok: false, spoken: `Nothing recorded at ${place} yet — scan it first.` });

  const _mem = recallFor(uid, `${place} ${scene.summary}`, 4).map(m => m.t).join(" | ");

  try {
    const { status, text } = await callClaude({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system:
        "You look at one recorded scene and point out what is internally inconsistent — a port skipped in an otherwise sequential patch, " +
        "a cable that does not follow the pattern the rest of the install uses, an indicator that contradicts another. " +
        "Rank by how confident you are, and say plainly when something is merely unusual rather than wrong. " +
        "Do NOT diagnose a cause. Pointing at what does not fit is useful; guessing why is not." +
        NO_INVENT + SPOKEN_PLAIN,
      messages: [{ role: "user", content:
        `Scene:\n${JSON.stringify(scene, null, 1)}` +
        (_mem ? `\n\nWhat you remember about his past jobs that may be relevant: ${_mem}` : "") +
        `\n\nReply as compact JSON ONLY: "spoken" (one or two sentences), ` +
        `"findings" (array of {what, confidence: "high"|"medium"|"low", why}), ` +
        `"nothingOdd" (true if it all looks consistent — that is a real and useful answer).` }],
    });
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't look it over just now." });

    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300), findings: [] }; }

    res.json({
      ok: true,
      findings: (p.findings || []).slice(0, 6),
      nothingOdd: !!p.nothingOdd,
      spoken: p.spoken || (p.nothingOdd ? "Nothing looks out of place." : "Had a look — nothing jumps out."),
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't look it over just now." });
  }
});

/* --- next checks ---------------------------------------------------------
 * Candidates, ordered, each with what would rule it out. This is the shape
 * aviation and automotive diagnostics use, and it is deliberately NOT a verdict.
 * ---------------------------------------------------------------------- */
app.post("/scene/next", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { symptom, place, sceneId, lat, lng } = req.body || {};
  const coords = (lat != null && lng != null) ? { lat: Number(lat), lng: Number(lng) } : null;
  if (!symptom) return res.status(400).json({ error: "symptom required", spoken: "Tell me what it's doing and I'll work out what to check." });

  const { list } = scenesFor(uid, place, coords);
  const scene = sceneId ? list.find(s => s.id === sceneId) : list[0];

  // His own history is the strongest signal here — five years of jobs is a
  // better prior than anything a model knows about equipment in general.
  const past = recallFor(uid, symptom, 6).map(m => `${when(m.at)}: ${m.t}`).join(" | ");

  try {
    const { status, text } = await callClaude({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system:
        "You give a technician the next things to CHECK, in order — never a diagnosis. " +
        "Each candidate must come with the single test that would rule it in or out, and that test must be something he can do " +
        "on site in a couple of minutes. Order by what eliminates the most possibilities fastest, not by what is most likely. " +
        "If his own past jobs point somewhere, say so and say which job. " +
        "If you cannot narrow it below three or four candidates, say that plainly — a short honest list beats a confident wrong one." +
        NO_INVENT + SPOKEN_PLAIN,
      messages: [{ role: "user", content:
        `Symptom: ${symptom}` +
        (scene ? `\n\nWhat's there:\n${JSON.stringify({ summary: scene.summary, equipment: scene.equipment, indicators: scene.indicators, notable: scene.notable }, null, 1)}` : "") +
        (past ? `\n\nHis own past jobs that mention something similar: ${past}` : "") +
        `\n\nReply as compact JSON ONLY: "spoken" (one or two sentences naming the FIRST thing to check and why), ` +
        `"checks" (array of {check, rulesOut, minutes}), ` +
        `"seenBefore" (short string if his own history points somewhere, else ""), ` +
        `"cannotNarrow" (true if you genuinely can't get below four candidates).` }],
    });
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't work that through just now." });

    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300), checks: [] }; }

    res.json({
      ok: true,
      checks: (p.checks || []).slice(0, 6),
      seenBefore: p.seenBefore || "",
      cannotNarrow: !!p.cannotNarrow,
      spoken: p.spoken || "Start with the simplest thing you can rule out.",
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't work that through just now." });
  }
});

/* --- falsify -------------------------------------------------------------
 * The aviation question, and the most valuable thing in this whole module:
 * once he's decided, what evidence would prove him wrong? Asked before he
 * packs up, it catches the wrong call while he can still test it.
 * ---------------------------------------------------------------------- */
app.post("/scene/falsify", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { conclusion, symptom } = req.body || {};
  if (!conclusion) return res.status(400).json({ error: "conclusion required", spoken: "Tell me what you reckon it is, and I'll tell you what would prove you wrong." });

  try {
    const { status, text } = await callClaude({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system:
        "A technician has decided what the fault is. Your job is the question a good colleague asks before he packs up: " +
        "what would prove him wrong? Name the single most likely way this conclusion is mistaken, and the one test that would " +
        "expose it — something he can still do before leaving. " +
        "If the conclusion is well supported, say so in one line rather than manufacturing a doubt. " +
        "Never be contrarian for its own sake; that trains him to ignore you." +
        NO_INVENT + SPOKEN_PLAIN,
      messages: [{ role: "user", content:
        `He's concluded: ${conclusion}${symptom ? `\nThe symptom was: ${symptom}` : ""}\n\n` +
        `Reply as compact JSON ONLY: "spoken" (one or two sentences), ` +
        `"ifWrong" (the most likely way he's mistaken, or ""), ` +
        `"test" (the one test that would expose it, or ""), ` +
        `"solid" (true if the conclusion looks well supported and there's nothing worth chasing).` }],
    });
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "Couldn't think that through just now." });

    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300) }; }

    res.json({
      ok: true,
      ifWrong: p.ifWrong || "", test: p.test || "", solid: !!p.solid,
      spoken: p.spoken || "Sounds right to me.",
    });
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Couldn't think that through just now." });
  }
});

/* --- recall by symptom ---------------------------------------------------
 * "Have I seen this before" — the first-time-fix idea from field service
 * software, except the history is his own rather than a vendor's database.
 * ---------------------------------------------------------------------- */
app.post("/scene/seen", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const { symptom } = req.body || {};
  if (!symptom) return res.status(400).json({ error: "symptom required" });

  const hits = recallFor(uid, symptom, 6);
  const jobs = Object.values((STORE.jobs || {})[uid] || {})
    .filter(j => j.report && CAL.similarity(symptom, `${j.problem || ""} ${j.report || ""}`) > 0.35)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 4);

  if (!hits.length && !jobs.length) {
    return res.json({ ok: false, spoken: "Nothing in your history matching that — first time, by the looks of it." });
  }

  const lines = [
    ...jobs.map(j => `Job ${j.job}${j.customer ? ` (${j.customer})` : ""}: ${String(j.report).replace(/\n/g, " ").slice(0, 140)}`),
    ...hits.filter(h => !/^job \d/.test(String(h.t))).slice(0, 3).map(h => `${when(h.at)}: ${h.t}`),
  ].slice(0, 5);

  res.json({
    ok: true, jobs, memories: hits.length,
    spoken: jobs.length
      ? `You've had this before. ${jobs[0].customer ? jobs[0].customer + ", " : ""}job ${jobs[0].job} — ${String(jobs[0].report).replace(/\n/g, ". ").slice(0, 160)}`
      : `Something similar came up: ${lines[0]}`,
    lines,
  });
});

/* --- the timeline --------------------------------------------------------
 * From incident response: a timestamped record that writes itself if he is
 * narrating anyway. Settles "how long were you there" without him thinking
 * about it during the job.
 * ---------------------------------------------------------------------- */
app.post("/scene/timeline", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const { action, job, entry } = req.body || {};
  STORE.timelines = STORE.timelines || {};
  const byJob = STORE.timelines[uid] = STORE.timelines[uid] || {};
  const key = jobNumberOf(job) || "current";

  if (action === "add" && entry) {
    const t = byJob[key] = byJob[key] || [];
    t.push({ at: Date.now(), what: String(entry).slice(0, 200) });
    if (t.length > 60) t.shift();
    saveStore();
    return res.json({ ok: true, count: t.length, spoken: "Noted." });
  }

  const t = byJob[key] || [];
  if (!t.length) return res.json({ ok: false, spoken: "Nothing logged for that job yet." });
  const mins = Math.round((t[t.length - 1].at - t[0].at) / 60000);
  res.json({
    ok: true,
    entries: t.map(x => ({ at: x.at, what: x.what, clock: new Date(x.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }) })),
    minutes: mins,
    spoken: `${t.length} steps over ${mins} minutes, starting ${new Date(t[0].at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}.`,
  });
});


/* ===========================================================================
 * THE ATTENTION LAYER (batch 143)
 *
 * 101 skills, eight advisors, watchers, a calendar and a weather feed. Every
 * one of them has something it could say. Without judgement about WHEN, more
 * capability makes Vision worse, not better — an assistant that speaks every
 * time gets muted, and then the one thing that mattered goes past unheard.
 *
 * Google Assistant tried proactive cards and killed them. Siri and Alexa
 * volunteer almost nothing, deliberately. The ones that survive — Screen Time,
 * Whoop's morning readout — pick ONE moment and put everything in it.
 *
 * So: three tiers, situational awareness, and a memory of what he brushed off.
 *
 *   NOW    interrupts without asking. Has a deadline; asking wastes the window.
 *          The bar is deliberately high, because every interruption spends
 *          credibility the next one needs.
 *   OFFER  one short line he can ignore. Never a question that waits for an
 *          answer — a question he's obliged to answer IS an interruption.
 *   LATER  waits for the digest, or for him to ask.
 *
 * And the rule that matters most: if he brushes something off, it stays off.
 * ======================================================================== */



const ATTENTION = {
  NOW: "now",       // storm, job starting, emergency
  OFFER: "offer",   // a landmark nearby — worth a line, never an announcement
  LATER: "later",   // spending patterns, seasonal advice
};

/* What is he doing right now? Read from what he's already told Vision — no new
 * sensors, no guessing. Each of these is a reason to stay quiet. */
function situation(uid) {
  const now = Date.now();
  const prof = profileOf(uid) || {};
  const s = { busy: false, why: "", quietUntil: 0 };

  // HE set the volume. A manual "stop/quiet" or "not now" overrides everything —
  // his instruction beats any automatic guess about whether it's a good moment.
  const mute = (STORE.conductorMute || {})[uid] || 0;
  if (mute === -1) return { busy: true, why: "he asked for quiet", quietUntil: -1, muted: true };  // -1 = until he lifts it
  if (mute && now < mute) return { busy: true, why: "he said not right now", quietUntil: mute, muted: true };

  // Mid-conversation with someone. The worst possible moment to interrupt —
  // he's talking to a human and Vision is in his ear.
  const live = (STORE.convoLive || {})[uid];
  if (live && live.turns && live.turns.length && (now - (live.at || 0)) < 5 * 60000) {
    return { busy: true, why: "he's mid-conversation with someone", quietUntil: (live.at || now) + 5 * 60000 };
  }

  // A work job running now, or about to. AEST hours from Asia, so this uses
  // the same both-zones logic the brief does.
  const today = (STORE.calToday || {})[uid] || {};
  for (const j of (today.jobs || [])) {
    if (!j.startMs) continue;
    const from = j.startMs - 10 * 60000, to = j.startMs + 90 * 60000;
    if (now >= from && now <= to) {
      return { busy: true, why: `he's on ${j.title}`, quietUntil: to };
    }
  }

  // Just captured a scene — he's elbows-deep in something.
  const scenes = (STORE.scenes || {})[uid] || {};
  for (const list of Object.values(scenes)) {
    if (list && list[0] && (now - list[0].at) < 20 * 60000) {
      return { busy: true, why: "he's working a job", quietUntil: list[0].at + 20 * 60000 };
    }
  }

  // Local night — HIS local, not the server's. Render runs UTC, so using the
  // server clock would have gone quiet from 11pm UTC, which is 6am in Hanoi:
  // silent all morning and chatty at midnight. Exactly backwards.
  try {
    const tz = COUNTRY_TZ[String(prof.country || "").toLowerCase()] || null;
    const hour = tz
      ? Number(new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date()))
      : null;
    // With no country set there is no honest way to know his local time, so
    // don't guess — a wrong quiet window is worse than none.
    if (hour !== null && (hour >= 23 || hour < 7)) {
      return { busy: true, why: "it's the middle of the night for him", quietUntil: 0 };
    }
  } catch {}

  return s;
}

/* --- dismissal memory ----------------------------------------------------
 * The single most annoying failure an assistant has: he says "not now", and
 * the same thing comes back an hour later. Brushing something off has to mean
 * something, or he learns that talking to it changes nothing.
 * ---------------------------------------------------------------------- */
const DISMISS_MS = {
  once: 4 * 3600000,        // "not now" — a few hours
  today: 20 * 3600000,      // "not today"
  trip: 30 * 86400000,      // "stop telling me this"
};

function dismissKey(kind, subject) {
  return `${kind}:${String(subject || "").toLowerCase().slice(0, 60)}`;
}

function isDismissed(uid, kind, subject) {
  const d = (STORE.dismissed || {})[uid] || {};
  const rec = d[dismissKey(kind, subject)];
  return !!(rec && rec.until > Date.now());
}

function dismiss(uid, kind, subject, scope) {
  STORE.dismissed = STORE.dismissed || {};
  const d = STORE.dismissed[uid] = STORE.dismissed[uid] || {};
  const ms = DISMISS_MS[scope] || DISMISS_MS.once;
  d[dismissKey(kind, subject)] = { until: Date.now() + ms, scope: scope || "once", at: Date.now() };
  // Expired dismissals are dead weight; clear them whenever we touch this.
  for (const [k, v] of Object.entries(d)) if (v.until < Date.now()) delete d[k];
  saveStore();
}

/* --- how urgent is this, really? -----------------------------------------
 * Deliberately conservative. Only a real deadline earns NOW, because the
 * value of an interruption comes entirely from how rarely they happen.
 * ---------------------------------------------------------------------- */
function tierOf(item) {
  const kind = item.kind || "";
  const text = String(item.note || item.spoken || "").toLowerCase();

  // A deadline he can still act on.
  if (kind === "timezone" || kind === "storm" || kind === "emergency") return ATTENTION.NOW;
  if (kind === "booking" && /inside (an hour|\d+ min)/.test(text)) return ATTENTION.NOW;
  if (/\b(now|right now|in \d+ min|about to|starting)\b/.test(text) && item.weight >= 80) return ATTENTION.NOW;

  // Worth offering while it's still relevant, but not worth interrupting for.
  if (kind === "weather" || kind === "landmark" || kind === "arrival" || kind === "tight") return ATTENTION.OFFER;

  // Everything else can wait for the digest.
  return ATTENTION.LATER;
}

/* --- the gate ------------------------------------------------------------
 * Everything that wants to speak comes through here. Returns what may be said
 * NOW, what may be offered, and what is being held — with the reason, so the
 * brief can be honest rather than mysteriously quiet.
 * ---------------------------------------------------------------------- */
function attention(uid, items, { asked = false } = {}) {
  const sit = situation(uid);
  const now = [], offer = [], held = [];

  for (const item of (items || [])) {
    if (isDismissed(uid, item.kind, item.note || item.spoken)) { held.push({ ...item, why: "he brushed this off" }); continue; }

    const tier = tierOf(item);

    // If he asked, he gets everything — the gate is about UNPROMPTED speech.
    if (asked) { now.push({ ...item, tier }); continue; }

    if (tier === ATTENTION.NOW) { now.push({ ...item, tier }); continue; }

    if (sit.busy) { held.push({ ...item, tier, why: sit.why }); continue; }

    if (tier === ATTENTION.OFFER) { offer.push({ ...item, tier }); continue; }
    held.push({ ...item, tier, why: "not urgent — saved for your brief" });
  }

  // One offer at a time — two offers is a list, and a list is an interruption.
  // But the surplus must be HELD, not dropped: a thing worth offering is worth
  // offering later, and silently discarding it means he never hears it at all.
  const offered = offer.slice(0, 1);
  for (const x of offer.slice(1)) held.push({ ...x, why: "one offer at a time — saved for your brief" });

  // Same for urgent items beyond the cap. Three warnings at once is noise, but
  // the third is not thereby unimportant.
  const spoken = now.slice(0, 2);
  for (const x of now.slice(2)) held.push({ ...x, why: "two at once is the limit — saved for your brief" });

  return { now: spoken, offer: offered, held, situation: sit };
}

/* --- into the brief ------------------------------------------------------
 * Replaces the raw advisor feed. The model is told not just WHAT could be
 * said but whether it has permission to say it — which is the whole point.
 * ---------------------------------------------------------------------- */
function attentionBrief(uid) {
  const raw = advise(uid, { max: 4 });
  if (!raw.length) return "";
  const a = attention(uid, raw);

  const parts = [];
  if (a.now.length) {
    parts.push(`SAY THIS FIRST, he needs it now: ${a.now.map(x => x.note).join(" | ")}`);
  }
  if (a.offer.length) {
    parts.push(`WORTH OFFERING, but only as one short line he can ignore — never announce it, ` +
      `and drop it entirely if he's asking about something else: ${a.offer[0].note}`);
  }
  if (a.held.length && !a.now.length && !a.offer.length) {
    // Say nothing, and say WHY nothing — so the model doesn't fill the silence.
    parts.push(`There are ${a.held.length} things worth raising later but NOT now (${a.held[0].why}). ` +
      `Do not mention them. He'll get them in his brief.`);
  }
  return parts.join(" ");
}

/* --- endpoints ------------------------------------------------------------ */

// "What have you been holding back?" — the digest. One moment, everything in it.
app.post("/attention/digest", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const raw = advise(uid, { max: 6 });
  const a = attention(uid, raw, { asked: true });
  if (!a.now.length) {
    return res.json({ ok: true, items: [], spoken: "Nothing I've been sitting on — you're on top of it." });
  }
  res.json({
    ok: true,
    items: a.now.map(x => ({ kind: x.kind, note: x.note, tier: x.tier })),
    spoken: a.now.map(x => x.note).join(" "),
  });
});

// "Not now" / "not today" / "stop telling me that" — and it sticks.
app.post("/attention/dismiss", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const { kind, subject, scope } = req.body || {};
  if (!kind && !subject) return res.status(400).json({ error: "kind or subject required" });
  dismiss(uid, kind || "any", subject || "", scope || "once");
  const howLong = scope === "trip" ? "for the rest of the trip"
    : scope === "today" ? "for today" : "for a few hours";
  dlog(uid, "memory", `dismissed ${kind || "item"} ${howLong}`);
  res.json({ ok: true, spoken: `Righto — I'll leave that ${howLong}.` });
});

// What is it holding, and why is it quiet? Being able to ask is what makes
// silence trustworthy rather than suspicious.
app.post("/attention/status", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const raw = advise(uid, { max: 6 });
  const a = attention(uid, raw);
  const d = Object.keys((STORE.dismissed || {})[uid] || {}).length;
  res.json({
    ok: true,
    holding: a.held.length,
    dismissed: d,
    busy: a.situation.busy,
    spoken: a.situation.busy
      ? `Staying quiet because ${a.situation.why}.` +
        (a.held.length ? ` I've got ${a.held.length} thing${a.held.length > 1 ? "s" : ""} for when you're free.` : "")
      : a.held.length
        ? `${a.held.length} thing${a.held.length > 1 ? "s" : ""} saved for your brief. Say "what have you got" and I'll run through them.`
        : "Nothing waiting.",
  });
});


/* ===========================================================================
 * FOLLOW-THROUGH (batch 154)
 *
 * A reminder that says "get milk" is a note. A reminder that says "get milk —
 * want me to take you to the IGA on the way home?" is an assistant.
 *
 * The gap between those two is small to describe and easy to get wrong, so
 * three decisions shape everything here:
 *
 * 1. THE MODEL WORKS OUT THE FOLLOW-THROUGH, NOT A RULES TABLE.
 *    "Get milk" implies a shop. "Ring the dentist" implies a call. "Grab the
 *    thing for Jess's mum" implies a shop too, and no list of keywords would
 *    ever cover that. So it's asked ONCE, when the reminder is set, and the
 *    answer is stored. At 6:30 it reads what it already decided — no thinking,
 *    no latency, no surprise.
 *
 * 2. IT LEARNS FROM WHAT HE ACTUALLY TAKES.
 *    Every offer records an outcome: taken, ignored, or refused. After a few
 *    weeks that's a real signal — "offered navigation on shopping reminders
 *    six times, he took five" is worth more than any guess. The hierarchy is
 *    EARNED rather than designed.
 *
 * 3. IT MUST NOT HARDEN TOO FAST.
 *    Three ignores is not a preference; it might be three bad moments. So the
 *    learning needs a real sample before it suppresses anything, and a single
 *    "yes" after a run of ignores resets the doubt. Getting this wrong makes
 *    it stubborn, which is worse than making it naive.
 * ======================================================================== */

const FOLLOW_MIN_SAMPLE = 5;      // before history outweighs the model's judgement
const FOLLOW_SUPPRESS_AT = 0.2;   // taken less than 1 in 5 times -> stop offering
const FOLLOW_MAX_LOG = 120;

/* --- what does this reminder actually need him to DO? --------------------
 * Asked once, at the moment he sets it. The model is good at this and a
 * keyword table never would be.
 * ---------------------------------------------------------------------- */
async function workOutFollowThrough(uid, label, when) {
  // What he usually does with reminders like this. Given to the model as
  // context, so its guess starts from his behaviour rather than from nothing.
  const past = followHistoryFor(uid).slice(0, 8)
    .map(h => `"${h.label}" -> offered ${h.action}, he ${h.outcome}`).join(" | ");

  try {
    const { status, text } = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 220,
      system:
        "A reminder has just been set. Work out what it will actually need him to DO when it fires, " +
        "so Vision can offer that rather than just reading the reminder back. " +
        "Most reminders need nothing — that is the normal answer and you should give it freely. " +
        "Only name an action when the reminder plainly implies one: buying something needs a shop, " +
        "'ring X' needs a call, 'book Y' needs a booking. " +
        "If he says 'on the way home' or 'while I'm out', that is a real constraint — record it, " +
        "because a shop behind him is no use." + NO_INVENT,
      messages: [{ role: "user", content:
        `Reminder: "${label}"${when ? ` (due ${when})` : ""}` +
        (past ? `\n\nWhat he's done with similar offers before: ${past}` : "") +
        `\n\nReply as compact JSON ONLY: ` +
        `"action" (one of: navigate, call, book, none), ` +
        `"what" (short — what he needs, e.g. "a supermarket"; "" if action is none), ` +
        `"constraint" (e.g. "on the way home", "before 9am", or ""), ` +
        `"offer" (one short spoken sentence offering it, or "" if action is none), ` +
        `"category" (a short kind-of-thing label like "shopping", "work call", "booking" — used to learn from).` }],
    });
    if (status !== 200) return null;
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    const p = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!p.action || p.action === "none") return null;
    return {
      action: String(p.action).slice(0, 20),
      what: String(p.what || "").slice(0, 80),
      constraint: String(p.constraint || "").slice(0, 60),
      offer: String(p.offer || "").slice(0, 200),
      category: String(p.category || "general").slice(0, 40),
    };
  } catch { return null; }
}

/* --- the learning ---------------------------------------------------------
 * Three outcomes, recorded every time: taken, ignored, refused. "Refused" is
 * weighted harder than "ignored" because it's a decision rather than a
 * distraction — he might simply have been driving.
 * ---------------------------------------------------------------------- */
function followHistoryFor(uid) {
  STORE.followLog = STORE.followLog || {};
  return (STORE.followLog[uid] = STORE.followLog[uid] || []);
}

function recordFollowOutcome(uid, { category, action, label, outcome }) {
  const log = followHistoryFor(uid);
  log.unshift({ category: category || "general", action, label: String(label || "").slice(0, 80), outcome, at: Date.now() });
  if (log.length > FOLLOW_MAX_LOG) log.length = FOLLOW_MAX_LOG;
  saveStore();
  try { dlog(uid, "memory", `follow-through: ${category}/${action} -> ${outcome}`); } catch {}
}

/* Should this offer be made at all? Returns a reason either way, so the
 * behaviour can be explained rather than just happening. */
function shouldOffer(uid, category, action) {
  const log = followHistoryFor(uid).filter(h => h.category === category && h.action === action);

  // Not enough to go on: offer, and find out. Being naive early is the
  // correct trade — that's how the sample gets built.
  if (log.length < FOLLOW_MIN_SAMPLE) {
    return { offer: true, why: `only ${log.length} of these so far — still learning` };
  }

  // A recent "yes" resets the doubt entirely. A run of ignores might have been
  // a bad week; one acceptance says the offer is still wanted.
  const lastTaken = log.findIndex(h => h.outcome === "taken");
  if (lastTaken > -1 && lastTaken < 3) {
    return { offer: true, why: "he took one of these recently" };
  }

  const taken = log.filter(h => h.outcome === "taken").length;
  const rate = taken / log.length;

  // A flat refusal counts double — it was a decision, not a distraction.
  const refused = log.filter(h => h.outcome === "refused").length;
  const adjusted = (taken) / (log.length + refused);

  if (adjusted < FOLLOW_SUPPRESS_AT) {
    return { offer: false, why: `he's taken ${taken} of ${log.length} — leaving it alone`, rate };
  }
  return { offer: true, why: `he takes about ${Math.round(rate * 100)}% of these`, rate };
}

/* --- endpoints ------------------------------------------------------------ */

// Called when a reminder is set. Works out the follow-through once and stores
// it, so firing is instant.
app.post("/follow/plan", requireAuth, async (req, res) => {
  const uid = uidOf(req);
  const { label, when, id } = req.body || {};
  if (!label) return res.status(400).json({ error: "label required" });

  const plan = await workOutFollowThrough(uid, label, when);
  if (!plan) return res.json({ ok: true, followUp: null });

  // Attach it to the watcher so it travels with the reminder.
  if (id) {
    const list = (STORE.watchers || {})[uid] || [];
    const w = list.find(x => x.id === id);
    if (w) { w.followUp = plan; saveStore(); }
  }
  res.json({ ok: true, followUp: plan });
});

// Called when a reminder fires. Decides whether to offer, based on what he's
// actually done before.
app.post("/follow/fire", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const { id, label } = req.body || {};
  const list = (STORE.watchers || {})[uid] || [];
  const w = list.find(x => x.id === id);
  const plan = w && w.followUp;

  if (!plan) return res.json({ ok: true, offer: null });

  // He may have told it to stop offering this kind of thing.
  if (isDismissed(uid, "followup", plan.category)) {
    return res.json({ ok: true, offer: null, held: "he asked me to stop offering these" });
  }

  const verdict = shouldOffer(uid, plan.category, plan.action);
  if (!verdict.offer) {
    return res.json({ ok: true, offer: null, held: verdict.why });
  }

  res.json({
    ok: true,
    offer: {
      action: plan.action, what: plan.what, constraint: plan.constraint,
      category: plan.category,
      spoken: plan.offer || `Want me to help with that?`,
    },
    why: verdict.why,
  });
});

// What he did about it. This is the whole learning loop.
app.post("/follow/outcome", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const { category, action, label, outcome } = req.body || {};
  if (!["taken", "ignored", "refused"].includes(outcome)) {
    return res.status(400).json({ error: "outcome must be taken, ignored or refused" });
  }
  recordFollowOutcome(uid, { category, action, label, outcome });

  // "Stop offering these" is a standing instruction, not one refusal. Only a
  // deliberate refusal sets it, and only after enough of them to be a pattern
  // rather than a mood.
  if (outcome === "refused") {
    const log = followHistoryFor(uid).filter(h => h.category === category);
    const refusals = log.filter(h => h.outcome === "refused").length;
    if (refusals >= 3) {
      dismiss(uid, "followup", category, "trip");
      return res.json({ ok: true, spoken: "Righto — I'll stop offering those." });
    }
  }
  res.json({ ok: true });
});

// "What have you learned about me?" — being able to see it is what makes the
// learning trustworthy rather than spooky.
app.post("/follow/learned", requireAuth, (req, res) => {
  const uid = uidOf(req);
  const log = followHistoryFor(uid);
  if (!log.length) {
    return res.json({ ok: true, patterns: [], spoken: "Nothing learned yet — I need to offer you a few things first." });
  }

  const byCat = {};
  for (const h of log) {
    const k = `${h.category}|${h.action}`;
    byCat[k] = byCat[k] || { category: h.category, action: h.action, taken: 0, ignored: 0, refused: 0, n: 0 };
    byCat[k][h.outcome]++; byCat[k].n++;
  }

  const patterns = Object.values(byCat)
    .filter(p => p.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, 6)
    .map(p => ({
      ...p,
      rate: Math.round((p.taken / p.n) * 100),
      // Say it the way a person would, not as a statistic.
      plain: p.taken / p.n >= 0.6
        ? `you usually take me up on ${p.category}`
        : p.taken / p.n <= 0.2
          ? `you don't want ${p.category} offers`
          : `you sometimes want ${p.category}`,
    }));

  res.json({
    ok: true, patterns,
    spoken: patterns.length
      ? patterns.slice(0, 2).map(p => p.plain).join(", and ") + "."
      : "Still working you out.",
  });
});


const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`glasses proxy listening on :${PORT}`));
