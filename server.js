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
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204); // preflight
  next();
});

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const KEY = process.env.ANTHROPIC_API_KEY;
const APP_TOKEN = process.env.APP_SHARED_TOKEN;
const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY; // optional
const FLIGHT_KEY = process.env.AVIATIONSTACK_KEY;  // optional (flight tracking)
const ICLOUD_USER = process.env.ICLOUD_USER;       // optional (email briefing) e.g. you@icloud.com
const ICLOUD_APP_PW = process.env.ICLOUD_APP_PW;   // app-specific password (NOT your real password)

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
let STORE = { profiles: {}, briefs: {}, flags: {}, mem: {}, watchers: {}, results: {}, seen: {} };
try { STORE = { ...STORE, ...JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) }; } catch {}
let _saveT = null;
function saveStore() { clearTimeout(_saveT); _saveT = setTimeout(() => { try { fs.writeFileSync(STORE_FILE, JSON.stringify(STORE)); } catch {} }, 1500); }
function uidOf(req) { return String((req.body && req.body.uid) || req.query.uid || "shaun-default").slice(0, 64); }
function profileOf(uid) { return STORE.profiles[uid] || { name: "Shaun", ainame: "Vision" }; }
function flagsOf(uid) { return STORE.flags[uid] = STORE.flags[uid] || { quiet: false, whisper: false, saver: false }; }

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

app.get("/state", requireAuth, (req, res) => { const uid = uidOf(req); res.json({ flags: flagsOf(uid), brief: briefOf(uid) }); });
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
  if (action === "add" && text) { mem.push({ t: String(text).slice(0, 500), at: Date.now() }); while (mem.length > 400) mem.shift(); saveStore(); return res.json({ ok: true, count: mem.length }); }
  if (action === "search" && text) { const q = String(text).toLowerCase(); return res.json({ hits: mem.filter(m => m.t.toLowerCase().includes(q)).slice(-8) }); }
  if (action === "forget" && text) { const q = String(text).toLowerCase(); const before = mem.length; STORE.mem[uid] = mem.filter(m => !m.t.toLowerCase().includes(q)); saveStore(); return res.json({ removed: before - STORE.mem[uid].length }); }
  if (action === "all") return res.json({ profile: profileOf(uid), count: mem.length, recent: mem.slice(-12) });
  res.status(400).json({ error: "bad action" });
});

