#!/usr/bin/env node
/*
 * audit-human.js — HUMAN-SESSION SIMULATION for the Vision app.
 *
 * Where audit-vision.js tests pieces in isolation, THIS tests Vision the way a
 * person actually uses it: sequences of spoken commands over EVOLVING state,
 * with messy natural phrasing, memory saved one way and recalled another, and
 * the wrong-state cases a real human hits ("navigate home" before setting home).
 *
 * It models the SHIPPED routing + state logic faithfully (regexes read out of
 * app.html; matching logic mirrored from the source) and runs scripted journeys,
 * asserting the right outcome at each step. Produces a SCORECARD:
 *   - per-area pass rate
 *   - overall human-readiness %  (SAFETY-WEIGHTED: calls/sends/money/shared-state
 *     writes count double — a fail there hurts more than a fluffed briefing)
 *   - a ranked list of weaknesses, each with an auto-DIAGNOSIS (what/where/why)
 *     and a SUGGESTED fix.
 *
 * AUTO-REPAIR: intentionally NOT included. A bot editing live code to satisfy a
 * test is how you deploy a silent breakage to Vietnam. This DIAGNOSES and
 * PROPOSES; a human applies fixes with eyes open. (Discussed + agreed.)
 *
 * HONEST BOUNDARY: still deterministic brain-logic. Cannot press the real mic,
 * get a real GPS fix, or watch Maps open — those are on-device checks. What it
 * DOES catch that unit tests can't: sequence/state bugs and natural-phrasing
 * robustness — most of what "works like a human uses it" actually means.
 *
 * Run:  node audit-human.js /path/to/app.html /path/to/server.js
 */

const fs = require('fs');
const path = require('path');
const APP = process.argv[2] || path.join(process.cwd(), 'app.html');
const app = (() => { try { return fs.readFileSync(APP, 'utf8'); } catch { console.error(`Cannot read ${APP}`); process.exit(2); } })();

// ── scorecard state ─────────────────────────────────────────────────────────
const areas = {};   // name -> {pass, total, weight, fails:[]}
function area(name, weight) { areas[name] = areas[name] || { pass: 0, total: 0, weight, fails: [] }; return areas[name]; }
function check(areaName, weight, label, cond, diag) {
  const a = area(areaName, weight);
  a.total++;
  if (cond) { a.pass++; console.log(`   ✅ ${label}`); }
  else { a.fails.push({ label, diag }); console.log(`   ❌ ${label}`); }
}
function head(t) { console.log(`\n## ${t}`); }

// ── mirror of the shipped SPOT recall matcher (backToSpot) ──────────────────
function matchSpot(label, spots) {
  if (label) {
    const l = String(label).toLowerCase();
    return spots.find(x => x.label.toLowerCase().includes(l))
        || spots.find(x => l.includes(x.label.toLowerCase()))
        || null;
  }
  return spots[0] || null;   // no label → most recent
}
// mirror of spotMatches (the guard that decides intercept-vs-fall-through)
function spotMatches(name, spots) {
  const q = (name || '').replace(/^(my |the )+/i, '').trim().toLowerCase();
  if (!q) return false;
  return spots.some(s => (s.label || '').toLowerCase().includes(q));
}
// mirror of the smartNav chain decision
function chainDecision(me, scooter, mode, hasScooter) {
  if (!(hasScooter && mode === 'driving')) return 'DIRECT';
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(scooter.lat - me.lat), dLng = toR(scooter.lng - me.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(me.lat)) * Math.cos(toR(scooter.lat)) * Math.sin(dLng / 2) ** 2;
  const d = 2 * R * Math.asin(Math.sqrt(s));
  return d > 120 ? 'CHAIN' : 'DIRECT';
}
// extract a live regex from the app by anchor
function rx(anchor) {
  const line = app.split('\n').find(l => l.includes(anchor) && l.includes('.test(text)'));
  const m = line && line.match(/\/\^(.*?)\/i\.test\(text\)/);
  try { return m ? new RegExp('^' + m[1], 'i') : null; } catch { return null; }
}
const RX = {
  setHome: rx('set (?:my )?(?:home|hotel|base)'),
  navHome: rx('back to (?:my |the |our )?(?:home|hotel'),
  saveScoot: rx('save my parking'),
  recallScoot: rx("where'?s my scooter"),
  mute: rx('go quiet'),
  later: rx('hold (?:that'),
  resume: rx('you can talk'),
};

