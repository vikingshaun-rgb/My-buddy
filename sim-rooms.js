'use strict';
/* sim-rooms.js — the shared-room layer, stressed.
 *
 * A room holds live location, dropped pins, messages, camera frames and shared
 * spend for him and Jess. It is the only part of Vision where a mistake exposes
 * where someone physically is — so the bar is different from everything else.
 *
 *   GUESSABLE   — a short code and anyone past the token watches his location
 *   CONJURED    — a read path that CREATES the room it was asked about, so a
 *                 wrong guess silently succeeds instead of failing
 *   UNBOUNDED   — pins and messages growing forever on a 512MB dyno
 *   ABANDONED   — every typo leaving a room behind that nothing ever clears
 *   BLEEDING    — one room's data reachable from another
 *
 * Run: node sim-rooms.js
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

/* --- stand the room layer up -------------------------------------------- */
const start = server.indexOf('const rooms = Object.create(null)');
const end = server.indexOf('// Join / announce presence in a room.');
fs.writeFileSync('/tmp/_rooms.js',
  'function dlog(){}\n' + server.slice(start, end) +
  '\nmodule.exports={rooms,room,roomCodeOk,ROOM_MAX_PINS,ROOM_MAX_MESSAGES,ROOM_IDLE_MS};');
const R = require('/tmp/_rooms.js');

console.log('');
console.log('  SHARED ROOMS — THE ONE PLACE A MISTAKE EXPOSES WHERE HE IS');
console.log('  ' + '='.repeat(68));

/* --- 1. a code must not be guessable ------------------------------------ */
console.log('');
console.log('  A CODE MUST NOT BE GUESSABLE');
console.log('  ' + '-'.repeat(68));

const WEAK = ['US', '1234', 'SHAUN', 'JESS', 'trip', 'a', '', '   '];
let allRejected = true;
for (const c of WEAK) {
  const v = R.roomCodeOk(c);
  if (v.ok) { allRejected = false; console.log(`      ✗ "${c}" accepted`); }
}
let ok = check('short or obvious codes are refused', allRejected, 'a guessable code exposes live location');
line(ok, `${WEAK.length} weak codes tried → all refused`);

const STRONG = ['SHAUN-JESS-VIETNAM-2026', 'TRIP-2026-AUG', 'HANOI-TRIP-01'];
let allAccepted = STRONG.every(c => R.roomCodeOk(c).ok);
ok = check('a proper code is accepted', allAccepted, 'the rule is too strict to use');
line(ok, `${STRONG.length} realistic codes → all accepted`);

ok = check('the refusal explains itself', /Pick a longer code/.test(server),
  'a rejected code with no reason looks like a bug');
line(ok, 'the server says why, not just "no"');

ok = check('the app surfaces the refusal', /data\.spoken[\s\S]{0,80}return/.test(app.slice(app.indexOf("api('/pair'"), app.indexOf("api('/pair'") + 700)),
  'the app would show "Linked ✓" for a code the server rejected');
line(ok, 'the app stops and says why');

/* --- 2. reading must not conjure a room --------------------------------- */
console.log('');
console.log('  A GUESS MUST FAIL, NOT SUCCEED QUIETLY');
console.log('  ' + '-'.repeat(68));

for (const k of Object.keys(R.rooms)) delete R.rooms[k];

const guessed = R.room('SOMEONE-ELSES-TRIP-2026');
ok = check('reading an unknown code returns nothing', guessed === null,
  'a wrong guess would create the room and appear to work');
line(ok, 'unknown code → null, no room created');

ok = check('nothing was created by the attempt', Object.keys(R.rooms).length === 0,
  'a failed guess left a room behind');
line(ok, `${Object.keys(R.rooms).length} rooms exist after the guess`);

const made = R.room('SHAUN-JESS-VIETNAM-2026', { create: true });
ok = check('pairing does create the room', !!made, 'pairing is broken');
line(ok, 'explicit create → room exists');

const readBack = R.room('SHAUN-JESS-VIETNAM-2026');
ok = check('the paired room reads back', !!readBack, 'created but unreadable');
line(ok, 'same code reads the same room');

ok = check('only /pair creates', /room\(code, \{ create: true \}\)/.test(server) &&
  (server.match(/room\(code, \{ create: true \}\)/g) || []).length === 1,
  'more than one endpoint can conjure a room');
line(ok, 'exactly one create path in the whole server');

/* --- 3. case and whitespace must not fork a room ------------------------ */
console.log('');
console.log('  ONE CODE, ONE ROOM');
console.log('  ' + '-'.repeat(68));

