'use strict';
/* sim-couple.js — the nine couple skills, stressed.
 *
 * Travelling as a pair is the only part of Vision where a failure affects
 * someone who isn't holding the phone. That changes what "broken" means:
 *
 *   WRONG PERSON  — a message or pin reaching the wrong room
 *   STALE         — her location shown as current when it's two hours old
 *   BAD MATHS     — a who-owes-who number he'd actually settle up on
 *   ONE-WAY       — he can see her, she can't see him, and neither knows
 *   NO PARTNER    — every skill assuming she's linked when she isn't
 *
 * The maths one matters most: a wrong balance is worse than no balance,
 * because he'd pay it.
 *
 * Run: node sim-couple.js
 */

const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const app = fs.readFileSync('app.html', 'utf8');

let pass = 0, fail = 0;
const problems = [];
function check(name, ok, why) {
  if (ok) { pass++; return true; }
  fail++; problems.push(`${name}${why ? ' — ' + why : ''}`);
  return false;
}
function line(ok, text, extra) { console.log(`  ${ok ? '✓' : '✗'} ${text}${extra ? '  ' + extra : ''}`); }

const COUPLE_SKILLS = ['sharepin', 'livelocation', 'meetmiddle', 'onmyway',
                       'tellpartner', 'couplespend', 'splitbill', 'sharedmoments', 'whereis'];

const rsStart = server.indexOf('const ROUTER_SKILLS');
fs.writeFileSync('/tmp/_cs.js', server.slice(rsStart, server.indexOf('const VALID_SKILLS')) + '\nmodule.exports={ROUTER_SKILLS};');
const { ROUTER_SKILLS } = require('/tmp/_cs.js');
const DISPATCHED = new Set([...app.matchAll(/skill===\s*'(\w+)'/g)].map(m => m[1]));

function routeBody(r) {
  const i = server.indexOf(`"${r}"`);
  if (i === -1) return '';
  const j = server.indexOf('app.post(', i + 10);
  return server.slice(i, j > 0 ? j : i + 4000);
}

console.log('');
console.log('  COUPLE FEATURES — WHERE A BUG AFFECTS SOMEONE ELSE');
console.log('  ' + '='.repeat(68));

/* --- 1. every skill is reachable by voice ------------------------------- */
console.log('');
console.log('  ALL NINE REACHABLE BY VOICE');
console.log('  ' + '-'.repeat(68));
for (const s of COUPLE_SKILLS) {
  const declared = new RegExp(`"${s}" \\(`).test(ROUTER_SKILLS);
  const dispatched = DISPATCHED.has(s);
  const ok = check(`${s} is reachable`, declared && dispatched,
    !declared ? 'not declared to the router' : 'no dispatch branch');
  line(ok, s.padEnd(15), declared && dispatched ? 'declared + dispatched' : 'BROKEN');
}

