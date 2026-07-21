'use strict';
/* sim-advisor.js — 200 stress prompts against the advisory layer.
 *
 * An advisor is easy to build and hard to make bearable. The failure mode is
 * not "it missed something" — it's "it says something every single time", at
 * which point he stops reading it and the one that mattered goes past.
 *
 * So this tests three things, and the middle one matters most:
 *
 *   1. DOES IT FIRE when a real collision exists
 *   2. IS IT SILENT when there's nothing worth saying   <- the hard one
 *   3. DOES IT NEVER ACT — no writes, no bookings, no sends
 *
 * The advisors are pure functions over STORE, so they can be driven with
 * fabricated state and checked exactly, without a live model.
 *
 * Run: node sim-advisor.js
 */

const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const app = fs.readFileSync('app.html', 'utf8');

/* --- stand up the advisor with a fake STORE ------------------------------ */
const STORE = { mem: {}, jobs: {}, spend: {}, bookings: {}, pending: {}, calToday: {}, profiles: {} };
const UID = 'sim';

function reset() {
  STORE.mem = { [UID]: [] };
  STORE.jobs = { [UID]: {} };
  STORE.spend = { [UID]: {} };
  STORE.bookings = { [UID]: [] };
  STORE.pending = { [UID]: [] };
  STORE.calToday = { [UID]: { jobs: [], events: [] } };
  STORE.profiles = { [UID]: {} };
}

const harness = `
const WORK_TZ = "Australia/Brisbane";
function profileOf(uid){ return STORE.profiles[uid] || {}; }
function recallFor(){ return []; }
function callClaude(){ return Promise.resolve({status:500,text:'{}'}); }
const SPOKEN_PLAIN = "";
const app = { post: () => {} };
function requireAuth(){}
function uidOf(){ return "${UID}"; }
`;

const advStart = server.indexOf('function tzGap(uid)');
const advEnd = server.indexOf('app.post("/advise"');
fs.writeFileSync('/tmp/_adv.js',
  'let STORE;\nmodule.exports.setStore = s => { STORE = s; };\n' + harness +
  server.slice(advStart, advEnd) +
  '\nmodule.exports.advise = advise;\nmodule.exports.adviceBrief = adviceBrief;\nmodule.exports.ADVISORS = ADVISORS;\n');
const ADV = require('/tmp/_adv.js');
ADV.setStore(STORE);

const HOUR = 3600000, DAY = 86400000;
const now = () => Date.now();

/* --- builders for the fabricated situations ------------------------------ */
function job(minsFromNow, title) {
  return { title: title || 'Geeks2U Job: 1295115 (Remote)', job: '1295115',
           startMs: now() + minsFromNow * 60000, endMs: now() + (minsFromNow + 60) * 60000,
           whenBoth: '4:30 pm AEST (1:30 pm your time)' };
}
function ev(minsFromNow, title, lengthMin) {
  return { title, startMs: now() + minsFromNow * 60000,
           endMs: now() + (minsFromNow + (lengthMin || 60)) * 60000 };
}

/* --- 200 cases ----------------------------------------------------------- */
const CASES = [];

// ---- 1. TIMEZONE COLLISION (should fire) — 15 -------------------------
for (let i = 0; i < 15; i++) {
  const mins = 30 + i * 12;
  CASES.push({
    group: 'timezone collision', expect: mins <= 240 ? 'timezone' : null,
    why: `job in ${mins} min while abroad`,
    setup: () => { STORE.profiles[UID] = { country: 'Vietnam' }; STORE.calToday[UID] = { jobs: [job(mins)], events: [job(mins)] }; },
  });
}

// ---- 2. TIMEZONE — must NOT fire at home — 10 -------------------------
for (let i = 0; i < 10; i++) {
  CASES.push({
    group: 'at home, no tz warning', expect: null,
    why: 'in Australia — there is no gap to warn about',
    setup: () => { STORE.profiles[UID] = { country: 'Australia' }; STORE.calToday[UID] = { jobs: [job(30 + i * 10)], events: [job(30 + i * 10)] }; },
  });
}

// ---- 3. TIGHT GAP (should fire) — 15 ----------------------------------
for (let i = 0; i < 15; i++) {
  const gap = i * 6; // 0..84 min
  CASES.push({
    group: 'tight gap between plans', expect: gap < 45 ? 'tight' : null,
    why: `${gap} min between two things`,
    setup: () => {
      STORE.profiles[UID] = { country: 'Vietnam' };
      STORE.calToday[UID] = { jobs: [], events: [ev(120, 'Museum', 60), ev(180 + gap, 'Dinner', 90)] };
    },
  });
}