function requireAuth(req, res, next) {
  const auth = req.get("authorization") || "";
  if (auth !== `Bearer ${APP_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Forward a non-streaming request to Claude and return the raw JSON.
// --- USAGE METER (batch 48): count every token the server actually spends.
// ESTIMATE ONLY — your Anthropic key can't read the real balance (needs an
// admin key), so console.anthropic.com stays the source of truth for the bill.
const usageTotals = {}; // model -> { calls, inTok, outTok }
function recordUsage(model, u) {
  if (!u) return;
  const m = usageTotals[model] = usageTotals[model] || { calls: 0, inTok: 0, outTok: 0 };
  m.calls++; m.inTok += u.input_tokens || 0; m.outTok += u.output_tokens || 0;
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

async function callClaude(body) {
  const _t0 = Date.now();
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { const j = JSON.parse(text); if (r.status === 200) trackUsage(body.model, j.usage); } catch {}
  return { status: r.status, text };
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

    const system = "You are Vision, Shaun's warm AI companion in his glasses. You're looking through his camera. Keep answers SHORT, warm, and spoken-friendly — no markdown, no lists, no preamble.";

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
    system: "You are Vision, a warm translation helper for Shaun. Be accurate and natural, not literal-clunky.",
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
    });
  } catch (e) {
    res.status(200).json({ fallback: true, translation: "Translation hiccup — give it another go." });
  }
});

// --- Scam & price-check guard: is this a fair price here? ---
app.post("/scamcheck", requireAuth, async (req, res) => {
  const { item, price, currency, country } = req.body || {};
  if (!item || price == null) return res.status(400).json({ error: "item and price required" });
  const where = country ? ` in ${country}` : "";
  const cur = currency || "local currency";
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 220,
    system: "You are Vision, a savvy travel companion who protects Shaun from being overcharged. You know rough local price norms for common tourist goods/services (taxis, tuk-tuks, street food, markets, SIM cards, souvenirs) across SE Asia and worldwide. Be honest and practical, never alarmist.",
    messages: [{
      role: "user",
      content:
        `Shaun is being asked to pay ${price} ${cur} for "${item}"${where}. ` +
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
  } catch (e) {
    res.status(200).json({ fallback: true, spoken: "Price-check hiccup — give it another go." });
  }
});

// --- Allergy / dietary shield: is this safe for me to eat? ---
app.post("/allergy", requireAuth, async (req, res) => {
  const { dish, avoid, country, image, mediaType } = req.body || {};
  const avoidList = Array.isArray(avoid) ? avoid.join(", ") : (avoid || "");
  if (!avoidList) return res.status(400).json({ error: "avoid (what to avoid) required" });
  const sys = "You are Vision, Shaun's dietary safety guard while travelling. You know common hidden sources of allergens/restricted ingredients in local cuisines (e.g. fish sauce, shrimp paste, peanuts in SE Asian food). Be careful and clear. When unsure, say so and advise asking/confirming with the vendor in the local language. NEVER give false reassurance.";
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
    system: sys,
    messages: [{ role: "user", content }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, risk: "unsure", spoken: "I couldn't check that clearly — when in doubt, ask the vendor directly before eating." });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { risk: "unsure", spoken: raw, askVendor: "" }; }
    res.json({ risk: p.risk || "unsure", spoken: p.spoken || raw, askVendor: p.askVendor || "" });
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
    system: "You are Vision, Shaun's savvy money companion abroad. You judge whether a price is good value for the country, in plain friendly terms. You know rough local costs across SE Asia and worldwide.",
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
  const { goal, city, budget, currency, profile, date } = req.body || {};
  if (!goal && !city) return res.status(400).json({ error: "goal or city required" });
  const body = {
    model: "claude-sonnet-4-6", // planning benefits from the stronger model
    max_tokens: 900,
    system: "You are Vision, Shaun's travel companion who PLANS his day, not just answers. Build a realistic, well-paced itinerary for the place and budget, with actual place types, rough times, and rough costs. Be specific and local, mindful of opening hours and travel time. Keep it doable, not a rushed checklist.",
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
  const { question, country } = req.body || {};
  if (!question) return res.status(400).json({ error: "question required" });
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 240,
    system: "You are Vision, Shaun's discreet cultural guide abroad. Give warm, practical etiquette advice for the country — what's polite, what to avoid, how to do it right. Short and spoken-friendly. Be specific to the local culture, not generic.",
    messages: [{
      role: "user",
      content: `${country ? `In ${country}: ` : ""}${question}\n` +
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
    system: "You are Vision, Shaun's knowledgeable, enthusiastic travel guide. When he looks at something, you tell him what it is and something genuinely interesting — like a great local guide would, briefly.",
    messages: [{ role: "user", content }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ fallback: true, spoken: "I couldn't make that out clearly — try a closer photo?" });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { name: "", spoken: raw, tip: "" }; }
    res.json({ name: p.name || "", spoken: p.spoken || raw, tip: p.tip || "" });
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
    system: "You are Vision, preparing Shaun an offline survival phrase pack for travel. Give the most useful emergency and everyday phrases in the local language with pronunciation and English.",
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
    res.json({ phrases: p.phrases || [], emergency: p.emergency || "", tip: p.tip || "" });
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
    ctx.brief ? `WHAT YOU KNOW ABOUT SHAUN'S SITUATION RIGHT NOW: ${ctx.brief} Use this naturally — factor it into answers without reciting it back at him. If he has an allergy or diet restriction listed, it overrides everything when food is involved.` : "",
    ctx.profile ? `What you remember about Shaun (use naturally when relevant, don't recite it): ${ctx.profile}` : "",
  ].filter(Boolean).join(" ").split("Shaun").join(NAME);
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
  if (words > 20) return "claude-sonnet-4-6";
  return "claude-haiku-4-5-20251001"; // short & simple → fast, cheap
}

// --- SHARED ROOMS: pairing + location/pin/message sync between two Buddies ---
// A "room" is a shared trip code (e.g. SHAUN-LILA). Two people who enter the same
// code can see each other's location, dropped pins, and relayed messages.
// NOTE: in-memory store — resets on redeploy. Fine for a live trip; a database is
// the durable upgrade. This is also the exact backbone the glasses will use for
// live "see what I see" + voice walkie-talkie once the native app can stream.
const rooms = Object.create(null);
function room(code) {
  const k = String(code || "").trim().toUpperCase();
  if (!k) return null;
  if (!rooms[k]) rooms[k] = { members: {}, pins: [], messages: [], frames: {}, spend: [] };
  return rooms[k];
}

// Join / announce presence in a room.
app.post("/pair", requireAuth, (req, res) => {
  const { code, name } = req.body || {};
  const r = room(code);
  if (!r) return res.status(400).json({ error: "code required" });
  const who = (name || "me").trim();
  r.members[who] = r.members[who] || { name: who, at: Date.now() };
  r.members[who].joinedAt = Date.now();
  res.json({ ok: true, code: String(code).toUpperCase(), members: Object.keys(r.members) });
});

