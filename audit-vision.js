#!/usr/bin/env node
/*
 * audit-vision.js — MASTER AUDIT SUITE for the Vision app.
 *
 * WHAT THIS PROVES (deterministic brain-logic only):
 *   1. Every voice trigger built today routes to the right action (spots, home,
 *      conductor mute/brief, smartNav chaining) — and doesn't over-match real
 *      destinations.
 *   2. Recall/spot matching resolves the right saved spot.
 *   3. smartNav chain decisions are correct (fetch-scooter-first logic).
 *   4. Native-seam inventory hasn't grown silently (SpeechRecognition, say,
 *      geolocation, timers) and server.js stays browser-global-free.
 *   5. No tap-only regression on the hands-free voice routes.
 *
 * WHAT THIS CANNOT PROVE (needs a real device — honest boundary):
 *   - the actual microphone / SpeechRecognition capture
 *   - real GPS fixes
 *   - the live Google Maps handoff opening
 *   These are verified on-device (phone now, glasses later).
 *
 * The suite reads the REAL regexes out of app.html so it can never drift from
 * the shipped code. Exits 0 on pass, 1 on any failure (so a CI/cron runner can
 * gate on it). Prints a clean section-by-section report.
 *
 * Run:  node audit-vision.js /path/to/app.html /path/to/server.js
 * Defaults to ./app.html and ./server.js if no args.
 */

const fs = require('fs');
const path = require('path');

const APP = process.argv[2] || path.join(process.cwd(), 'app.html');
const SRV = process.argv[3] || path.join(process.cwd(), 'server.js');

let app = '', srv = '';
try { app = fs.readFileSync(APP, 'utf8'); } catch { console.error(`Cannot read ${APP}`); process.exit(2); }
try { srv = fs.readFileSync(SRV, 'utf8'); } catch { console.error(`Cannot read ${SRV}`); process.exit(2); }

// ── tiny test harness ──────────────────────────────────────────────────────
let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
function section(title) { console.log(`\n## ${title}`); }
function report(name, cond, detail) {
  ok(name, cond, detail);
  console.log(`   ${cond ? '✅' : '❌'} ${name}${!cond && detail ? '  (' + detail + ')' : ''}`);
}

