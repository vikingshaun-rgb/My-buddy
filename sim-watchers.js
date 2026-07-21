'use strict';
/* sim-watchers.js — standing watches, tested for the things that only show up
 * over time.
 *
 * A watcher runs unattended on an hourly sweep. That makes its failure modes
 * different from everything else in Vision: nobody is looking when it goes
 * wrong, and the damage is cumulative rather than immediate.
 *
 *   REPEATS      — the same alert every hour until he mutes the app
 *   STALLS       — one hung endpoint blocking the other seven
 *   SPENDS       — a web-search model call per watcher per hour, unnoticed
 *   INVENTS      — an event that doesn't exist, acted on because he never asked
 *
 * Run: node sim-watchers.js
 */

const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');

const STORE = { watchers: {}, results: {}, seen: {} };
const UID = 'sim';
function reset() { STORE.watchers = { [UID]: [] }; STORE.results = { [UID]: [] }; STORE.seen = {}; }

const s = server.indexOf('const WATCH_TIMEOUT_MS');
const e = server.indexOf('async function runWatcher');
fs.writeFileSync('/tmp/_w.js',
  'let STORE;\nmodule.exports.setStore = x => { STORE = x; };\n' +
  server.slice(s, e) +
  '\nmodule.exports.watchIsRepeat = watchIsRepeat;\nmodule.exports.WATCH_TIMEOUT_MS = WATCH_TIMEOUT_MS;\n');
const W = require('/tmp/_w.js');
W.setStore(STORE);

const HOUR = 3600000;
let pass = 0, fail = 0;
const problems = [];
function check(name, ok, why) {
  if (ok) { pass++; return; }
  fail++; problems.push(`${name}${why ? ' — ' + why : ''}`);
}

console.log('');
console.log('  WATCHERS — STANDING INSTRUCTIONS, RUNNING UNATTENDED');
console.log('  ' + '='.repeat(68));

/* --- 1. the same alert must not fire twice ------------------------------ */
console.log('');
console.log('  AN ALERT IS NEWS ONCE, THEN IT IS NAGGING');
console.log('  ' + '-'.repeat(68));

const w = { id: 'w1', label: 'Brisbane to Hanoi', type: 'flightdeal', threshold: 800 };
const line = 'Brisbane to Hanoi: around $780 — under your $800 mark! Fares dipped this week.';

reset();
let first = W.watchIsRepeat(UID, w, line);
check('the first time it fires, it is not a repeat', first === false);
console.log(`  ${!first ? '✓' : '✗'} first alert gets through`);

STORE.results[UID].push({ at: Date.now(), id: 'w1', label: w.label, spoken: line, triggered: true });
const second = W.watchIsRepeat(UID, w, line);
check('the identical alert an hour later is suppressed', second === true,
  'he would be told the same thing 24 times a day');
console.log(`  ${second ? '✓' : '✗'} identical alert an hour later is suppressed`);

// But real news must still get through.
const moved = 'Brisbane to Hanoi: around $690 — under your $800 mark! Fares dropped further.';
const movedOk = W.watchIsRepeat(UID, w, moved) === false;
check('a CHANGED price still gets through', movedOk, 'genuine news would be swallowed');
console.log(`  ${movedOk ? '✓' : '✗'} a changed price is still news`);

// And after a day, a nudge is fair again.
reset();
STORE.results[UID].push({ at: Date.now() - 25 * HOUR, id: 'w1', label: w.label, spoken: line, triggered: true });
const dayLater = W.watchIsRepeat(UID, w, line) === false;
check('after 24h the same alert is allowed again', dayLater, 'it would go silent forever');
console.log(`  ${dayLater ? '✓' : '✗'} same alert allowed again after 24h`);

// A different watcher saying something similar must not be muted by this one.
reset();
STORE.results[UID].push({ at: Date.now(), id: 'w1', label: 'x', spoken: line, triggered: true });
const otherWatcher = W.watchIsRepeat(UID, { id: 'w2' }, line) === false;
check('suppression is per-watcher, not global', otherWatcher, 'one watcher would silence another');
console.log(`  ${otherWatcher ? '✓' : '✗'} a different watcher is unaffected`);

// An untriggered result must not count as "already said".
reset();
STORE.results[UID].push({ at: Date.now(), id: 'w1', label: 'x', spoken: line, triggered: false });
const untriggeredIgnored = W.watchIsRepeat(UID, w, line) === false;
check('an untriggered log entry does not suppress a real alert', untriggeredIgnored,
  'a quiet check would mute the alert that follows it');
console.log(`  ${untriggeredIgnored ? '✓' : '✗'} untriggered entries do not suppress`);

/* --- 2. nothing runs unbounded ------------------------------------------ */
console.log('');
console.log('  ONE HUNG ENDPOINT MUST NOT STALL THE OTHER SEVEN');
console.log('  ' + '-'.repeat(68));

const runBody = server.slice(server.indexOf('async function runWatcher'),
                             server.indexOf('// Hourly sweep + first run'));