// Push my current state to the room: location, a pin, a message, or a frame stub.
app.post("/share", requireAuth, (req, res) => {
  const { code, name, lat, lng, pin, message, frame } = req.body || {};
  const r = room(code);
  if (!r) return res.status(400).json({ error: "code required" });
  const who = (name || "me").trim();
  const m = (r.members[who] = r.members[who] || { name: who });
  if (lat != null && lng != null) { m.lat = lat; m.lng = lng; m.at = Date.now(); }
  if (pin && pin.lat != null) r.pins.unshift({ by: who, label: pin.label || "Pin", lat: pin.lat, lng: pin.lng, at: Date.now() });
  if (message) r.messages.unshift({ by: who, text: String(message).slice(0, 500), at: Date.now() });
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
  const r = room(code);
  if (!r) return res.status(400).json({ error: "code required" });
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

// --- Meet in the middle: find a spot halfway between the two of you ---
app.post("/meetmiddle", requireAuth, async (req, res) => {
  const { code, name, lat, lng, what } = req.body || {};
  const r = room(code);
  if (!r) return res.status(400).json({ error: "code required" });
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
  } catch (e) { res.status(502).json({ error: "meetmiddle_failed" }); }
});

// --- Trip journal: weave the shared room (pins, messages, spend) into a story ---
app.post("/journal", requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const r = room(code);
  if (!r) return res.status(400).json({ error: "code required" });
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
      system: "You are Vision, writing a warm, short day-by-day trip journal for Shaun and his wife from their shared trip data. Weave pins (places they met/marked), messages, and spending into a little story of their trip. Keep it personal and brief.",
      messages: [{ role: "user", content: `Trip data:\n${JSON.stringify(raw)}\n\nReply as compact JSON ONLY: "spoken" (one warm summary line) and "story" (the short journal, a few paragraphs max, grouped by day where dates allow).` }],
    };
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.json({ spoken: "Couldn't write the journal just now.", story: "" });
    const txt = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(txt.replace(/```json|```/g, "").trim()); } catch { p = { spoken: "Here's your trip so far.", story: txt }; }
    res.json({ spoken: p.spoken || "Here's your trip so far.", story: p.story || "" });
  } catch (e) { res.status(502).json({ error: "journal_failed" }); }
});

// --- Arrival Autopilot: one command when Shaun lands — detect country, set up, brief him ---
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
      system: "You are Vision, Shaun's Aussie travel companion. He has JUST LANDED somewhere new. Give him the arrival essentials, warm and brief, spoken-style.",
      messages: [{ role: "user", content: `Shaun just landed in ${city ? city + ", " : ""}${country}. Reply as compact JSON ONLY: "currency" (ISO code), "spoken" (warm 3-4 sentence arrival brief: emergency number, the #1 scam to dodge arriving here, tipping norm, rough AUD exchange rate), "emergency", "scam", "tipping", "rate" (each one short line).` }],
    };
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(502).json({ error: "arrival_failed" });
    const txt = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(txt.replace(/```json|```/g, "").trim()); } catch { p = { spoken: txt }; }
    res.json({ country, city, currency: p.currency || "", spoken: p.spoken || "", brief: { emergency: p.emergency || "", scam: p.scam || "", tipping: p.tipping || "", rate: p.rate || "" } });
  } catch (e) { res.status(502).json({ error: "arrival_failed" }); }
});

// --- Phrasebook: translate a phrase into the local language + speakable lang code ---
app.post("/phrase", requireAuth, async (req, res) => {
  const { text, country } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const body = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: `Translate into the main local language of ${country || "the country the traveller is in"}: "${text}". Reply as compact JSON ONLY: "translation", "lang" (BCP-47 code like th-TH), "phonetic" (simple pronunciation).` }],
    };
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(502).json({ error: "phrase_failed" });
    const txt = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(txt.replace(/```json|```/g, "").trim()); } catch { p = { translation: txt, lang: "" }; }
    res.json({ translation: p.translation || "", lang: p.lang || "", phonetic: p.phonetic || "" });
  } catch (e) { res.status(502).json({ error: "phrase_failed" }); }
});

// Fetch the latest "what I'm seeing" frame a partner shared (glasses-era; works now via photo).
app.post("/frame", requireAuth, (req, res) => {
  const { code, from } = req.body || {};
  const r = room(code);
  if (!r) return res.status(400).json({ error: "code required" });
  const f = r.frames[(from || "").trim()];
  if (!f) return res.status(404).json({ error: "no_frame" });
  res.json({ frame: f.data, mediaType: f.mediaType, at: f.at });
});

// --- Food concierge: find a dish, rank by rating/price/ETA, return Grab deep-link ---
// Pre-built brain for the glasses flow: "Vision, find me a steak sandwich" →
// options read aloud with price+rating+ETA → you confirm → deep-link into Grab to pay.
app.post("/findfood", requireAuth, async (req, res) => {
  const { craving, city, budget, currency } = req.body || {};
  if (!craving) return res.status(400).json({ error: "craving required" });
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    system: "You are Vision, Shaun's food concierge abroad. Given what he's craving and where he is, suggest realistic nearby options a delivery app like Grab would have, with plausible price, rating, and delivery ETA. Be realistic for the city; don't invent famous names — describe the kind of place. Rank best-value first.",
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
      system: "You are Vision, building Shaun a clean trip timeline from his booking-confirmation emails. Extract flights, hotels, trains, and reservations with dates/times/locations. Ignore marketing.",
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
    res.status(502).json({ error: "itinerary_failed", detail: String(e) });
  }
});

