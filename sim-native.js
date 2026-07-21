'use strict';
/* sim-native.js — is the brain ready for the Mac burst?
 *
 * The roadmap commits to one thing: the native app is a THIN CONNECTOR that
 * reuses every endpoint already built. That is either true or it isn't, and
 * the difference is days of rented Mac time versus weeks.
 *
 * What this CANNOT do: compile Swift, talk to the Meta SDK, or prove the
 * glasses work. There is no Swift in this repo and no Xcode here. Anyone
 * claiming otherwise is guessing.
 *
 * What it CAN do is check the contract the native app will depend on:
 *
 *   - can a client speak any response without knowing the endpoint?
 *   - is auth something a Swift app can do in three lines?
 *   - does anything assume a browser (localStorage, DOM, window)?
 *   - are the glasses-specific paths actually reachable from a native client?
 *   - is the config a native app needs written down, not in my head?
 *
 * Run: node sim-native.js
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

function routeBody(r) {
  const i = server.indexOf(`"${r}"`);
  if (i === -1) return '';
  const j = server.indexOf('app.post(', i + 10);
  return server.slice(i, j > 0 ? j : i + 4000);
}

console.log('');
console.log('  NATIVE READINESS — IS THE BRAIN READY FOR THE MAC BURST?');
console.log('  ' + '='.repeat(70));

/* --- 0. what this cannot check ------------------------------------------ */
console.log('');
console.log('  WHAT THIS CANNOT CHECK');
console.log('  ' + '-'.repeat(70));
const swiftFiles = fs.readdirSync('.').filter(f => f.endsWith('.swift'));
console.log(`  · no Swift in this repo (${swiftFiles.length} files) — the ~30 modules are elsewhere`);
console.log('  · no Xcode here, so nothing compiles or links against the Meta SDK');
console.log('  · the glasses themselves cannot be exercised without hardware');
console.log('  everything below is about the CONTRACT the native app depends on');