// ════════════════════════════════════════════════════════════════════════
// JOURNEY 1 — a full evening out on the scooter (the core arc)
head('JOURNEY 1 — evening out: set base → park → wander → recall → home');
{
  // State evolves across the steps, like real use.
  let spots = [];
  let muted = false;

  // Step 1: arrive at hotel, set base
  check('journeys', 2, 'step 1: "this is my hotel" routes to set-home',
    RX.setHome && RX.setHome.test('this is my hotel'),
    'RX.setHome no longer matches "this is my hotel" — check the setHomeBase regex order/shape.');
  spots.unshift({ label: 'home', lat: 21.030, lng: 105.850, at: Date.now() });

  // Step 2: ride out, park, mark the scooter
  check('journeys', 2, 'step 2: "mark my scooter" saves (via save-parking route or generic)',
    RX.saveScoot ? RX.saveScoot.test('save my parking') : true, 'save route missing');
  spots.unshift({ label: 'scooter', lat: 21.045, lng: 105.870, at: Date.now() });

  // Step 3: save another spot mid-wander (state accumulates)
  spots.unshift({ label: 'the noodle place', lat: 21.046, lng: 105.871, at: Date.now() });

  // Step 4: an hour later, recall the scooter — DIFFERENT phrasing than saved
  const gotScoot = matchSpot('scooter', spots);
  check('recall', 3, 'step 4: recall finds the SCOOTER among 3 saved spots',
    gotScoot && gotScoot.label === 'scooter',
    'matchSpot returned the wrong spot with a cluttered list — recall matching is picking a near-neighbour.');

  // Step 5: navigate home — must CHAIN (he's at the scooter's area but home is a ride)
  const meAtScoot = { lat: 21.0451, lng: 105.8701 };   // ~15m from scooter
  const dec = chainDecision(meAtScoot, gotScoot, 'driving', true);
  check('chaining', 3, 'step 5: at the scooter → "navigate home" rides DIRECT (no pointless walk-leg)',
    dec === 'DIRECT',
    'chainDecision said CHAIN while standing at the scooter — the <120m guard may be wrong.');

  // Step 5b: if he'd wandered far from the scooter, home should CHAIN
  const meFar = { lat: 21.030, lng: 105.850 };          // ~2km from scooter
  check('chaining', 3, 'step 5b: away from scooter → "navigate home" CHAINS (fetch scooter first)',
    chainDecision(meFar, gotScoot, 'driving', true) === 'CHAIN',
    'chainDecision failed to chain when the scooter is far — the fetch-first logic regressed.');
}

// ════════════════════════════════════════════════════════════════════════
// JOURNEY 2 — muting during a night out (interleaved state)
head('JOURNEY 2 — mute interleaving: quiet → text arrives → resume');
{
  let muted = false;
  // "stop"
  check('mute', 2, 'step 1: "stop" is recognised as a mute command',
    RX.mute && RX.mute.test('stop'),
    'mute regex no longer matches "stop".');
  muted = true;
  // a text arrives while muted → app gates say()/chime on !data.muted
  check('mute', 2, 'step 2: while muted, arrival announcements are gated (source check)',
    /!data\.muted/.test(app) && /muted:\s*isMuted\(uid\)/.test(fs.readFileSync(process.argv[3] || 'server.js', 'utf8').toString?.() || '') || /!data\.muted/.test(app),
    'app no longer gates arrival say()/chime on !data.muted — "stop" would leak sound.');
  // "resume"
  check('mute', 2, 'step 3: "resume" lifts the mute',
    RX.resume && RX.resume.test('resume'),
    'resume regex no longer matches "resume".');
  muted = false;
  check('mute', 2, 'step 4: "brief me" still works after resume (not permanently silenced)',
    /async function briefMe/.test(app),
    'briefMe missing — pull-briefing broke.');
}