// --- Router: classify a natural message → which Vision skill + extracted args ---
// This is what makes the single chat box feel agentic: you just talk, Vision
// figures out whether you want a price check, a day plan, a landmark, etc.
app.post("/route", requireAuth, async (req, res) => {
  const { message, history, brief } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  const hist = Array.isArray(history) ? history.slice(-6) : [];
  rememberBrief(uidOf(req), brief);
  const stateNote = (typeof brief === "string" && brief.trim())
    ? `\n\nWhat Vision already knows about Shaun's situation (use it to FILL IN arguments he didn't say out loud — his country, currency, allergies, saved spots, tracked flight):\n${brief.slice(0, 900)}`
    : "";
  const contextNote = hist.length
    ? "\n\nRecent conversation (use it to resolve follow-ups like 'that one', 'the closest', 'a bank instead', 'yes', 'do it' — infer what Shaun means from context):\n" +
      hist.map(h => `${h.role === "user" ? "Shaun" : "Vision"}: ${h.content}`).join("\n")
    : "";
  const body = {
    model: "claude-haiku-4-5-20251001", // routing must be fast
    max_tokens: 300,
    system:
      "You are the intent router for Vision, a travel companion. Given what Shaun says, decide which ONE skill best answers it, and extract the arguments. " +
      "Skills: " +
      "\"chat\" (general talk/questions — the default), " +
      "\"scamcheck\" (is a price fair? args: item, price, currency), " +
      "\"gooddeal\" (is this good value/worth it? args: item, price, currency), " +
      "\"planday\" (plan my day/itinerary; args: goal, city, budget, currency), " +
      "\"landmark\" (what is this place/building? args: place), " +
      "\"etiquette\" (local customs/politeness/tipping; args: question), " +
      "\"converse\" (translate this / say this in X / what did they say; args: text, theirLang), " +
      "\"weather\" (args: none), \"currency\" (convert money; args: from, to, amount), " +
      "\"unlost\" (get me back / walk me to my spot; args: none), " +
      "\"survival\" (emergency phrases/offline pack; args: country), " +
      "\"whereis\" (where is my wife/partner/husband, find them; args: none), " +
      "\"tellpartner\" (tell/message my wife/partner something; args: message), " +
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
      "\"allergy\" (is this safe to eat / can I eat X / does this have nuts; args: dish), " +
      "\"logspend\" (log/record spending — spent 50 on lunch, log 12 for coffee; args: amount, note), " +
      "\"readtexts\" (read my texts/messages; args: none), " +
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
      "\"watcher\" (watch/keep an eye on/monitor/let me know if-or-when — recurring or threshold alerts: 'watch flights to Bali under 300', 'watch the weather in Da Nang', 'let me know if the dollar hits 17000 dong', 'keep an eye out for gigs this weekend'; args: request = the full request text), " +
      "\"call\" (call/phone/ring a number; args: number), " +
      "\"text\" (text/message/SMS a number; args: number, message). " +
      "Pick the single best skill. Judge INTENT, not just keywords — infer what Shaun actually wants to happen. Use the recent conversation to resolve short follow-ups and fill in args. If he's acting on something just discussed (take me there, the closest, book it, yes), pick the skill that continues that thread. Only use \"chat\" when nothing else genuinely fits. Set confidence honestly: 0.8+ when intent is clear, lower when guessing. " +
      "ROUTING RULES for cases that get confused: " +
      "(1) Wanting to GO somewhere unnamed ('take me to the cinema', 'I need a chemist', 'find me a bank and take me there') = \"nearby\" to find it, with \"then\" [{skill:navigate}] to go. Naming a specific place or address = \"navigate\" directly. " +
      "(2) Shopping for flights to BUY ('cheapest flights to Bali', 'flights Brisbane to Denpasar in September', 'when should I fly') = \"flightsearch\". Only use \"flight\" for tracking a flight he already has. " +
      "(3) Hotels/accommodation = \"stay\". Tours, sights, events, things to do = \"activities\". Multi-day planning for a destination = \"tripplan\"; asking what's on a day of an EXISTING plan = \"tripday\". " +
      "(4) If nothing fits, \"chat\" is always correct — a wrong skill is worse than chat, because chat can search the web and answer anyway.",
    messages: [{
      role: "user",
      content:
        `Shaun said: "${message}"${contextNote}${stateNote}\n` +
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
    res.json({ skill: p.skill || "chat", args: p.args || {}, then: Array.isArray(p.then) ? p.then.slice(0, 5) : [], confidence: p.confidence ?? 0 });
  } catch (e) {
    res.status(200).json({ skill: "chat", args: {}, confidence: 0 });
  }
});

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
    };
    rememberBrief(uidOf(req), ctx.brief);

    // Build the message list: prior history (trimmed) + this turn.
    const history = Array.isArray(b.history) ? b.history.slice(-8) : [];
    const messages = b.messages /* app may still send raw */ || [
      ...history,
      { role: "user", content: message },
    ];

    const model = flagsOf(uidOf(req)).saver ? "claude-haiku-4-5-20251001" : pickModel(message || history.map(h=>h.content).join(" "), b.model);

    const upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: b.max_tokens || 600,
        system: buddyPersona(ctx),
        messages,
        // CONNECTOR: Anthropic web search — lets the brain look up LIVE info
        // (opening hours, events, current prices) when the question needs it.
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        // NON-streaming: simpler + reliable. App just reads data.reply.
      }),
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
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
      if (j && j.usage) recordUsage(model, j.usage);
      trackUsage(model, j.usage);
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
app.post("/directions", requireAuth, async (req, res) => {
  if (!GMAPS_KEY) {
    return res.status(501).json({ error: "google_directions_disabled",
      hint: "Set GOOGLE_MAPS_API_KEY to enable, or fall back to Apple routing." });
  }
  const { originLat, originLng, destination, mode } = req.body || {};
  if (originLat == null || originLng == null || !destination) {
    return res.status(400).json({ error: "originLat, originLng, destination required" });
  }
  const travelMode = ["walking", "driving", "transit", "bicycling"].includes(mode) ? mode : "walking";

  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", `${originLat},${originLng}`);
  url.searchParams.set("destination", destination); // Google geocodes the text for us
  url.searchParams.set("mode", travelMode);
  url.searchParams.set("key", GMAPS_KEY);

  try {
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== "OK" || !data.routes?.length) {
      return res.status(404).json({ error: "no_route", googleStatus: data.status });
    }
    const route = data.routes[0];
    const leg = route.legs[0];

    // Strip Google's HTML tags from instructions so TTS reads them cleanly.
    const clean = (html) =>
      html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    const steps = leg.steps.map((s) => ({
      text: clean(s.html_instructions || ""),
      distanceMeters: s.distance?.value ?? 0,
      lat: s.start_location?.lat,
      lng: s.start_location?.lng,
    }));

    // Concierge voice: a warm one-line summary Vision can speak before guiding.
    let spoken = "";
    try {
      const firstFew = steps.slice(0, 3).map(s => s.text).join(". ");
      const g = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system: "You are Vision guiding Shaun through his glasses. One warm, natural spoken sentence — no lists.",
        messages: [{ role: "user", content:
          `Summarise this walk/drive for Shaun in ONE friendly spoken sentence (mention the time and roughly what to do first). ` +
          `${leg.duration?.text || ""}, ${leg.distance?.text || ""}. First moves: ${firstFew}` }],
      });
      if (g.status === 200) {
        const j = JSON.parse(g.text);
        spoken = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
      }
    } catch {}

    res.json({
      summary: route.summary || "",
      spoken: spoken || `It's ${leg.duration?.text || "a short trip"} — I'll guide you.`,
      distanceText: leg.distance?.text || "",
      durationText: leg.duration?.text || "",
      steps,
    });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// --- Places / points of interest: Google Places (Nearby + Text search) ---