// ---- 4. UNWRITTEN JOB (should fire) — 20 ------------------------------
for (let i = 0; i < 20; i++) {
  const daysAgo = i * 0.5;
  CASES.push({
    group: 'job with no report', expect: daysAgo < 7 ? 'job' : null,
    why: `job captured ${daysAgo} days ago, no report`,
    setup: () => {
      STORE.profiles[UID] = {};
      STORE.jobs[UID] = { '1295115': { job: '1295115', customer: 'Mr Grant Brecht', at: now() - daysAgo * DAY } };
    },
  });
}

// ---- 5. JOB ALREADY WRITTEN — must be silent — 15 ---------------------
for (let i = 0; i < 15; i++) {
  CASES.push({
    group: 'job already written up', expect: null,
    why: 'report exists — nothing to chase',
    setup: () => {
      STORE.jobs[UID] = { '1295115': { job: '1295115', at: now() - i * HOUR, report: '- Resolved issue\n- All issues resolved' } };
    },
  });
}

// ---- 6. SPEND PACE — 20 ----------------------------------------------
for (let i = 0; i < 20; i++) {
  const mult = 0.5 + i * 0.15; // 0.5x .. 3.35x
  CASES.push({
    group: 'spending pace', expect: mult >= 1.6 ? 'spend' : null,
    why: `today at ${mult.toFixed(1)}x the usual`,
    setup: () => {
      const led = {};
      for (let d = 1; d <= 5; d++) {
        const k = new Date(now() - d * DAY).toISOString().slice(0, 10);
        led[k] = { total: 100 };
      }
      led[new Date().toISOString().slice(0, 10)] = { total: 100 * mult };
      STORE.spend[UID] = led;
    },
  });
}

// ---- 7. SPEND with too little history — must be silent — 10 -----------
for (let i = 0; i < 10; i++) {
  CASES.push({
    group: 'not enough spend history', expect: null,
    why: 'fewer than 3 days logged — cannot judge a pace',
    setup: () => {
      const led = {};
      for (let d = 0; d < Math.min(i, 2); d++) {
        led[new Date(now() - d * DAY).toISOString().slice(0, 10)] = { total: 500 };
      }
      STORE.spend[UID] = led;
    },
  });
}

// ---- 8. WEATHER vs OUTDOOR PLAN — 15 ---------------------------------
const OUTDOOR = ['Halong Bay cruise', 'Beach day', 'Old Quarter walk', 'Sapa trek', 'Night market', 'Boat tour', 'Island hop'];
const INDOOR = ['Museum', 'Job 1295115', 'Dentist', 'Cooking class indoors', 'Cinema', 'Massage', 'Coffee'];
for (let i = 0; i < 15; i++) {
  const outdoor = i < 8;
  const title = outdoor ? OUTDOOR[i % OUTDOOR.length] : INDOOR[i % INDOOR.length];
  CASES.push({
    group: 'weather against an outdoor plan', expect: outdoor ? 'weather' : null,
    why: `${title} in 3 hours`,
    setup: () => { STORE.calToday[UID] = { jobs: [], events: [ev(180, title)] }; },
  });
}

// ---- 9. NEW COUNTRY UNBRIEFED — 15 -----------------------------------
for (let i = 0; i < 15; i++) {
  const hoursSince = 2 + i * 5; // 2..72
  CASES.push({
    group: 'newly arrived, unbriefed', expect: (hoursSince >= 1 && hoursSince <= 48) ? 'arrival' : null,
    why: `landed ${hoursSince}h ago, hasn't asked about norms`,
    setup: () => {
      STORE.profiles[UID] = { country: 'Vietnam' };
      STORE.mem[UID] = [{ t: 'arrived in Hanoi, Vietnam (currency VND)', at: now() - hoursSince * HOUR }];
    },
  });
}

// ---- 10. ALREADY BRIEFED — must be silent — 10 ------------------------
for (let i = 0; i < 10; i++) {
  CASES.push({
    group: 'already asked about local norms', expect: null,
    why: 'he has already asked — do not repeat it',
    setup: () => {
      STORE.profiles[UID] = { country: 'Vietnam' };
      STORE.mem[UID] = [
        { t: 'arrived in Hanoi, Vietnam', at: now() - 10 * HOUR },
        { t: 'asked about tipping and the taxi scam here', at: now() - 9 * HOUR },
      ];
    },
  });
}