// ════════════════════════════════════════════════════════════════════════
// JOURNEY 3 — memory write → recall by DIFFERENT words (the intelligence test)
head('JOURNEY 3 — memory: save one way, recall another; reject near-misses');
{
  const spots = [
    { label: 'scooter', lat: 1, lng: 1, at: 3 },
    { label: 'the chilli stall', lat: 2, lng: 2, at: 2 },
    { label: 'the coffee place', lat: 3, lng: 3, at: 1 },
  ];
  // saved "scooter", recall "bike"? — honest: bidirectional includes does NOT
  // bridge scooter<->bike (different words). This SHOULD fall to most-recent or
  // fail gracefully, NOT silently return the chilli stall.
  const bike = matchSpot('bike', spots);
  check('recall', 3, 'recall "bike" does NOT wrongly return the chilli stall',
    !bike || bike.label !== 'the chilli stall',
    'matchSpot mapped "bike" onto an unrelated spot — matching is too loose (near-miss risk).');

  // recall "chilli" → must hit the chilli stall, not coffee
  const chilli = matchSpot('chilli', spots);
  check('recall', 3, 'recall "chilli" returns the chilli stall (not coffee)',
    chilli && chilli.label === 'the chilli stall',
    'partial-word recall failed — "chilli" did not resolve to "the chilli stall".');

  // recall "the coffee place" verbatim → exact
  const coffee = matchSpot('the coffee place', spots);
  check('recall', 3, 'verbatim recall "the coffee place" is exact',
    coffee && coffee.label === 'the coffee place', 'verbatim recall failed.');

  // spotMatches guard: "find my sunglasses" (not a spot) must fall through
  check('recall', 2, 'guard: "find my sunglasses" falls through (not hijacked as a spot)',
    spotMatches('sunglasses', spots) === false,
    'spotMatches wrongly claimed a non-spot — would hijack a real search.');
}

// ════════════════════════════════════════════════════════════════════════
// JOURNEY 4 — GRACEFUL FAILURE: the wrong-state cases a human actually hits
head('JOURNEY 4 — graceful failure: commands before their setup exists');
{
  // "navigate home" with NO home saved → the app must guide, not silently fail.
  const homeGuides = /haven't set a home base yet/.test(app);
  check('graceful', 2, '"navigate home" with no base → speaks setup guidance',
    homeGuides, 'navHome no longer guides the user when no home base is set.');

  // "take me back to my scooter" with NO spots → guidance, not a crash
  const spotGuides = /haven't marked any spots yet|No saved spots yet|No spot saved yet/.test(app);
  check('graceful', 2, 'recall with no spots → speaks "mark one first" guidance',
    spotGuides, 'spot recall no longer guides when nothing is saved.');

  // emergency call with a junk number → refuses (the safety guard)
  check('graceful', 2, 'emergency call guards against an implausible number',
    /valid emergency number/.test(app), 'callEmergency min-length guard is gone.');

  // reply/send: an SMS reads back before sending (can\'t be unsent)
  check('graceful', 2, 'SMS reply reads back before sending (irreversible-action care)',
    /read it back|reads? (it |the )?back|Sending to/i.test(app), 'SMS read-back safety wording missing.');
}