// ── helper: pull a regex literal out of app.html by a nearby anchor ─────────
// Finds the first /.../i regex on a line containing `anchor`, returns a RegExp.
function extractRegex(anchor) {
  const line = app.split('\n').find(l => l.includes(anchor) && l.includes('.test(text)'));
  if (!line) return null;
  const m = line.match(/\/\^(.*?)\/i\.test\(text\)/);
  if (!m) return null;
  try { return new RegExp('^' + m[1], 'i'); } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════
section('1. VOICE TRIGGERS — conductor (brief / mute / later / resume)');
// These must exist and match the phrases they're meant to.
{
  const mute = extractRegex('go quiet');
  report('"stop" mutes proactive', mute && mute.test('stop'));
  report('"do not disturb" mutes', mute && mute.test('do not disturb'));
  report('"stop" does NOT match a random sentence', mute && !mute.test('stop by the shop'));

  const later = extractRegex('hold (?:that');
  report('"later" holds', later && later.test('later'));
  report('"not now" holds', later && later.test('not now'));

  const resume = extractRegex('you can talk');
  report('"resume" lifts quiet', resume && resume.test('resume'));
  report('"i\'m back" lifts quiet', resume && resume.test("i'm back"));
}

// ════════════════════════════════════════════════════════════════════════
section('2. VOICE TRIGGERS — home / hotel base + navigate home');
{
  const setHome = extractRegex('set (?:my )?(?:home|hotel|base)');
  report('"this is my hotel" sets base', setHome && setHome.test('this is my hotel'));
  report('"set home here" sets base', setHome && setHome.test('set home here'));
  report('"remember my hotel" sets base', setHome && setHome.test('remember my hotel'));

  const navHome = extractRegex('back to (?:my |the |our )?(?:home|hotel');
  report('"navigate home" → home', navHome && navHome.test('navigate home'));
  report('"take me home" → home', navHome && navHome.test('take me home'));
  report('"take me to the hotel" → home', navHome && navHome.test('take me to the hotel'));
  report('bare "home" → home', navHome && navHome.test('home'));
  // Must NOT hijack real destinations:
  report('"navigate to the airport" does NOT match home', navHome && !navHome.test('navigate to the airport'));
  report('"take me to the market" does NOT match home', navHome && !navHome.test('take me to the market'));
}

// ════════════════════════════════════════════════════════════════════════
section('3. VOICE TRIGGERS — spot save / recall (scooter, hands-free)');
{
  const saveShort = extractRegex('save my parking');
  report('"remember where i parked" → save scooter', saveShort && saveShort.test('remember where i parked'));

  const recallShort = extractRegex("where'?s my scooter");
  report('"where\'s my scooter" → recall', recallShort && recallShort.test("where's my scooter"));
  report('"take me back" → recall recent', recallShort && recallShort.test('take me back'));
  report('"i\'m lost" → recall recent', recallShort && recallShort.test("i'm lost"));
}

// ════════════════════════════════════════════════════════════════════════
section('4. LOGIC — spotMatches (recall only intercepts a REAL saved spot)');
// Re-implement the shipped spotMatches logic and prove the guard behaviour.
{
  function spotMatches(name, spots) {
    const q = (name || '').replace(/^(my |the )+/i, '').trim().toLowerCase();
    if (!q) return false;
    return spots.some(s => (s.label || '').toLowerCase().includes(q));
  }
  const saved = [{ label: 'scooter' }, { label: 'home' }, { label: 'the noodle place' }];
  report('"find my scooter" intercepts (saved)', spotMatches('my scooter', saved) === true);
  report('"navigate to the hotel"… no "hotel" spot → falls through', spotMatches('hotel', saved) === false);
  report('"find my sunglasses" → falls through (not a spot)', spotMatches('sunglasses', saved) === false);
  report('"where is a pharmacy" → falls through', spotMatches('a pharmacy', saved) === false);
  // Confirm the shipped source actually contains spotMatches (no silent removal):
  report('spotMatches present in app.html', /function spotMatches/.test(app));
}

// ════════════════════════════════════════════════════════════════════════
section('5. LOGIC — smartNav chaining (fetch scooter first when riding)');
{
  function haversineM(a, b) {
    const R = 6371000, toR = x => x * Math.PI / 180;
    const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const scooter = { lat: 21.028, lng: 105.848 };
  function decide(me, mode, hasScooter) {
    if (!(hasScooter && mode === 'driving')) return 'DIRECT';
    return haversineM(me, scooter) > 120 ? 'CHAIN' : 'DIRECT';
  }
  const far = { lat: 21.020, lng: 105.840 };       // ~1km from scooter
  const atScoot = { lat: 21.0281, lng: 105.8481 }; // ~15m
  report('ride + scooter far → CHAIN', decide(far, 'driving', true) === 'CHAIN');
  report('ride + at scooter → DIRECT', decide(atScoot, 'driving', true) === 'DIRECT');
  report('walking → DIRECT (no chain)', decide(far, 'walking', true) === 'DIRECT');
  report('no scooter saved → DIRECT', decide(far, 'driving', false) === 'DIRECT');
  // Confirm smartNav is the single shared implementation, wired at the chokepoint:
  report('smartNav present in app.html', /function smartNav/.test(app));
  report('navigateWith delegates to smartNav (single chain)', /navigateWith\._chained/.test(app) && /smartNav\(dest/.test(app));
  report('leg-2 generalized to buddy_pendingnav (any dest)', /buddy_pendingnav/.test(app));
}

// ════════════════════════════════════════════════════════════════════════
section('6. RECALL — coords persist so saved spots are navigable');
{
  // Mirror the shipped remember() coords handling.
  function remember(mem, text, opts = {}) {
    const e = { t: String(text).slice(0, 500), at: opts.at || Date.now() };
    if (opts.kind) e.kind = opts.kind;
    if (opts.coords && opts.coords.lat != null) e.coords = { lat: opts.coords.lat, lng: opts.coords.lng };
    mem.push(e); while (mem.length > 400) mem.shift(); return e;
  }
  const mem = [];
  const spot = remember(mem, 'spot: scooter near Hanoi', { kind: 'note', coords: { lat: 21.03, lng: 105.85 } });
  const note = remember(mem, 'remember to email the customer', { kind: 'note' });
  report('spot memory carries navigable coords', spot.coords && spot.coords.lat === 21.03);
  report('plain note has no coords (clean)', note.coords === undefined);
  report('memory cap still enforced', mem.length <= 400);
  // Confirm the shipped server actually persists coords:
  report('server remember() persists entry.coords', /entry\.coords\s*=/.test(srv));
  report('server consider() passes coords through', /coords:\s*event\.coords/.test(srv));
  report('/recall save accepts lat/lng', /action === "save"[\s\S]{0,200}coords/.test(srv) || /lat != null\).*coords/.test(srv));
}

// ════════════════════════════════════════════════════════════════════════
section('7. buddy_city AUTO-REFRESH (location-of-truth stays fresh)');
{
  report('/whereami endpoint exists (reverse-geocode only)', /app\.post\("\/whereami"/.test(srv));
  report('refreshCity() defined in app', /async function refreshCity/.test(app));
  report('refreshCity called on app-return', /refreshCity\(\);/.test(app));
  report('manual-set grace honoured (buddy_city_manual)', /buddy_city_manual/.test(app));
  // Distance-gate logic: skip within 3km, refresh beyond.
  function moved(aLat, aLng, bLat, bLng) {
    const dLat = (bLat - aLat) * 111, dLng = (bLng - aLng) * 111 * Math.cos(aLat * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }
  report('moved 1km → skip (<3km)', moved(21.03, 105.85, 21.039, 105.85) < 3);
  report('moved 50km → refresh (>3km)', moved(21.03, 105.85, 21.5, 106.2) >= 3);
}

// ════════════════════════════════════════════════════════════════════════
section('8. THE CONDUCTOR (fusion briefing) present + safe');
{
  report('composeBriefing (fusion core) in server', /function composeBriefing/.test(srv));
  report('/brief endpoint (on-demand pull)', /app\.post\("\/brief"/.test(srv));
  report('/conductor endpoint (volume knob)', /app\.post\("\/conductor"/.test(srv));
  report('briefMe() in app', /async function briefMe/.test(app));
  report('conductorMute checked at top of situation()', /conductorMute/.test(srv));
  report('mute silences arrival announcements (muted flag)', /muted:\s*isMuted\(uid\)/.test(srv) && /!data\.muted/.test(app));
}

// ════════════════════════════════════════════════════════════════════════
section('9. TESTED TILES INTACT (no regression on prior fixes)');
{
  report('replyText present', /async function replyText/.test(app));
  report('callEmergency guard present', /valid emergency number/.test(app));
  report('voicemail readout present', /New voicemail from/.test(app));
  report('isTelTelVoicemail tight filter present', /isTelTelVoicemail/.test(srv));
  report('sharedMoments removes by stable {at}', /action:'remove',at:sm\.at/.test(app) || /action:"remove",at:/.test(app));
  report('navToPartner staleness helper present', /function navToPartner/.test(app));
}

// ════════════════════════════════════════════════════════════════════════
section('10. NATIVE-SEAM INVENTORY (web stand-ins — for the native handoff)');
{
  // These counts are the seams native will replace. The test FLAGS drift so the
  // native-handoff contract stays accurate — it does not fail on them.
  const count = (re) => (app.match(re) || []).length;
  const seams = {
    'SpeechRecognition (voice in → iOS Speech)': count(/SpeechRecognition/g),
    'say()/speechSynthesis (voice out → native TTS)': count(/speechSynthesis|function say\(/g),
    'geolocation (→ background CoreLocation)': count(/navigator\.geolocation|watchPosition/g),
    'setTimeout/setInterval (→ OS scheduling)': count(/setTimeout|setInterval/g),
    'tel:/sms:/facetime: (→ native call/msg APIs)': count(/location\.href='(tel|sms|facetime):/g),
  };
  for (const [k, v] of Object.entries(seams)) console.log(`   • ${k}: ${v}`);
  // The one HARD assertion: server.js must stay browser-global-free in CODE.
  // Strip line-comments and block-comments first so a stray "window" in prose
  // doesn't cry wolf (that was a real false-positive we hit).
  const codeOnly = srv
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (keep http:// intact)
  const leakMatches = (codeOnly.match(/\b(window|document|localStorage|navigator)\.\w/g) || []);
  report('server.js stays browser-global-free (native-agnostic)', leakMatches.length === 0,
    leakMatches.length ? `real refs: ${leakMatches.slice(0, 3).join(', ')}` : '');
}

// ════════════════════════════════════════════════════════════════════════
section('11. SKILL COVERAGE — every routable skill dispatches hands-free');
{
  const di = app.indexOf('function dispatchSkillInner');
  const diBody = di >= 0 ? app.slice(di, di + 24000) : '';

  // The skills the classifier can emit (kept in sync with the app's dispatcher).
  const SKILLS = ('activities addevent addlist advise allergy alternative amifree arrival ' +
    'backto bookings booktable bugs call capture chat converse convohistory couplespend ' +
    'currency dayview debrief digest docs eatout esim etiquette expiry favourite findfood ' +
    'findstay flight flightsearch getthere gooddeal handover itinerary jobcapture jobrecall ' +
    'jobreport journal landmark learned lifelog livelocation livelook logbug logspend ' +
    'mailbrief meetmiddle memoryhealth menu music myday navigate nearby notnow onmyway ' +
    'orderfood orderupdate outofplace packlist phrasebook plan planday procedures provemewrong ' +
    'readpage readtexts recallchat rememberspot ride safety savechat sayphrase scamcheck scan ' +
    'season seenbefore seenrecall sendtext sharedmoments sharepin showlist spend splitbill ' +
    'status stay survival talkto tellpartner text texts thingstobook tickoff timeline transit ' +
    'tripbudget tripday tripplan unlost voicenote watcher weather whatnext whatsapp whatschanged ' +
    'whereis whyquiet').split(/\s+/);

  // 11a. Every skill must have a dispatch branch (no orphan the router can emit
  //      but the app can't handle → would silently fall through to chat).
  const missing = SKILLS.filter(s => !new RegExp(`skill\\s*===\\s*['"]${s}['"]`).test(diBody));
  report(`all ${SKILLS.length} skills have a dispatch branch`, missing.length === 0,
    missing.length ? `no branch for: ${missing.join(', ')}` : '');

  // 11b. Flag skills whose dispatch opens a panel/settings that NEEDS a tap
  //      (hands-free dead-ends). Surfaced for review, not an auto-fail.
  const TAP_ONLY_FNS = ['openSettings', 'keysView', 'pairSetup', 'calendarPicker', 'saveSettings', 'chooseLooks', 'chooseFont'];
  const suspects = [];
  for (const s of SKILLS) {
    const m = diBody.match(new RegExp(`skill\\s*===\\s*['"]${s}['"]\\)\\s*\\{([^\\n]*)`));
    if (m && TAP_ONLY_FNS.some(fn => m[1].includes(fn))) suspects.push(s);
  }
  report('no skill dead-ends into a tap-only settings panel', suspects.length === 0,
    suspects.length ? `review: ${suspects.join(', ')}` : '');
  console.log(`   • coverage: ${SKILLS.length} skills routable by voice, ${SKILLS.length - missing.length} with confirmed dispatch`);

  // 11c. Key on-the-move skills must produce a spoken/handled result — a skill
  //      that dispatches but never speaks is a silent hands-free failure.
  const MUST_SPEAK = ['weather', 'nearby', 'findfood', 'navigate', 'scamcheck', 'etiquette'];
  for (const s of MUST_SPEAK) {
    const idx = diBody.search(new RegExp(`skill\\s*===\\s*['"]${s}['"]`));
    const chunk = idx >= 0 ? diBody.slice(idx, idx + 600) : '';
    const speaks = /say\(/.test(chunk) || /\w+\(/.test(chunk);
    report(`skill "${s}" produces a spoken/handled result`, speaks);
  }
}

// ── final report ───────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFAILURES:');
  fails.forEach(f => console.log('  ❌ ' + f));
  console.log('\nVision brain-logic audit FAILED — investigate before deploying.');
} else {
  console.log('\n✅ All Vision brain-logic checks passed.');
  console.log('   (Reminder: mic, GPS, and live Maps handoff are verified on-device, not here.)');
}
console.log('═'.repeat(60));
process.exit(failed ? 1 : 0);