// ---- 11. BOOKING COMING UP — 15 --------------------------------------
for (let i = 0; i < 15; i++) {
  // Deliberately skirting the 36h boundary rather than landing on it. An ISO
  // built at now()+36h reads a couple of ms under 36h by the time it's
  // compared, so testing exactly on the line asserts a coin flip. Either side
  // of it is what actually matters.
  const hours = i * 4 + (i * 4 === 36 ? 1 : 0); // 0..56, never exactly 36
  CASES.push({
    group: 'booking approaching', expect: (hours > 0 && hours < 36) ? 'booking' : null,
    why: `booking in ${hours}h`,
    setup: () => {
      STORE.bookings[UID] = [{ type: 'hotel', what: 'Hanoi La Siesta', ref: 'ABC123',
                               whenISO: new Date(now() + hours * HOUR).toISOString() }];
    },
  });
}

// ---- 12. STALLED FLOW — 15 -------------------------------------------
for (let i = 0; i < 15; i++) {
  const hoursOld = i;
  CASES.push({
    group: 'unfinished flow', expect: hoursOld > 3 ? 'pending' : null,
    why: `flow open ${hoursOld}h`,
    setup: () => {
      // 'waiting' is the state the app actually writes. The first version of
      // this test asserted 'open', which only existed in the advisor's own bug.
      STORE.pending[UID] = [{ kind: 'booking', what: 'the Sapa train', state: 'waiting', at: now() - hoursOld * HOUR }];
    },
  });
}

// ---- 13. COMPLETELY EMPTY — must be silent — 20 -----------------------
for (let i = 0; i < 20; i++) {
  CASES.push({
    group: 'nothing going on', expect: null,
    why: 'a quiet day with nothing pending — silence is correct',
    setup: () => { /* reset() already leaves it empty */ },
  });
}

// ---- 14. NOISE FLOOR: many signals at once — 5 ------------------------
for (let i = 0; i < 5; i++) {
  CASES.push({
    group: 'everything at once — must still cap at 2', expect: 'MAX2',
    why: 'five problems in play; more than two is noise',
    setup: () => {
      STORE.profiles[UID] = { country: 'Vietnam' };
      STORE.calToday[UID] = { jobs: [job(45)], events: [job(45), ev(200, 'Beach day'), ev(260, 'Dinner')] };
      STORE.jobs[UID] = { '1290128': { job: '1290128', at: now() - 2 * DAY } };
      STORE.bookings[UID] = [{ type: 'hotel', what: 'x', whenISO: new Date(now() + 10 * HOUR).toISOString() }];
      STORE.pending[UID] = [{ kind: 'booking', what: 'y', state: 'waiting', at: now() - 8 * HOUR }];
      const led = {};
      for (let d = 1; d <= 5; d++) led[new Date(now() - d * DAY).toISOString().slice(0, 10)] = { total: 100 };
      led[new Date().toISOString().slice(0, 10)] = { total: 400 };
      STORE.spend[UID] = led;
    },
  });
}

/* --- run ---------------------------------------------------------------- */
let pass = 0, fail = 0;
const failures = [];
const byGroup = {};

for (const c of CASES) {
  reset();
  c.setup();
  let notes = [];
  try { notes = ADV.advise(UID, { max: 2 }); }
  catch (e) { notes = [{ kind: 'THREW:' + e.message, weight: 0 }]; }

  const kinds = notes.map(n => n.kind);
  let ok;
  if (c.expect === 'MAX2') ok = notes.length <= 2 && notes.length > 0;
  else if (c.expect === null) ok = notes.length === 0;
  else ok = kinds.includes(c.expect);

  byGroup[c.group] = byGroup[c.group] || { pass: 0, fail: 0 };
  if (ok) { pass++; byGroup[c.group].pass++; }
  else {
    fail++; byGroup[c.group].fail++;
    failures.push(`${c.group}: ${c.why} — expected ${c.expect || 'silence'}, got ${kinds.join(',') || 'silence'}`);
  }
}

/* --- the rule that matters most: it must never act ---------------------- */
const purity = [];
const advBlock = server.slice(advStart, server.indexOf('app.post("/alternative"'));
const advisorsOnly = server.slice(server.indexOf('const ADVISORS = ['), server.indexOf('const ALTERNATIVE_PROMPT'));