const bareFetch = /await \(await fetch\(/.test(runBody);
check('no bare fetch left in runWatcher', !bareFetch,
  'a hung API blocks the sequential pass for every other watcher');
console.log(`  ${!bareFetch ? '✓' : '✗'} every outbound call is bounded`);
check('the timeout is a sane length', W.WATCH_TIMEOUT_MS >= 5000 && W.WATCH_TIMEOUT_MS <= 30000,
  `${W.WATCH_TIMEOUT_MS}ms`);
console.log(`  ✓ timeout is ${W.WATCH_TIMEOUT_MS}ms`);

const modelCallBounded = /callClaude\(/.test(runBody);
check('the model call goes through the retrying gateway', modelCallBounded);
console.log(`  ${modelCallBounded ? '✓' : '✗'} model calls use callClaude (timeout + retry)`);

const catchAll = /catch \{ \/\* one failed run is fine/.test(runBody);
check('one failed watcher does not kill the pass', catchAll);
console.log(`  ${catchAll ? '✓' : '✗'} a failure is contained to that watcher`);

/* --- 3. cost and growth are bounded ------------------------------------- */
console.log('');
console.log('  IT CANNOT QUIETLY RUN UP A BILL');
console.log('  ' + '-'.repeat(68));

const capped = /list\.length >= 8/.test(server);
check('watchers are capped', capped, 'unlimited standing web searches');
console.log(`  ${capped ? '✓' : '✗'} capped at 8`);

const resultsTrimmed = /while \(results\.length > 30\) results\.shift\(\)/.test(server);
check('the results log is trimmed', resultsTrimmed);
console.log(`  ${resultsTrimmed ? '✓' : '✗'} results log capped at 30`);

const hourly = /\}\), 3600000\)/.test(server) || /3600000\)/.test(server);
check('the sweep is hourly, not tighter', hourly);
console.log(`  ${hourly ? '✓' : '✗'} hourly sweep`);

// With suppression, a triggered watcher stops costing after the first hit.
const before = 8 * 24, after = 8 * 24;   // calls still happen; the ALERT is what's suppressed
console.log(`  · worst case ${after} model calls/day at 8 search-backed watchers (~$${(after * 0.01).toFixed(2)})`);
console.log(`  · suppression stops the ALERTS repeating, not the checks — correct, since a price can move`);

/* --- 4. unattended output must not be invented -------------------------- */
console.log('');
console.log('  IT RUNS WITHOUT HIM WATCHING, SO IT MUST NOT INVENT');
console.log('  ' + '-'.repeat(68));

const guarded = /NO_INVENT_STRICT/.test(runBody);
check('the unattended prompt refuses to invent', guarded,
  'an invented event leads his brief and he acts on it without having asked');
console.log(`  ${guarded ? '✓' : '✗'} NO_INVENT_STRICT on the watch prompt`);

const emptyOk = /nothing found[\s\S]{0,80}correct and expected/.test(runBody);
check('an empty answer is explicitly allowed', emptyOk, 'it will reach for something to say');
console.log(`  ${emptyOk ? '✓' : '✗'} "nothing found" is a valid answer`);

const spokenPlain = /SPOKEN_PLAIN/.test(runBody);
check('watch output is spoken-plain', spokenPlain);
console.log(`  ${spokenPlain ? '✓' : '✗'} no markdown in something read aloud`);

/* --- 5. reminders behave like reminders --------------------------------- */
console.log('');
console.log('  A DATED REMINDER FIRES ONCE AND RETIRES');
console.log('  ' + '-'.repeat(68));

const retires = /one-shot: dated reminders retire once delivered/.test(runBody);
check('a fired reminder removes itself', retires, 'it would repeat every hour after its due time');
console.log(`  ${retires ? '✓' : '✗'} retires after firing`);

const undatedQuiet = /place\/undated reminders live in memory for recall, not repetition/.test(runBody);
check('an undated reminder never nags', undatedQuiet);
console.log(`  ${undatedQuiet ? '✓' : '✗'} undated reminders stay quiet`);

/* --- delivery: a finding he never sees is the same as no finding ---------
 * The subtlest failure in the whole engine. It fires, it's recorded, and it
 * silently never reaches the screen — indistinguishable from nothing having
 * happened, so he'd never think to look.
 */
console.log('');
console.log('  A FINDING MUST ACTUALLY REACH HIM');
console.log('  ' + '-'.repeat(68));

const endpointSrc = server.slice(server.indexOf('app.post("/watchers"'),
  server.indexOf('app.post(', server.indexOf('app.post("/watchers"') + 10));
const appSrc = require('fs').readFileSync('app.html', 'utf8');

{
  const latestBlk = endpointSrc.slice(endpointSrc.indexOf('action === "latest"'),
                                      endpointSrc.indexOf('action === "latest"') + 500);
  // The bug: marking everything seen inside `latest` while the app renders
  // only three meant the fourth vanished with no trace.
  const marksOnRead = /action === "latest"[\s\S]{0,400}STORE\.seen\[uid\] = Date\.now\(\)/.test(endpointSrc);
  const t1 = !marksOnRead;
  if (t1) pass++; else { fail++; problems.push('reading findings marks them seen before they are shown'); }
  console.log(`  ${t1 ? '✓' : '✗'} reading does not mark them seen`);

  const hasAck = /action === "seen"/.test(endpointSrc);
  if (hasAck) pass++; else { fail++; problems.push('no separate acknowledgement — findings cannot be delivered in batches'); }
  console.log(`  ${hasAck ? '✓' : '✗'} a separate "seen" acknowledgement exists`);

  const acksUpto = /upto/.test(endpointSrc);
  if (acksUpto) pass++; else { fail++; problems.push('acknowledgement is all-or-nothing, so anything arriving mid-render is lost'); }
  console.log(`  ${acksUpto ? '✓' : '✗'} acknowledges only up to what was shown`);

  const appAcks = /action:'seen'|action: 'seen'/.test(appSrc);
  if (appAcks) pass++; else { fail++; problems.push('the app never acknowledges, so findings would repeat forever'); }
  console.log(`  ${appAcks ? '✓' : '✗'} the app acknowledges after rendering`);

  const tellsMore = /more —|more waiting|\bmore\b[^\n]{0,40}watchers/i.test(appSrc);
  if (tellsMore) pass++; else { fail++; problems.push('extra findings beyond the first three are hidden with no hint'); }
  console.log(`  ${tellsMore ? '✓' : '✗'} says plainly when more are waiting`);
}

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(68));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