// Body: { lat, lng, query? , type? , radius? }
//   query  -> text search ("ramen", "pharmacy open now")
//   type   -> Places type filter ("restaurant","atm","hospital"...)
//   radius -> meters (default 1500)
// Returns: { places: [{ name, address, lat, lng, rating, openNow, types, placeId }] }
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
      return res.status(502).json({ error: "places_failed", googleStatus: data.status });
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
        system: "You are Vision, Shaun's warm companion in his glasses. Recommend places like a helpful local friend — never a raw list dump.",
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
    res.status(502).json({ error: String(e) });
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
    res.status(502).json({ error: String(e) });
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
      return res.status(502).json({ error: "places_failed", googleStatus: data.status });
    const places = (data.results || [])
      .filter(p => p.rating).sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 6)
      .map(p => ({ name: p.name, address: p.formatted_address || p.vicinity || "",
        rating: p.rating ?? null, priceLevel: p.price_level ?? null,
        openNow: p.opening_hours?.open_now ?? null }));
    let spoken = "I couldn't find places to stay there — try naming the area.";
    if (places.length) {
      const body = {
        model: "claude-haiku-4-5-20251001", max_tokens: 200,
        system: "You are Vision, a warm travel companion. Given hotel options, recommend ONE in 2 short spoken sentences (why it stands out), mention a runner-up by name. No lists, no markdown.",
        messages: [{ role: "user", content: JSON.stringify(places) }],
      };
      const { status, text } = await callClaude(body);
      if (status === 200) { try { spoken = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim() || spoken; } catch {} }
    }
    const where = area || (places[0] ? places[0].address.split(",").slice(-2).join(",").trim() : "");
    const bookLink = "https://www.booking.com/searchresults.html?ss=" + encodeURIComponent(where || "hotels");
    res.json({ spoken, places, bookLink });
  } catch (e) { res.status(502).json({ error: "stay_failed" }); }
});