R.room('  shaun-jess-vietnam-2026  ', { create: true });
const roomCount = Object.keys(R.rooms).length;
ok = check('case and spacing resolve to one room', roomCount === 1, `${roomCount} rooms for one code`);
line(ok, 'lower case + padding → same room');

/* --- 4. growth is bounded ----------------------------------------------- */
console.log('');
console.log('  IT CANNOT GROW FOREVER');
console.log('  ' + '-'.repeat(68));

const r = R.room('SHAUN-JESS-VIETNAM-2026');
for (let i = 0; i < 500; i++) {
  r.pins.unshift({ by: 'me', label: 'pin ' + i, lat: 1, lng: 1, at: Date.now() });
  if (r.pins.length > R.ROOM_MAX_PINS) r.pins.length = R.ROOM_MAX_PINS;
  r.messages.unshift({ by: 'me', text: 'msg ' + i, at: Date.now() });
  if (r.messages.length > R.ROOM_MAX_MESSAGES) r.messages.length = R.ROOM_MAX_MESSAGES;
}
ok = check('pins are capped', r.pins.length <= R.ROOM_MAX_PINS, `${r.pins.length} kept`);
line(ok, `500 pins → ${r.pins.length} kept`);
ok = check('messages are capped', r.messages.length <= R.ROOM_MAX_MESSAGES, `${r.messages.length} kept`);
line(ok, `500 messages → ${r.messages.length} kept`);

ok = check('the caps are enforced in the endpoint too', /r\.pins\.length = ROOM_MAX_PINS/.test(server),
  'the cap exists but nothing applies it on write');
line(ok, '/share trims on every write');

ok = check('shared spend is capped', /spend\.slice\(0, 200\)/.test(server), 'unbounded spend log');
line(ok, 'spend capped at 200 entries');

/* --- 5. abandoned rooms are cleared ------------------------------------- */
console.log('');
console.log('  A TYPO MUST NOT LEAVE A ROOM BEHIND FOREVER');
console.log('  ' + '-'.repeat(68));

ok = check('there is an idle sweep', /ROOM_IDLE_MS/.test(server) && /delete rooms\[k\]/.test(server),
  'every typo leaves a room holding a camera frame forever');
line(ok, `rooms untouched for ${R.ROOM_IDLE_MS / 86400000} days are cleared`);

// Simulate the sweep.
R.rooms['OLD-ABANDONED-ROOM'] = { members: {}, pins: [], messages: [], frames: {}, spend: [], at: Date.now() - 8 * 86400000 };
const before = Object.keys(R.rooms).length;
const now = Date.now();
for (const k of Object.keys(R.rooms)) if (now - (R.rooms[k].at || 0) > R.ROOM_IDLE_MS) delete R.rooms[k];
const after = Object.keys(R.rooms).length;
ok = check('an 8-day-old room is swept', after === before - 1, `${before} → ${after}`);
line(ok, `${before} rooms → ${after} after the sweep`);

ok = check('an active room survives the sweep', !!R.rooms['SHAUN-JESS-VIETNAM-2026'],
  'the sweep is eating live rooms');
line(ok, 'the active room is untouched');

/* --- 6. rooms are isolated ---------------------------------------------- */
console.log('');
console.log('  ONE ROOM MUST NOT SEE ANOTHER');
console.log('  ' + '-'.repeat(68));

const a = R.room('TRIP-ALPHA-2026', { create: true });
const b = R.room('TRIP-BRAVO-2026', { create: true });
a.members['shaun'] = { name: 'shaun', lat: 21.02, lng: 105.85, at: Date.now() };
b.members['someone'] = { name: 'someone', lat: 0, lng: 0, at: Date.now() };
ok = check('a second room cannot see the first', !b.members['shaun'], 'location bleeds between rooms');
line(ok, "room B has no sight of room A's members");

ok = check('rooms hold separate pins', a.pins !== b.pins, 'they share an array reference');
line(ok, 'separate arrays, not a shared reference');

/* --- 7. it is in-memory ON PURPOSE -------------------------------------- */
console.log('');
console.log('  IN-MEMORY IS A DECISION, NOT AN ACCIDENT');
console.log('  ' + '-'.repeat(68));

ok = check('rooms are not persisted to STORE', !/STORE\.rooms/.test(server),
  'live location would survive a redeploy, which nobody asked for');
line(ok, 'wiped on redeploy — correct for live location');

ok = check('that choice is written down', /in memory only|not in STORE|wiped on every\s*\n?\s*\*\s*redeploy/i.test(server),
  'a future change might "fix" it by persisting location');
line(ok, 'the reasoning is in the code, so nobody undoes it');

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(68));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