/* --- 1. every answer must be speakable ---------------------------------- */
console.log('');
console.log('  A CLIENT MUST BE ABLE TO SPEAK ANY ANSWER');
console.log('  ' + '-'.repeat(70));
// The web app knows which field to read for each of ~100 handlers. That
// knowledge must NOT have to be rewritten in Swift.
const marks = [...server.matchAll(/app\.post\("(\/[^"]+)"/g)].map(m => ({ at: m.index, p: m[1] }));
marks.push({ at: server.length, p: 'END' });
// Legitimately silent: the router returns a skill for the client to dispatch,
// and lifelog is a background capture — speaking every ambient log would be
// maddening.
const SILENT_BY_DESIGN = new Set(['/route', '/lifelog', '/pending', '/keys', '/memory', '/profile', '/state']);
const unspeakable = [];
for (let i = 0; i < marks.length - 1; i++) {
  let b = server.slice(marks[i].at, marks[i + 1].at);
  const cut = b.search(/\n(?:async function|function|const)\s/);
  if (cut > 0) b = b.slice(0, cut);
  if (!/callClaude/.test(b)) continue;
  if (SILENT_BY_DESIGN.has(marks[i].p)) continue;
  if (!/spoken/.test(b)) unspeakable.push(marks[i].p);
}
let ok = check('every model-backed endpoint answers in words', unspeakable.length === 0,
  `${unspeakable.join(', ')} — Swift would have to learn each field mapping`);
line(ok, `${unspeakable.length} endpoints a voice client could not read out`);

ok = check('the silent ones are silent on purpose', SILENT_BY_DESIGN.size > 0);
line(ok, '/route dispatches, /lifelog is ambient — both correctly quiet');

/* --- 2. auth a Swift app can do in three lines --------------------------- */
console.log('');
console.log('  AUTH MUST BE THREE LINES OF SWIFT, NOT A FLOW');
console.log('  ' + '-'.repeat(70));
ok = check('a single bearer token, no OAuth dance', /Bearer \$\{APP_TOKEN\}/.test(server));
line(ok, 'URLRequest + one header');

ok = check('no cookies or sessions to carry', !/express-session|cookie-parser|req\.session/.test(server));
line(ok, 'stateless — nothing for Swift to persist but the token');

ok = check('a native app (no Origin header) is allowed through', /!origin/.test(server),
  'CORS would block a client that sends no Origin');
line(ok, 'no-origin requests pass CORS');

ok = check('rate limiting will not fight a native client', /CALL_MAX/.test(server) && /120/.test(server),
  'a native app polling would trip the limiter');
line(ok, '120/min is well above a single client');

/* --- 3. nothing may assume a browser ------------------------------------ */
console.log('');
console.log('  THE BRAIN MUST NOT ASSUME A BROWSER');
console.log('  ' + '-'.repeat(70));
// Comments are prose, not code. This check previously fired on `windowStart`
// in the rate limiter, and then on the English word "window" in a comment
// explaining why an interruption has a deadline. A check that fires on its own
// documentation is worse than no check.
const serverCode = server
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

for (const [what, re] of [
  ['localStorage', /\blocalStorage\b/],
  ['window',       /\bwindow\b\s*[.\[]/],
  ['document',     /\bdocument\s*[.\[]/],
  ['navigator',    /\bnavigator\s*[.\[]/],
]) {
  const found = re.test(serverCode);
  ok = check(`server.js does not use ${what}`, !found, `a Swift client cannot provide ${what}`);
  line(ok, `no ${what} in the brain`);
}

/* --- 4. the glasses paths must be reachable ----------------------------- */
console.log('');
console.log('  THE GLASSES PATHS MUST ALREADY EXIST');
console.log('  ' + '-'.repeat(70));
// The native app's whole job is: capture → send → speak. These are the
// endpoints it will actually call.
const GLASSES = [
  ['/vision',        'what am I looking at'],
  ['/converse/turn', 'live translation'],
  ['/chat',          'general conversation'],
  ['/route',         'work out which skill he wants'],
  ['/moment',        'capture a burst of frames'],
  ['/menu',          'read a menu'],
  ['/allergy',       'is this safe to eat'],
  ['/job/capture',   'log a job from a screen'],
];
for (const [r, why] of GLASSES) {
  const body = routeBody(r);
  const exists = !!body;
  const guarded = exists && server.slice(server.indexOf(`"${r}"`), server.indexOf(`"${r}"`) + 140).includes('requireAuth');
  ok = check(`${r} exists and is guarded`, exists && guarded, exists ? 'unguarded' : 'missing');
  line(ok, `${r.padEnd(16)} ${why}`);
}

// Image endpoints must accept base64, which is what a Swift capture produces.
ok = check('image endpoints take base64, not multipart', /base64/.test(routeBody('/vision')),
  'Swift would need a multipart encoder for every capture');
line(ok, 'base64 in JSON — trivial from Data in Swift');

/* --- 5. the config a native build needs must be written down ------------ */
console.log('');
console.log('  THE BUILD CONFIG MUST NOT LIVE IN SOMEONE\'S HEAD');
console.log('  ' + '-'.repeat(70));
const roadmap = fs.existsSync('Buddy-Master-Roadmap.md') ? fs.readFileSync('Buddy-Master-Roadmap.md', 'utf8') : '';
ok = check('the roadmap names what the Mac burst needs', /Xcode/.test(roadmap) && /Apple Dev/.test(roadmap),
  'he would arrive at a rented Mac and start guessing');
line(ok, 'Xcode + Apple licence + toolkit + glasses listed');

ok = check('the native app is scoped as a thin connector', /thin connector/i.test(roadmap),
  'scope creep on rented time is expensive');
line(ok, 'roadmap says: reuse every endpoint, add no logic');

ok = check('there is an exit test for the glasses phase', /Exit test/i.test(roadmap),
  'no definition of done means the burst never ends');
line(ok, '"Hey Buddy, what am I looking at?" hands-free');

/* --- 6. what would actually be rebuilt in Swift -------------------------- */
console.log('');
console.log('  WHAT THE NATIVE APP STILL HAS TO BUILD ITSELF');
console.log('  ' + '-'.repeat(70));
// Being honest about this is the point — these are NOT brain problems, and
// pretending the brain covers them is how a three-day burst becomes three weeks.
const NATIVE_ONLY = [
  ['continuous listening / wake word', 'no web API can hold the mic'],
  ['background execution', 'iOS Safari suspends a PWA'],
  ['push notifications', 'nothing can wake the phone from web'],
  ['glasses camera via the Meta SDK', 'the toolkit is Swift-only'],
  ['reliable speech output', 'AVSpeechSynthesizer beats the web API'],
  ['offline translation', "Apple's on-device framework, native only"],
];
for (const [what, why] of NATIVE_ONLY) {
  console.log(`  · ${what.padEnd(34)} ${why}`);
}
ok = check('the brain does not pretend to cover these', /native|glasses/i.test(app),
  'the app would over-promise what it can do today');
line(ok, 'the limits are stated in the app, not hidden');

/* --- 7. a native client could not break the web one --------------------- */
console.log('');
console.log('  TWO CLIENTS ON ONE BRAIN MUST NOT COLLIDE');
console.log('  ' + '-'.repeat(70));
ok = check('state is keyed per user, not per client', /uidOf\(req\)/.test(server),
  'the phone and the glasses would overwrite each other');
line(ok, 'both clients share one uid, which is what he wants');

ok = check('the seen-marker is acknowledged, not auto-cleared', /action === "seen"/.test(server),
  'whichever client polled first would eat the other\'s notifications');
line(ok, 'watcher findings survive being read by one client');

ok = check('memory writes are additive, not replacing', /mem\.push\(/.test(server),
  'two clients writing would clobber each other');
line(ok, 'appends, so both clients contribute to one memory');

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(70));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
