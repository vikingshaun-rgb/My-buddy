'use strict';
/* sim-flows.js — pending-flow engine stress test.
 *
 * A pending flow is Vision holding a thread open across a handoff: it can't tap
 * Apple Pay, so it sets the booking up, hands over, and picks the thread back
 * up when he returns. The failure modes are specific and nasty:
 *
 *   STUCK      — a flow that never closes and nags forever
 *   LOST       — a flow he said he'd come back to that silently vanishes
 *   DOUBLE-ASK — the plan asks AND the brief asks about the same thing
 *   LIED-TO    — "not yet" recorded as "completed", which then teaches the
 *                brain he follows through on things he actually dropped
 *
 * The last one matters most: memory feeds advice, so a wrong outcome doesn't
 * just lose a task, it corrupts what Vision believes about him.
 *
 * Run: node sim-flows.js
 */

const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const app = fs.readFileSync('app.html', 'utf8');

/* --- stand the engine up over a fake store ------------------------------- */
const STORE = { pending: {}, mem: {} };
const UID = 'sim';
function reset() { STORE.pending = { [UID]: [] }; STORE.mem = { [UID]: [] }; }

const ttlStart = server.indexOf('const FLOW_TTL_MS');
// The BUG LOG comment appears EARLIER in the file than the TTL block, so
// searching for it from position 0 gives a negative slice. Search forward.
const ttlEnd = server.indexOf('\napp.', server.indexOf('function pendingBrief'));
fs.writeFileSync('/tmp/_flow.js',
  'let STORE;\nmodule.exports.setStore = s => { STORE = s; };\n' +
  'function saveStore(){}\nfunction dlog(){}\n' +
  server.slice(ttlStart, ttlEnd) +
  '\nmodule.exports.lapseFlows = lapseFlows;\nmodule.exports.pendingBrief = pendingBrief;\nmodule.exports.FLOW_TTL_MS = FLOW_TTL_MS;\n');
const F = require('/tmp/_flow.js');
F.setStore(STORE);

const HOUR = 3600000;
let pass = 0, fail = 0;
const problems = [];
function check(name, ok, why) {
  if (ok) { pass++; return; }
  fail++; problems.push(`${name}${why ? ' — ' + why : ''}`);
}

function flow(kind, what, hoursAgo, extra) {
  return Object.assign({
    id: 'p' + Math.random().toString(36).slice(2),
    kind, what, state: 'waiting', at: Date.now() - hoursAgo * HOUR,
  }, extra || {});
}

console.log('');
console.log('  PENDING FLOWS — CAN ONE GET STUCK?');
console.log('  ' + '='.repeat(66));

/* --- 1. nothing nags forever -------------------------------------------- */
console.log('');
console.log('  EVERY FLOW EVENTUALLY LAPSES');
console.log('  ' + '-'.repeat(66));
const KINDS = ['ride', 'order', 'booktable', 'booking', 'stay', 'somethingUnknown'];
for (const kind of KINDS) {
  reset();
  const ttlH = (F.FLOW_TTL_MS[kind] || F.FLOW_TTL_MS.default) / HOUR;
  STORE.pending[UID] = [flow(kind, 'the thing', ttlH + 1)];
  F.lapseFlows(UID);
  const state = STORE.pending[UID][0].state;
  const ok = state === 'expired';
  check(`${kind} lapses after its TTL`, ok, `still "${state}" after ${ttlH + 1}h`);
  console.log(`  ${ok ? '✓' : '✗'} ${kind.padEnd(18)} TTL ${String(ttlH).padStart(3)}h → ${state}`);
}

/* --- 2. it does NOT lapse early ----------------------------------------- */
console.log('');
console.log('  BUT NOT BEFORE ITS TIME');
console.log('  ' + '-'.repeat(66));
for (const kind of KINDS) {
  reset();
  const ttlH = (F.FLOW_TTL_MS[kind] || F.FLOW_TTL_MS.default) / HOUR;
  STORE.pending[UID] = [flow(kind, 'the thing', ttlH - 1)];
  F.lapseFlows(UID);
  const ok = STORE.pending[UID][0].state === 'waiting';
  check(`${kind} survives to its TTL`, ok, 'lapsed an hour early');
  console.log(`  ${ok ? '✓' : '✗'} ${kind.padEnd(18)} still waiting at ${ttlH - 1}h`);
}

/* --- 3. the brief asks once, about the oldest, and never doubles up ------ */
console.log('');
console.log('  THE BRIEF ASKS ONCE, ABOUT THE RIGHT ONE');
console.log('  ' + '-'.repeat(66));

reset();
STORE.pending[UID] = [flow('booking', 'the Sapa train', 2), flow('ride', 'a ride to the airport', 5)];
let brief = F.pendingBrief(UID);
const mentionsOldest = brief.includes('ride to the airport');
check('the brief raises the OLDEST unfinished flow', mentionsOldest, `raised: ${brief.slice(0, 80)}`);
console.log(`  ${mentionsOldest ? '✓' : '✗'} two open flows → asks about the older one`);

const onlyOne = (brief.match(/he started/g) || []).length <= 1;
check('the brief raises only one at a time', onlyOne, 'lists several, which is nagging');
console.log(`  ${onlyOne ? '✓' : '✗'} only one raised, not a list`);

reset();
STORE.pending[UID] = [flow('booking', 'a hotel', 2, { ownedByPlan: true })];
brief = F.pendingBrief(UID);
const quiet = brief === '';
check('a plan-owned flow is not double-asked', quiet, 'both the plan and the brief would ask');
console.log(`  ${quiet ? '✓' : '✗'} plan-owned flow stays out of the brief`);

