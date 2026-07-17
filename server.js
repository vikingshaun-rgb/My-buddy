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
function requireAuth(req, res, next) {
  const auth = req.get("authorization") || "";
  if (auth !== `Bearer ${APP_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Forward a non-streaming request to Claude and return the raw JSON.
async function callClaude(body) {
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
  return { status: r.status, text };
}

// --- Vision: image + prompt in, one short line out (matches ClaudeVisionClient) ---
// --- Vision: Buddy looks at a photo and answers, purpose-aware ---
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

    const system = "You are Buddy, Shaun's warm AI companion in his glasses. You're looking through his camera. Keep answers SHORT, warm, and spoken-friendly — no markdown, no lists, no preamble.";

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
    system: "You are Buddy, a warm translation helper for Shaun. Be accurate and natural, not literal-clunky.",
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
    system: "You are Buddy, a savvy travel companion who protects Shaun from being overcharged. You know rough local price norms for common tourist goods/services (taxis, tuk-tuks, street food, markets, SIM cards, souvenirs) across SE Asia and worldwide. Be honest and practical, never alarmist.",
    messages: [{
      role: "user",
      content:
        `Shaun is being asked to pay ${price} ${cur} for "${item}"${where}. ` +
        `Reply as compact JSON ONLY (no markdown) with keys: ` +
        `"verdict" (one of: "fair", "high", "rip-off", "unsure"), ` +
        `"spoken" (one short friendly spoken sentence Buddy would say — e.g. what a fair price is, or "that's steep, offer X"), ` +
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
  const sys = "You are Buddy, Shaun's dietary safety guard while travelling. You know common hidden sources of allergens/restricted ingredients in local cuisines (e.g. fish sauce, shrimp paste, peanuts in SE Asian food). Be careful and clear. When unsure, say so and advise asking/confirming with the vendor in the local language. NEVER give false reassurance.";
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
    // Buddy speaks the first move warmly.
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
  // First get the real conversion (factual), then let Buddy judge value.
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
    system: "You are Buddy, Shaun's savvy money companion abroad. You judge whether a price is good value for the country, in plain friendly terms. You know rough local costs across SE Asia and worldwide.",
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
    system: "You are Buddy, Shaun's travel companion who PLANS his day, not just answers. Build a realistic, well-paced itinerary for the place and budget, with actual place types, rough times, and rough costs. Be specific and local, mindful of opening hours and travel time. Keep it doable, not a rushed checklist.",
    messages: [{
      role: "user",
      content:
        `Plan Shaun's day. Goal: ${goal || "explore"}.` +
        `${city ? ` City: ${city}.` : ""}${budget ? ` Budget: ${budget} ${currency || ""}.` : ""}` +
        `${date ? ` Date: ${date}.` : ""}${profile ? ` About Shaun: ${profile}.` : ""}\n` +
        `Reply as compact JSON ONLY (no markdown) with keys: ` +
        `"title" (short day title), ` +
        `"spoken" (2-3 sentence friendly spoken overview Buddy would say), ` +
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
    system: "You are Buddy, powering a live two-way conversation translator for Shaun (a traveller). You auto-detect which language a line is in. If it's Shaun's language, translate INTO the other person's language; if it's the other person's language, translate INTO Shaun's. Keep it natural and colloquial, not literal. Also read the emotional tone.",
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
    system: "You are Buddy, Shaun's discreet cultural guide abroad. Give warm, practical etiquette advice for the country — what's polite, what to avoid, how to do it right. Short and spoken-friendly. Be specific to the local culture, not generic.",
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
    system: "You are Buddy, Shaun's knowledgeable, enthusiastic travel guide. When he looks at something, you tell him what it is and something genuinely interesting — like a great local guide would, briefly.",
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
    system: "You are Buddy, preparing Shaun an offline survival phrase pack for travel. Give the most useful emergency and everyday phrases in the local language with pronunciation and English.",
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
// --- Buddy's brain: persona + memory + smart model routing + live context ---
// Body: { message, history?: [{role, content}], location?: {city|lat,lng}, model? }
// Streams Buddy's reply back (SSE) so speech can start early.

// Buddy's personality — warm, friendly companion; short & punchy for glasses.
function buddyPersona(ctx) {
  return [
    "You are Buddy, a warm and friendly AI companion who lives in Shaun's smart glasses.",
    "You talk to Shaun like a helpful, upbeat mate — never robotic, never stiff.",
    "Keep replies SHORT and punchy: usually one or two sentences. You're spoken aloud through glasses, so brevity matters.",
    "Be genuinely useful first, friendly second. No filler, no 'as an AI', no long preambles.",
    "Address him as Shaun when it feels natural, not every line.",
    "If you're unsure, say so briefly and offer your best guess.",
    "When it's genuinely helpful, end with a short proactive offer — e.g. 'Want me to set a reminder?' or 'Shall I find one nearby?' — but only when it truly adds value. Never tack on a filler question.",
    ctx.time ? `The current time is ${ctx.time}.` : "",
    ctx.place ? `Shaun's rough location is ${ctx.place} — use it only if relevant.` : "",
    ctx.profile ? `What you remember about Shaun (use naturally when relevant, don't recite it): ${ctx.profile}` : "",
  ].filter(Boolean).join(" ");
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
  if (!rooms[k]) rooms[k] = { members: {}, pins: [], messages: [], frames: {} };
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
  res.json({ partners, pins: r.pins, messages: r.messages });
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
// Pre-built brain for the glasses flow: "Buddy, find me a steak sandwich" →
// options read aloud with price+rating+ETA → you confirm → deep-link into Grab to pay.
app.post("/findfood", requireAuth, async (req, res) => {
  const { craving, city, budget, currency } = req.body || {};
  if (!craving) return res.status(400).json({ error: "craving required" });
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    system: "You are Buddy, Shaun's food concierge abroad. Given what he's craving and where he is, suggest realistic nearby options a delivery app like Grab would have, with plausible price, rating, and delivery ETA. Be realistic for the city; don't invent famous names — describe the kind of place. Rank best-value first.",
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
// Uses the inbox Buddy already reads. TripIt-style, but hands-free + spoken.
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
      system: "You are Buddy, building Shaun a clean trip timeline from his booking-confirmation emails. Extract flights, hotels, trains, and reservations with dates/times/locations. Ignore marketing.",
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

// --- Router: classify a natural message → which Buddy skill + extracted args ---
// This is what makes the single chat box feel agentic: you just talk, Buddy
// figures out whether you want a price check, a day plan, a landmark, etc.
app.post("/route", requireAuth, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  const body = {
    model: "claude-haiku-4-5-20251001", // routing must be fast
    max_tokens: 300,
    system:
      "You are the intent router for Buddy, a travel companion. Given what Shaun says, decide which ONE skill best answers it, and extract the arguments. " +
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
      "\"music\" (play music/a song/artist/playlist/vibe; args: query), " +
      "\"findfood\" (find/order food, hungry, I want a <dish>, food delivery; args: craving), " +
      "\"navigate\" (directions/take me to/how do I get to/route to a place; args: destination), " +
      "\"itinerary\" (my trip/bookings/flights/what's next/my schedule; args: none), " +
      "\"status\" (my status/briefing/how am I doing/catch me up; args: none), " +
      "\"orderupdate\" (any update on my order/where's my food/my delivery; args: none), " +
      "\"call\" (call/phone/ring a number; args: number), " +
      "\"text\" (text/message/SMS a number; args: number, message). " +
      "Pick the single best skill. If it's just conversation or doesn't fit a skill, use \"chat\".",
    messages: [{
      role: "user",
      content:
        `Shaun said: "${message}"\n` +
        `Reply as compact JSON ONLY (no markdown): "skill" (one of the names above), ` +
        `"args" (object with only the fields you could extract), ` +
        `"confidence" (0-1).`,
    }],
  };
  try {
    const { status, text: out } = await callClaude(body);
    if (status !== 200) return res.status(200).json({ skill: "chat", args: {}, confidence: 0 });
    const raw = (JSON.parse(out).content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    let p; try { p = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { p = { skill: "chat", args: {}, confidence: 0 }; }
    res.json({ skill: p.skill || "chat", args: p.args || {}, confidence: p.confidence ?? 0 });
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
    };

    // Build the message list: prior history (trimmed) + this turn.
    const history = Array.isArray(b.history) ? b.history.slice(-8) : [];
    const messages = b.messages /* app may still send raw */ || [
      ...history,
      { role: "user", content: message },
    ];

    const model = pickModel(message || history.map(h=>h.content).join(" "), b.model);

    const upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: b.max_tokens || 400,
        system: buddyPersona(ctx),
        messages,
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
        reply: why ? `Buddy's brain said: ${why}` : "Sorry Shaun, my brain hiccuped — try me again?",
      });
    }
    let reply = "";
    try {
      const j = JSON.parse(raw);
      reply = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
      // If reply is empty, surface WHY (stop_reason / error / raw) so we can see it.
      if (!reply) {
        const why = j.error?.message || j.stop_reason || (raw ? raw.slice(0, 300) : "empty response");
        return res.status(200).json({ reply: `Buddy's brain said: ${why}` });
      }
    } catch (e) {
      return res.status(200).json({ reply: `Buddy's brain sent something odd: ${(raw||"").slice(0,300)}` });
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

    // Concierge voice: a warm one-line summary Buddy can speak before guiding.
    let spoken = "";
    try {
      const firstFew = steps.slice(0, 3).map(s => s.text).join(". ");
      const g = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system: "You are Buddy guiding Shaun through his glasses. One warm, natural spoken sentence — no lists.",
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
    }));

    // Concierge layer: let Buddy recommend, not just list. style: "pick" | "list" | "auto"
    const style = (req.body || {}).recommend || "auto";
    if (style === "none" || places.length === 0) {
      return res.json({ places, recommendation: places.length ? "" : "I couldn't find anything matching nearby, Shaun." });
    }
    // Rank client-side first (open now + rating), so Buddy reasons over the best few.
    const ranked = [...places].sort((a, b) =>
      (Number(b.openNow) - Number(a.openNow)) || ((b.rating || 0) - (a.rating || 0)));
    const top = ranked.slice(0, 5).map(p =>
      `${p.name}${p.rating ? ` (${p.rating}★)` : ""}${p.openNow === false ? " [closed now]" : p.openNow ? " [open]" : ""} — ${p.address}`
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
        system: "You are Buddy, Shaun's warm companion in his glasses. Recommend places like a helpful local friend — never a raw list dump.",
        messages: [{ role: "user", content: `${wants}\n\nNearby options:\n${top}` }],
      });
      let recommendation = "";
      if (rec.status === 200) {
        const j = JSON.parse(rec.text);
        recommendation = (j.content || []).filter(x => x.type === "text").map(x => x.text).join(" ").trim();
      }
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

  const url = new URL("https://api.aviationstack.com/v1/flights");
  url.searchParams.set("access_key", FLIGHT_KEY);
  url.searchParams.set("flight_iata", flightIata);

  try {
    const r = await fetch(url);
    const data = await r.json();
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
    // Buddy's plain spoken status line.
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
      const u = new URL("https://api.aviationstack.com/v1/flights");
      u.searchParams.set("access_key", FLIGHT_KEY); u.searchParams.set("limit", "1");
      const r = await fetch(u); return r.status === 200;
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
    // Buddy's warm spoken forecast + a practical tip.
    let spoken = "";
    try {
      const c = data.current || {}, d = data.daily || {};
      const facts = `Now: ${c.temperature_2m}°C (feels ${c.apparent_temperature}°), wind ${c.wind_speed_10m} km/h, precip ${c.precipitation}mm, code ${c.weather_code}. ` +
        `Today high ${d.temperature_2m_max?.[0]}° low ${d.temperature_2m_min?.[0]}°, rain chance ${d.precipitation_probability_max?.[0]}%.`;
      const g = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system: "You are Buddy in Shaun's glasses. Say the weather like a friend — one or two spoken sentences, plain temps, and ONE practical tip (jacket/umbrella/sunscreen/wind) when relevant. No numbers-soup, no markdown.",
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

// Buddy reads the unread senders/subjects and gives a warm spoken triage.
async function mailBriefing(messages) {
  if (!messages.length) return "Your inbox is clear, Shaun — nothing unread.";
  try {
    const list = messages.slice(0, 12)
      .map((m, i) => `${i + 1}. from ${m.from} — "${m.subject}"`).join("\n");
    const r = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 220,
      system: "You are Buddy, Shaun's warm companion in his glasses. Triage his unread email like a sharp assistant.",
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
// --- Receipt: Buddy reads a receipt photo → structured expense ---
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
      system: "You are Buddy, logging Shaun's expenses. Read receipts precisely.",
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

// --- Recall: Buddy remembers short notes and finds them again ---
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
        system: "You are Buddy recalling Shaun's own saved notes. Answer only from them, warmly and briefly.",
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