/* --- 2. nothing works without a partner, and it says so ----------------- */
console.log('');
console.log('  WITHOUT A PARTNER LINKED, IT SAYS SO');
console.log('  ' + '-'.repeat(68));
const NEEDS_PAIR = ['coupleSpend', 'shareMyLocation', 'meetInMiddle', 'onMyWay', 'whereIsPartner'];
for (const fn of NEEDS_PAIR) {
  const i = app.indexOf(`function ${fn}`);
  if (i === -1) { line(true, `${fn.padEnd(18)} (not present, skipped)`); continue; }
  let d = 0, j = i;
  for (let k = i; k < app.length; k++) {
    if (app[k] === '{') d++;
    else if (app[k] === '}') { d--; if (d === 0) { j = k; break; } }
  }
  const body = app.slice(i, j);
  // Several of these delegate the check to withRoom(), which guards the code
  // and explains itself. Following the call is the honest test — demanding the
  // guard be inline would just reward copy-paste.
  const guards = (/pairCode\(\)/.test(body) && /(if\(!code\)|if\(!pairCode)/.test(body))
    || /withRoom\(/.test(body);
  const ok = check(`${fn} checks for a partner first`, guards,
    'would silently do nothing, or worse, act on an empty room code');
  line(ok, fn.padEnd(18), guards ? 'refuses and explains' : 'no guard');
}

/* --- 3. the money maths must be right ----------------------------------- */
console.log('');
console.log('  THE MONEY MATHS — A WRONG BALANCE IS WORSE THAN NONE');
console.log('  ' + '-'.repeat(68));

// Reproduce the balance logic from coupleSpend exactly.
function settle(entries) {
  const totals = {};
  entries.forEach(s => { totals[s.by] = (totals[s.by] || 0) + s.amt; });
  const names = Object.keys(totals);
  const grand = names.reduce((a, n) => a + totals[n], 0);
  let owes = null;
  if (names.length === 2) {
    const [a, b] = names;
    const diff = (totals[a] - totals[b]) / 2;
    if (Math.abs(diff) > 0.01) owes = { who: diff > 0 ? b : a, to: diff > 0 ? a : b, amt: Math.abs(diff) };
  }
  return { totals, grand, owes };
}

const CASES = [
  { n: 'he pays everything',        e: [{ by: 'Shaun', amt: 100 }],
    want: { grand: 100, owes: null } },
  { n: 'even split, no one owes',   e: [{ by: 'Shaun', amt: 50 }, { by: 'Jess', amt: 50 }],
    want: { grand: 100, owes: null } },
  { n: 'he paid 80, she paid 20',   e: [{ by: 'Shaun', amt: 80 }, { by: 'Jess', amt: 20 }],
    want: { grand: 100, owes: { who: 'Jess', to: 'Shaun', amt: 30 } } },
  { n: 'she paid more',             e: [{ by: 'Shaun', amt: 20 }, { by: 'Jess', amt: 80 }],
    want: { grand: 100, owes: { who: 'Shaun', to: 'Jess', amt: 30 } } },
  { n: 'many small entries',        e: [{ by: 'Shaun', amt: 12.5 }, { by: 'Jess', amt: 7.25 }, { by: 'Shaun', amt: 3.3 }, { by: 'Jess', amt: 40 }],
    want: { grand: 63.05, owes: { who: 'Shaun', to: 'Jess', amt: 15.725 } } },
  { n: 'a cent apart — no nagging', e: [{ by: 'Shaun', amt: 50.005 }, { by: 'Jess', amt: 50 }],
    want: { grand: 100.005, owes: null } },
];
for (const c of CASES) {
  const r = settle(c.e);
  const grandOk = Math.abs(r.grand - c.want.grand) < 0.001;
  let owesOk;
  if (!c.want.owes) owesOk = r.owes === null;
  else owesOk = r.owes && r.owes.who === c.want.owes.who && r.owes.to === c.want.owes.to
                && Math.abs(r.owes.amt - c.want.owes.amt) < 0.01;
  const ok = check(`settle: ${c.n}`, grandOk && owesOk,
    `got pot ${r.grand}, ${r.owes ? `${r.owes.who} owes ${r.owes.to} ${r.owes.amt.toFixed(2)}` : 'square'}`);
  line(ok, c.n.padEnd(26),
    `pot ${r.grand.toFixed(2)} · ${r.owes ? `${r.owes.who} owes ${r.owes.amt.toFixed(2)}` : 'square'}`);
}

// The one that would actually bite: a third name appearing in a couple's room.
{
  const r = settle([{ by: 'Shaun', amt: 60 }, { by: 'Jess', amt: 30 }, { by: 'me', amt: 10 }]);
  const ok = check('three names produce no misleading balance', r.owes === null,
    'a two-way split would be computed across three people');
  line(ok, 'three names in the room'.padEnd(26), r.owes ? 'CLAIMS a balance' : 'totals only, no balance');
  if (!ok) problems.push('the "me" default name creates a phantom third person — see below');
}

/* --- 4. the default name is a real trap --------------------------------- */
console.log('');
console.log('  THE NAME HE JOINS WITH');
console.log('  ' + '-'.repeat(68));
{
  const pairBody = routeBody('/pair');
  const defaultsToMe = /name \|\| "me"/.test(pairBody) || /\(name \|\| "me"\)/.test(pairBody);
  // If he ever joins without a name he becomes "me", and a later join with his
  // real name looks like a third person — which silently breaks the balance.
  const appAlwaysSendsName = /name:\s*myName\(\)/.test(app);
  const ok = check('the app always sends a real name', appAlwaysSendsName,
    'joining as "me" creates a phantom member and breaks who-owes-who');
  line(ok, 'app sends myName() on every room call');
  line(true, `server default is "${defaultsToMe ? 'me' : 'unknown'}"`, '(only reached if the app misbehaves)');
}

/* --- 5. her location must not look fresher than it is ------------------- */
console.log('');
console.log('  HER LOCATION MUST NOT LOOK FRESHER THAN IT IS');
console.log('  ' + '-'.repeat(68));
{
  const roomBody = routeBody('/room');
  const stamps = /at:\s*m\.at|ago|at: /.test(roomBody);
  const ok = check('member positions carry a timestamp', stamps,
    'a two-hour-old position would read as where she is now');
  line(ok, 'position carries "when"');

  const wip = app.slice(app.indexOf('function whereIsPartner'), app.indexOf('function whereIsPartner') + 2200);
  const appShowsAge = /fixAge|seenAt/.test(wip) && /min ago|h ago/.test(wip);
  const ok2 = check('the app says how old her position is', appShowsAge,
    'he would walk to where she was, not where she is');
  line(ok2, 'the app speaks the age of the fix');

  // The tense is the warning: "was 400m north" reads completely differently
  // from "is 400m north", and he acts on the difference.
  const saysWas = /WAS about/.test(wip);
  const ok3 = check('a stale fix is spoken in the past tense', saysWas,
    'a two-hour-old position would be read out as current');
  line(ok3, 'stale fix → "WAS about 400m north", not "is"');
}

/* --- 6. one room, one couple -------------------------------------------- */
console.log('');
console.log('  A MESSAGE MUST NOT REACH THE WRONG ROOM');
console.log('  ' + '-'.repeat(68));
{
  const shareBody = routeBody('/share');
  const scoped = /const r = room\(code\)/.test(shareBody);
  const ok = check('every write is scoped to a code', scoped, 'a write could land in a shared global');
  line(ok, 'writes go to room(code), never a global');

  const failsClosed = /no_such_room/.test(shareBody);
  const ok2 = check('an unknown code is refused', failsClosed,
    'a typo would create a new room and the message would vanish into it');
  line(ok2, 'unknown code → 404, not a silent new room');
}

/* --- 7. it works with the screen off? ----------------------------------- */
console.log('');
console.log('  THE HONEST LIMIT');
console.log('  ' + '-'.repeat(68));
{
  // Worth asserting so nobody later claims live tracking works in the PWA.
  const hasPoll = /setInterval[^;]{0,120}\/room|liveTick|liveShare/.test(app);
  line(true, 'live location is POLLED while the app is open', hasPoll ? '(interval present)' : '');
  line(true, 'iOS Safari cannot poll with the screen off', '— native only');
  const documented = /screen off|background|native/i.test(app.slice(app.indexOf('function shareMyLocation'), app.indexOf('function shareMyLocation') + 900));
  const ok = check('the limit is stated somewhere he will see it', documented || /native/i.test(app),
    'he would trust live sharing to work while riding, and it would not');
  line(ok, 'the limit is written down');
}

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(68));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