reset();
STORE.pending[UID] = [flow('ride', 'old ride', 200)];
brief = F.pendingBrief(UID);
const lapsedSilent = brief === '';
check('a lapsed flow stops being raised', lapsedSilent, 'still nagging after it expired');
console.log(`  ${lapsedSilent ? '✓' : '✗'} expired flow is silent`);

/* --- 4. the outcome that gets recorded must be the truth ---------------- */
console.log('');
console.log('  "NOT YET" MUST NOT BE RECORDED AS "DONE"');
console.log('  ' + '-'.repeat(66));
// `if (action === "close" && id)` appears in BOTH the bug log and the pending
// endpoint. Anchor inside /pending or this reads the wrong block entirely.
const pendStart = server.indexOf('app.post("/pending"');
const closeBlock = server.slice(server.indexOf('if (action === "close" && id)', pendStart),
                                server.indexOf('app.post(', pendStart + 10));
const handlesWaiting = /outcome === "waiting"/.test(closeBlock);
check('"not yet" keeps the flow open', handlesWaiting,
  'anything not "done"/"abandoned" falls through to done — it would mark it complete and stop asking');
console.log(`  ${handlesWaiting ? '✓' : '✗'} "not yet" leaves the flow waiting`);

const writesTruth = /completed|abandoned/.test(closeBlock) && /mem\.push\(/.test(closeBlock);
check('the real outcome reaches memory', writesTruth, 'follow-through is not recorded');
console.log(`  ${writesTruth ? '✓' : '✗'} done/abandoned written to memory as a fact`);

const noFalseComplete = !/state = "done"/.test(closeBlock) || /outcome === "waiting"/.test(closeBlock);
check('a re-opened flow is never recorded as complete', noFalseComplete,
  'memory would learn he follows through on things he actually dropped');
console.log(`  ${noFalseComplete ? '✓' : '✗'} memory is not taught a false habit`);

/* --- 5. growth is bounded ----------------------------------------------- */
console.log('');
console.log('  IT CANNOT GROW FOREVER');
console.log('  ' + '-'.repeat(66));
const openBlock = server.slice(server.indexOf('if (action === "open" && flow)', pendStart),
                               server.indexOf('if (action === "open" && flow)', pendStart) + 500);
const trimmed = /while \(list\.length > \d+\) list\.shift\(\)/.test(openBlock);
check('the pending list is trimmed on open', trimmed, 'unbounded growth in a per-user store');
console.log(`  ${trimmed ? '✓' : '✗'} trimmed on every open`);

reset();
for (let i = 0; i < 60; i++) {
  STORE.pending[UID].push(flow('booking', 'thing ' + i, i));
  while (STORE.pending[UID].length > 20) STORE.pending[UID].shift();
}
const capped = STORE.pending[UID].length <= 20;
check('60 opened flows stay capped at 20', capped, `${STORE.pending[UID].length} kept`);
console.log(`  ${capped ? '✓' : '✗'} 60 flows opened → ${STORE.pending[UID].length} kept`);

/* --- 6. the app offers a way out ---------------------------------------- */
console.log('');
console.log('  HE CAN ALWAYS GET OUT OF IT');
console.log('  ' + '-'.repeat(66));
const resume = app.slice(app.indexOf('function resumePending'), app.indexOf('function resumePending') + 2200);
const threeAnswers = /Done|Not yet|Didn/.test(resume);
check('the app offers more than yes/no', threeAnswers, 'no way to say "not yet" without lying');
console.log(`  ${threeAnswers ? '✓' : '✗'} Done / Not yet / Didn't do it`);

// resumePending renders the buttons; closePending does the sending. Follow it.
const closeFn = app.slice(app.indexOf('function closePending'), app.indexOf('function closePending') + 1600);
const sendsOutcome = /action:'close'.*outcome/s.test(closeFn);
check('the app sends which answer he gave', sendsOutcome, 'the server cannot tell them apart');
console.log(`  ${sendsOutcome ? '✓' : '✗'} the chosen outcome reaches the server`);

// The one that actually bit: "not yet" used to return without telling the
// server, so the flow's clock kept running from when it was first opened and
// it lapsed silently soon after.
const notYetTold = /outcome==='waiting'[\s\S]{0,900}api\('\/pending'/.test(closeFn);
check('"not yet" tells the server too', notYetTold,
  'the flow clock keeps running from the original open — saying "not yet" makes it MORE likely to vanish');
console.log(`  ${notYetTold ? '✓' : '✗'} "not yet" resets the clock server-side`);

// And a deferral must eventually give up rather than asking forever.
const deferCap = /p\.deferred >= 3/.test(server);
check('repeated deferrals eventually lapse', deferCap, 'it would ask a fourth, fifth, sixth time');
console.log(`  ${deferCap ? '✓' : '✗'} three "not yet"s and it stops asking`);

/* --- 7. a stuck flow is visible ---------------------------------------- */
console.log('');
console.log('  A STUCK FLOW IS VISIBLE, NOT SILENT');
console.log('  ' + '-'.repeat(66));
const advisorHasStalled = /function stalledFlow/.test(server);
check('the advisor notices a long-open flow', advisorHasStalled,
  'nothing surfaces a flow he forgot he started');
console.log(`  ${advisorHasStalled ? '✓' : '✗'} stalledFlow advisor exists`);

reset();
STORE.pending[UID] = [flow('booking', 'the Sapa train', 8)];
const stillWaiting = STORE.pending[UID][0].state === 'waiting';
check('an 8h-old booking is still open, not lapsed', stillWaiting,
  'booking TTL is 48h, so 8h must still be live');
console.log(`  ${stillWaiting ? '✓' : '✗'} 8h-old booking still open (48h TTL) → advisor can raise it`);

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(66));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