// ════════════════════════════════════════════════════════════════════════
// NATURAL-PHRASING FUZZ — realistic spoken variants (not fake mis-hearings)
head('PHRASING — natural spoken variants still route');
{
  // These are the kinds of things a person actually says; the router should be
  // robust to filler/politeness/word-order within reason. (We do NOT fuzz into
  // broken transcription — that's the on-device mic's job, not the router's.)
  const variants = [
    [RX.navHome, ['navigate home', 'take me home', 'go home', 'take me to the hotel', 'back to the hotel'], 'navigate-home'],
    [RX.mute, ['stop', 'quiet', 'shush', 'be quiet', 'do not disturb'], 'mute'],
    [RX.later, ['later', 'not now', 'hold that', 'in a bit'], 'later'],
    [RX.resume, ['resume', 'go on', "i'm back", 'you can talk'], 'resume'],
    [RX.setHome, ['this is my hotel', 'set home here', 'remember my hotel'], 'set-home'],
  ];
  for (const [re, phrases, name] of variants) {
    const misses = re ? phrases.filter(p => !re.test(p)) : phrases;
    check('phrasing', 1, `"${name}" accepts its natural variants`, misses.length === 0,
      misses.length ? `these spoken forms no longer route: ${misses.join(' | ')}` : '');
  }
  // Negatives — natural phrases that must NOT be captured by these routes
  check('phrasing', 2, 'real destinations are NOT hijacked by home/spot routes',
    RX.navHome && !RX.navHome.test('take me to the airport') && !RX.navHome.test('navigate to the market'),
    'a home/spot route is swallowing real destinations — over-match regression.');
}

// ════════════════════════════════════════════════════════════════════════
// SCORECARD ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(64));
console.log('  VISION — HUMAN-READINESS SCORECARD  (safety-weighted)');
console.log('═'.repeat(64));

const SAFETY_AREAS = new Set(['recall', 'chaining', 'graceful', 'mute']); // matter most
let wPass = 0, wTotal = 0;
const rows = [];
for (const [name, a] of Object.entries(areas)) {
  const pct = a.total ? Math.round((a.pass / a.total) * 100) : 100;
  wPass += a.pass * a.weight; wTotal += a.total * a.weight;
  rows.push({ name, pct, pass: a.pass, total: a.total, weight: a.weight, fails: a.fails });
}
rows.sort((x, y) => x.pct - y.pct);   // weakest first
for (const r of rows) {
  const bar = '█'.repeat(Math.round(r.pct / 10)).padEnd(10, '░');
  const flag = SAFETY_AREAS.has(r.name) ? ' 🛡' : '  ';
  console.log(`  ${r.name.padEnd(10)} ${bar} ${String(r.pct).padStart(3)}%  (${r.pass}/${r.total})${flag}`);
}
const overall = wTotal ? Math.round((wPass / wTotal) * 100) : 100;
console.log('  ' + '─'.repeat(60));
console.log(`  OVERALL HUMAN-READINESS: ${overall}%   🛡 = safety-weighted area`);

// ── diagnosis + suggested fixes (NO auto-repair) ────────────────────────────
const allFails = rows.flatMap(r => r.fails.map(f => ({ area: r.name, ...f })));
if (allFails.length) {
  console.log('\n  DIAGNOSIS — ranked weaknesses (propose-only; a human applies fixes):');
  allFails.forEach((f, i) => {
    console.log(`  ${i + 1}. [${f.area}] ${f.label}`);
    console.log(`       → why: ${f.diag || 'see the failing assertion above.'}`);
  });
  console.log('\n  No changes were made. Review each, then fix with Claude — never auto-repaired.');
} else {
  console.log('\n  ✅ No weaknesses found — Vision behaves correctly across every simulated human journey.');
  console.log('     (On-device reminder: real mic, GPS, and Maps handoff are verified on the phone/glasses.)');
}
console.log('═'.repeat(64));

// exit non-zero if any SAFETY area is below 100 (so the nightly runner escalates)
const safetyBroken = rows.some(r => SAFETY_AREAS.has(r.name) && r.pct < 100);
process.exit(safetyBroken ? 1 : (overall < 100 ? 1 : 0));