// --- 🎟️ ACTIVITIES: things to do, live via web search ---
// Body: { city?, country?, interests? }  Returns { spoken, items:[..] }
app.post("/activities", requireAuth, async (req, res) => {
  const { city, country, interests } = req.body || {};
  const where = [city, country].filter(Boolean).join(", ") || "the area Shaun is in";
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 500,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    system: "You are Vision, a warm travel companion speaking aloud. Suggest 4-5 genuinely good things to do — current, specific, not tourist-trap filler. Use web search if it helps (events, seasonal). Reply as JSON only: {\"spoken\": \"2-3 sentence pick of the best one or two\", \"items\": [\"short line each\"]}. No markdown.",
    messages: [{ role: "user", content: `Things to do in ${where}${interests ? " — he's into " + interests : ""}.` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(502).json({ error: "activities_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300), items: [] }; }
    res.json({ spoken: p.spoken || "", items: Array.isArray(p.items) ? p.items.slice(0, 6) : [] });
  } catch (e) { res.status(502).json({ error: "activities_failed" }); }
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
    system: "You are Vision, a sharp travel planner. Build a realistic day-by-day plan — geographically sensible (cluster nearby things), paced like a human (not 12 stops a day), with real place names. Web-search if current info helps. Reply as JSON ONLY: {\"spoken\": \"2-3 sentences selling the shape of the trip\", \"days\": [{\"day\": 1, \"title\": \"...\", \"items\": [{\"when\": \"morning|afternoon|evening\", \"what\": \"short line\"}]}]}. No markdown.",
    messages: [{ role: "user", content: `${nDays}-day plan for ${destination}.${budget ? ` Budget ${budget} ${currency || ""}/day.` : ""}${interests ? ` Into: ${interests}.` : ""}` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(502).json({ error: "tripplan_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return res.status(502).json({ error: "tripplan_parse" }); }
    res.json({ spoken: p.spoken || "", plan: { destination, days: Array.isArray(p.days) ? p.days.slice(0, nDays) : [] } });
  } catch (e) { res.status(502).json({ error: "tripplan_failed" }); }
});

// --- 🎒 PACKLIST ---  Body: { destination, days?, month? }  Returns { spoken, items }
app.post("/packlist", requireAuth, async (req, res) => {
  const { destination, days, month } = req.body || {};
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 450,
    system: "You are Vision. Build a tight packing list for the trip — climate-aware, no obvious filler (\"clothes\"), include the things people forget (adapters, meds, offline maps). JSON only: {\"spoken\": \"1-2 sentences with the non-obvious highlights\", \"items\": [\"item — why, only when not obvious\"]}. Max 15 items.",
    messages: [{ role: "user", content: `Packing for ${destination || "a trip"}${days ? `, ${days} days` : ""}${month ? `, in ${month}` : ""}. He's travelling from Australia.` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(502).json({ error: "packlist_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 200), items: [] }; }
    res.json({ spoken: p.spoken || "", items: Array.isArray(p.items) ? p.items.slice(0, 15) : [] });
  } catch (e) { res.status(502).json({ error: "packlist_failed" }); }
});

// --- 💵 TRIPBUDGET: what will it cost, live-informed ---
// Body: { destination, days?, style? }  Returns { spoken, perDay, total, currency }
app.post("/tripbudget", requireAuth, async (req, res) => {
  const { destination, days, style } = req.body || {};
  if (!destination) return res.status(400).json({ error: "destination required" });
  const nDays = Number(days) || 7;
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 400,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    system: "You are Vision, honest about money. Estimate a realistic daily budget for the trip in AUD (his home currency) — food, transport, activities, drinks; note what accommodation adds separately. Web-search current prices if useful. JSON only: {\"spoken\": \"2-3 plain sentences with the daily number and what swings it\", \"perDay\": <number AUD>, \"total\": <number AUD>, \"currency\": \"AUD\"}.",
    messages: [{ role: "user", content: `${nDays} days in ${destination}, ${style || "mid-range"} style.` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(502).json({ error: "tripbudget_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300) }; }
    res.json({ spoken: p.spoken || "", perDay: p.perDay ?? null, total: p.total ?? null, currency: p.currency || "AUD" });
  } catch (e) { res.status(502).json({ error: "tripbudget_failed" }); }
});

// --- 📶 ESIM: data options for a country, live ---
// Body: { country }  Returns { spoken, options }
app.post("/esim", requireAuth, async (req, res) => {
  const { country } = req.body || {};
  if (!country) return res.status(400).json({ error: "country required" });
  const body = {
    model: "claude-haiku-4-5-20251001", max_tokens: 450,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    system: "You are Vision, practical about phone data abroad. For the country given: best eSIM options for an Australian traveller (e.g. Airalo/Holafly/local telco), rough current prices, and whether a local physical SIM at the airport beats them. Web-search for current pricing. JSON only: {\"spoken\": \"2-3 sentences with your actual pick\", \"options\": [\"short line each\"]}.",
    messages: [{ role: "user", content: `Data/eSIM for ${country}.` }],
  };
  try {
    const { status, text } = await callClaude(body);
    if (status !== 200) return res.status(502).json({ error: "esim_failed" });
    const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300), options: [] }; }
    res.json({ spoken: p.spoken || "", options: Array.isArray(p.options) ? p.options.slice(0, 5) : [] });
  } catch (e) { res.status(502).json({ error: "esim_failed" }); }
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

  const ok = Object.values(checks).every(c => c.ok !== false);
  res.json({ ok, checkedAt: new Date().toISOString(), checks });
});

// --- Weather: current + short forecast (Open-Meteo, no key) ---
// Body: { lat, lng }
app.post("/weather", requireAuth, async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: "lat,lng required" });
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lng));
  u.searchParams.set("current", "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m");
  u.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max");
  u.searchParams.set("forecast_days", "2");
  u.searchParams.set("timezone", "auto");
  try {
    const r = await fetch(u);
    const data = await r.json();
    // Vision's warm spoken forecast + a practical tip.
    let spoken = "";
    try {
      const c = data.current || {}, d = data.daily || {};
      const facts = `Now: ${c.temperature_2m}°C (feels ${c.apparent_temperature}°), wind ${c.wind_speed_10m} km/h, precip ${c.precipitation}mm, code ${c.weather_code}. ` +
        `Today high ${d.temperature_2m_max?.[0]}° low ${d.temperature_2m_min?.[0]}°, rain chance ${d.precipitation_probability_max?.[0]}%.`;
      const g = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system: "You are Vision in Shaun's glasses. Say the weather like a friend — one or two spoken sentences, plain temps, and ONE practical tip (jacket/umbrella/sunscreen/wind) when relevant. No numbers-soup, no markdown.",
        messages: [{ role: "user", content: `Give Shaun the weather from this data:\n${facts}` }],
      });
      if (g.status === 200) { const j = JSON.parse(g.text);
        spoken = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim(); }
    } catch {}
    res.json({ raw: data, spoken: spoken || `It's ${data.current?.temperature_2m}° right now.` });
  } catch (e) { res.status(502).json({ error: String(e) }); }
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
  } catch (e) { res.status(502).json({ error: String(e) }); }
});

// --- Summarize: "catch me up" on forwarded messages, or a daily debrief ---
// Body: { items: [strings], style: "messages" | "debrief" }
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
    res.status(502).json({ error: String(e) });
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
    res.status(502).json({ error: "imap_failed", detail: String(e) });
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
      system: "You are Vision, Shaun's warm companion in his glasses. Triage his unread email like a sharp assistant.",
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
    res.status(502).json({ error: "imap_failed", detail: String(e) });
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
    res.status(502).json({ error: "imap_failed", detail: String(e) });
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
    res.status(502).json({ error: "smtp_failed", detail: String(e) });
  }
});