purity.push(['advisors never write to the store', !/mem\.push\(|STORE\.\w+\[uid\]\s*=/.test(advisorsOnly)]);
purity.push(['advisors never call saveStore', !/saveStore\(/.test(advisorsOnly)]);
purity.push(['advisors never call the model', !/callClaude\(/.test(advisorsOnly)]);
purity.push(['advisors never send anything', !/sms|mail\/send|wa\.me|window\.location/.test(advisorsOnly)]);
purity.push(['/advise is read-only', !/mem\.push\(|saveStore\(/.test(server.slice(server.indexOf('app.post("/advise"'), server.indexOf('app.post("/alternative"')))]);
purity.push(['the cap is enforced in code', /slice\(0,\s*max\)/.test(advBlock)]);
purity.push(['a broken advisor cannot silence the rest', /catch \(e\) \{ \/\* one bad advisor/.test(advBlock)]);
purity.push(['the brief tells the model to raise at most one', /say at most ONE/.test(advBlock)]);
purity.push(['alternatives are offered, never taken', /never a recommendation|ONE alternative, never more/i.test(server)]);
purity.push(['the app never auto-runs an advisor action', !/askAdvice\(\)[^;]*;\s*await\s+\w+\(/.test(app)]);

/* --- alternatives: does it name the thing he didn't ask about? -----------
 * This half needs a live model, so what can be checked offline is the CONTRACT:
 * that the prompt is built to offer exactly one option with its trade-off, that
 * it is allowed to say "your way is right", and that nothing here books
 * anything. Those are the properties that make it bearable.
 */
const altPrompt = server.slice(server.indexOf('const ALTERNATIVE_PROMPT'), server.indexOf('async function suggestAlternative'));
const altFn = server.slice(server.indexOf('async function suggestAlternative'), server.indexOf('/* --- assembly'));
const alt = [
  ['offers exactly ONE alternative', /ONE alternative, never more/i.test(altPrompt)],
  ['states the trade-off, not just the upside', /what it costs him as well as what it gains/i.test(altPrompt)],
  ['allowed to say the obvious choice is right', /genuinely the right one, say so/i.test(altPrompt)],
  ['refuses to invent prices or schedules', /Never invent a price, a schedule/i.test(altPrompt)],
  ['names the option he did NOT ask about', /did NOT ask about/i.test(altPrompt)],
  ['spoken, so no markdown', /SPOKEN_PLAIN/.test(altPrompt)],
  ['knows how he travels before suggesting', /recallFor\(/.test(altFn)],
  ['stays silent when worth_saying is false', /worth_saying === false/.test(altFn)],
  ['a model failure returns nothing, not a guess', /if \(status !== 200\) return null/.test(altFn)],
  ['never books, sends or writes', !/mem\.push|saveStore|sms|wa\.me/.test(altFn)],
];
console.log('');
console.log('  ALTERNATIVES — "what haven\'t I thought of?"');
console.log('  ' + '-'.repeat(70));
let altFail = 0;
for (const [label, ok] of alt) {
  if (!ok) altFail++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}
pass += alt.length - altFail; fail += altFail;

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ADVISORY LAYER — 200 STRESS PROMPTS');
console.log('  ' + '='.repeat(70));
console.log('');
console.log('  BY SITUATION');
console.log('  ' + '-'.repeat(70));
for (const [g, r] of Object.entries(byGroup)) {
  const total = r.pass + r.fail;
  console.log(`  ${r.fail ? '✗' : '✓'} ${g.padEnd(42)} ${r.pass}/${total}`);
}

console.log('');
console.log('  IT MUST NEVER ACT');
console.log('  ' + '-'.repeat(70));
let pureFail = 0;
for (const [label, ok] of purity) {
  if (!ok) pureFail++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

console.log('');
console.log('  ' + '='.repeat(70));
if (failures.length) {
  console.log('  FAILURES');
  for (const f of failures.slice(0, 12)) console.log('    ✗ ' + f);
  if (failures.length > 12) console.log(`    …and ${failures.length - 12} more`);
  console.log('');
}
const silent = CASES.filter(c => c.expect === null).length;
console.log(`  ${pass}/${CASES.length + 10} checks passed (200 prompts + 10 alternative contracts)`);
console.log(`  ${silent} of those required SILENCE — the hard half`);
console.log(`  ${purity.length - pureFail}/${purity.length} never-acts rules hold`);
console.log('');
process.exit(fail || pureFail ? 1 : 0);