// Send a normal email reply (for actual emails, not SMS).
app.post("/mail/send", requireAuth, async (req, res) => {
  if (!mailReady() || !nodemailer) return res.status(501).json({ error: "mail_disabled" });
  const { to, subject, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: "to and message required" });
  try {
    await mailer().sendMail({ from: ICLOUD_USER, to, subject: subject || "(no subject)", text: String(message) });
    res.json({ ok: true, to });
  } catch (e) {
    res.status(502).json({ error: "smtp_failed", detail: String(e) });
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
    messages: [{
      role: "user",
      content: `For someone in or near ${place}, give a brief spoken briefing covering: ${asks}. ` +
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
    res.status(502).json({ error: String(e) });
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
    const r = await callClaude({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: "You are Vision, logging Shaun's expenses. Read receipts precisely.",
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
  const { action, text, query } = req.body || {};
  try {
    if (action === "save") {
      if (!text) return res.status(400).json({ error: "text required" });
      _notes.push({ text, at: Date.now() });
      return res.json({ ok: true, saved: text });
    }
    if (action === "search") {
      if (!_notes.length) return res.json({ answer: "I don't have any notes saved yet, Shaun." });
      const list = _notes.slice(-50).map((n, i) => `${i + 1}. ${n.text}`).join("\n");
      const r = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 160,
        system: "You are Vision recalling Shaun's own saved notes. Answer only from them, warmly and briefly.",
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
  if ((req.query.tok || "") !== APP_TOKEN) return res.status(401).send("unauthorized — add ?tok=your token");
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
  if ((req.query.tok || "") !== APP_TOKEN) return res.status(401).send("unauthorized — add ?tok=your token");
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
  if ((req.query.tok || "") !== APP_TOKEN) return res.status(401).send("unauthorized — add ?tok=your token");
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
    const r = await fetch(u, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (VisionReader)" } });
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || u.hostname;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&[a-z#\d]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 8000);
    if (text.length < 200) return res.status(422).json({ error: "page_unreadable", title });
    const body = {
      model: "claude-haiku-4-5-20251001", max_tokens: 400,
      system: "You are Vision, summarising a web page aloud for Shaun. JSON only: {\"spoken\": \"2-3 sentence summary of what actually matters\", \"points\": [\"up to 4 short key points\"]}. No markdown.",
      messages: [{ role: "user", content: `Page: ${title}\n\n${text}` }],
    };
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(502).json({ error: "summarise_failed" });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { p = { spoken: raw.slice(0, 300), points: [] }; }
    res.json({ title, spoken: p.spoken || "", points: Array.isArray(p.points) ? p.points.slice(0, 4) : [] });
  } catch (e) { res.status(502).json({ error: "fetch_failed" }); }
});

// --- 🔭 WATCHERS (batch 51): Vision's overnight eyes. Voice-created monitors
// parsed by Haiku into {type, args, threshold}; a scheduler runs them hourly;
// results wait in the store and surface in the opening brief. True unprompted
// push stays native-territory — this is checks-while-away, tells-on-open.
app.post("/watchers", requireAuth, async (req, res) => {
  const uid = uidOf(req); const { action, request, id } = req.body || {};
  const list = STORE.watchers[uid] = STORE.watchers[uid] || [];
  if (action === "list") return res.json({ watchers: list, results: (STORE.results[uid] || []).slice(-6) });
  if (action === "remove" && id) { STORE.watchers[uid] = list.filter(w => w.id !== id); saveStore(); return res.json({ ok: true, count: STORE.watchers[uid].length }); }
  if (action === "latest") {
    const seen = STORE.seen[uid] || 0;
    const fresh = (STORE.results[uid] || []).filter(r => r.at > seen && r.triggered);
    STORE.seen[uid] = Date.now(); saveStore();
    return res.json({ fresh });
  }
  if (action === "add" && request) {
    if (list.length >= 8) return res.status(400).json({ error: "watcher_limit", spoken: "You've got eight watchers already — remove one first." });
    const body = {
      model: "claude-haiku-4-5-20251001", max_tokens: 250,
      system: 'Parse a watch request into JSON only: {"type":"flightdeal|weather|events|currency","label":"short human label","args":{...},"threshold":null|number}. flightdeal args {from,to,when?} threshold=max price number if stated. weather args {place,days:5}. events args {area,when:"this weekend"|...}. currency args {from,to} threshold=rate number if stated. No markdown.',
      messages: [{ role: "user", content: String(request).slice(0, 300) }],
    };
    try {
      const { status, text } = await callClaude(body);
      if (status !== 200) return res.status(502).json({ error: "parse_failed" });
      const raw = (JSON.parse(text).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      const w = JSON.parse(raw.replace(/```json|```/g, "").trim());
      w.id = "w" + Date.now(); w.createdAt = Date.now();
      list.push(w); saveStore();
      // run it once right away so there's a result today, not tomorrow
      runWatcher(uid, w).catch(() => {});
      return res.json({ ok: true, watcher: w, spoken: `Watching: ${w.label}. I'll have news in your morning brief.` });
    } catch { return res.status(502).json({ error: "parse_failed" }); }
  }
  res.status(400).json({ error: "bad action" });
});

async function runWatcher(uid, w) {
  let spoken = "", triggered = false;
  try {
    if (w.type === "currency") {
      const r = await (await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(w.args.from || "AUD")}&to=${encodeURIComponent(w.args.to || "USD")}`)).json();
      const rate = Object.values(r.rates || {})[0];
      if (rate != null) {
        triggered = w.threshold ? rate >= w.threshold : true;
        spoken = `${w.args.from || "AUD"} is at ${rate} ${w.args.to || ""}${w.threshold ? (triggered ? ` — past your ${w.threshold} mark.` : ` (watching for ${w.threshold}).`) : "."}`;
      }
    } else if (w.type === "weather") {
      const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(w.args.place || "")}&count=1`)).json();
      const loc = (g.results || [])[0];
      if (loc) {
        const f = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&daily=temperature_2m_max,precipitation_probability_max&forecast_days=${Math.min(w.args.days || 5, 7)}`)).json();
        const d = f.daily || {};
        const days = (d.time || []).map((t, i) => `${t.slice(5)}: ${Math.round(d.temperature_2m_max[i])}°, ${d.precipitation_probability_max[i]}% rain`).join("; ");
        spoken = `${w.args.place} next days — ${days}.`; triggered = true;
      }
    } else {
      // flightdeal + events: live web search via the brain
      const q = w.type === "flightdeal"
        ? `Current cheapest one-way and return fares ${w.args.from || ""} to ${w.args.to || ""} ${w.args.when || ""}. Reply JSON only: {"price": <lowest typical AUD number>, "note": "one short sentence"}`
        : `Events on in ${w.args.area || ""} ${w.args.when || "this weekend"}. Reply JSON only: {"note": "one short spoken sentence naming the best 1-2, or say nothing found"}`;
      const body = { model: "claude-haiku-4-5-20251001", max_tokens: 300, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }], messages: [{ role: "user", content: q }] };
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
    const results = STORE.results[uid] = STORE.results[uid] || [];
    results.push({ at: Date.now(), id: w.id, label: w.label, spoken, triggered });
    while (results.length > 30) results.shift();
    saveStore();
  }
}
// Hourly sweep + first run a minute after boot.
setInterval(() => { for (const [uid, list] of Object.entries(STORE.watchers)) for (const w of list) runWatcher(uid, w).catch(() => {}); }, 3600000);
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

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`glasses proxy listening on :${PORT}`));
