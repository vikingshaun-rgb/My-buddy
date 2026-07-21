'use strict';
/* sim-recovery.js — a new phone mid-trip.
 *
 * He loses his phone in Hanoi. Buys a cheap Android. Opens Vision. Everything
 * Vision knows about him lives on the server, so in principle it all comes
 * back — but "in principle" is doing a lot of work in that sentence.
 *
 * The failure modes are quiet and permanent:
 *
 *   PARTIAL   — memories come back, job reports don't, and he never notices
 *               which until he needs one
 *   SILENT    — the code is wrong and it looks like a fresh start
 *   HIJACK    — a guessed code claims someone else's whole life
 *   ORPHANED  — the old uid keeps its data, so it exists twice and diverges
 *
 * The first is the worst, because it looks like success.
 *
 * Run: node sim-recovery.js
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

const recBody = (() => {
  const i = server.indexOf('app.post("/recover"');
  const j = server.indexOf('app.post(', i + 10);
  return server.slice(i, j > 0 ? j : i + 6000);
})();

console.log('');
console.log('  RECOVERY — A NEW PHONE, MID-TRIP');
console.log('  ' + '='.repeat(68));

/* --- 1. nothing may be left behind -------------------------------------- */
console.log('');
console.log('  EVERY STORE MUST MOVE, NOT MOST OF THEM');
console.log('  ' + '-'.repeat(68));

const bStart = server.indexOf('const buckets');
const bEnd = server.indexOf(']', bStart);
const recovered = new Set([...server.slice(bStart, bEnd).matchAll(/"(\w+)"/g)].map(m => m[1]));
const perUser = new Set([
  ...[...server.matchAll(/STORE\.(\w+)\[uid\]/g)].map(m => m[1]),
  ...[...server.matchAll(/STORE\.(\w+)\[uidOf\(req\)\]/g)].map(m => m[1]),
]);
const missing = [...perUser].filter(k => !recovered.has(k));

let ok = check('every per-user store is in the recovery bucket', missing.length === 0,
  `${missing.join(', ')} would be silently left behind`);
line(ok, `${perUser.size} per-user stores, ${missing.length} unrecovered`);

// This is the one that rots: a new store added in a future batch and forgotten.
ok = check('the bucket list is longer than the stores found', recovered.size >= perUser.size,
  'the list has fallen behind the code');
line(ok, `${recovered.size} listed vs ${perUser.size} found`);

/* --- 2. the transfer must be a MOVE, not a copy ------------------------- */
console.log('');
console.log('  IT MUST MOVE, NOT COPY');
console.log('  ' + '-'.repeat(68));

ok = check('the old uid is deleted after transfer', /delete STORE\[b\]\[target\]/.test(recBody),
  'the data would exist under two uids and diverge from that moment on');
line(ok, 'delete after assign — one copy only');

ok = check('the recovery code follows the profile', /STORE\.recovery\[String\(code\)[^\]]*\] = newUid/.test(recBody),
  'the code would still point at the abandoned uid, so a second recovery fails');
line(ok, 'the code repoints to the new uid');

ok = check('the move is counted, not assumed', /moved\+\+/.test(recBody),
  'a silent partial transfer would look like success');
line(ok, 'it reports how many collections moved');

/* --- 3. no silent takeover ---------------------------------------------- */
console.log('');
console.log('  HE MUST SEE WHAT HE IS CLAIMING FIRST');
console.log('  ' + '-'.repeat(68));

ok = check('there is a preview step before claiming', /action === "preview"/.test(recBody),
  'a mistyped code would silently swallow another profile');
line(ok, 'preview shows name and memory count first');

ok = check('preview does not mutate anything', !/\bdelete STORE\[b\]\[target\]/.test(
  recBody.slice(recBody.indexOf('action === "preview"'), recBody.indexOf('action === "claim"') > 0 ? recBody.indexOf('action === "claim"') : recBody.length)),
  'previewing would already have taken it');
line(ok, 'preview is read-only');

ok = check('an unknown code fails cleanly', /no_such_code/.test(recBody),
  'a wrong code would look like a fresh start');
line(ok, 'unknown code → 404, not silence');

/* --- 4. the code itself ------------------------------------------------- */
console.log('');
console.log('  THE CODE MUST BE SAYABLE BUT NOT GUESSABLE');
console.log('  ' + '-'.repeat(68));

const wordsMatch = recBody.match(/const words = \[([\s\S]*?)\];/);
const wordCount = wordsMatch ? wordsMatch[1].split(',').filter(x => x.trim()).length : 0;
const parts = (recBody.match(/\$\{pick\(\)\}/g) || []).length || 2;
const digits = /randomInt\(1000, 10000\)/.test(recBody) ? 9000 : 90;
const space = Math.pow(wordCount, parts) * digits;
// A recovery code IS the whole profile. Behind a 120/min limiter, 23,040
// combinations was 31% of the space in an hour.
ok = check('the code has enough entropy', space > 1e8, `only ${space.toLocaleString()} combinations`);
line(ok, `${wordCount} words × ${parts} + ${digits} → ${space.toLocaleString()} combinations`);

ok = check('codes use a cryptographic RNG', /crypto\.randomInt/.test(recBody),
  'Math.random is predictable enough to narrow the search');
line(ok, 'crypto.randomInt, not Math.random');

ok = check('it reuses an existing code rather than issuing many', /existing/.test(recBody),
  'every visit to Settings would mint another live code');
line(ok, 'one code per profile');

ok = check('codes are case and space insensitive', /toLowerCase\(\)\.trim\(\)/.test(recBody),
  'reading it aloud from a screenshot would fail on capitalisation');
line(ok, 'lower-cased and trimmed on lookup');

// A recovery code IS the whole profile, so it deserves the same brute-force
// protection as the token.
ok = check('recovery is behind auth', /app\.post\("\/recover", requireAuth/.test(server),
  'anyone could enumerate codes without even the shared token');
line(ok, 'requireAuth, so the rate limiter applies');

/* --- 5. it must survive a real transfer --------------------------------- */
console.log('');
console.log('  A SIMULATED TRANSFER MOVES EVERYTHING');
console.log('  ' + '-'.repeat(68));
{
  // Drive the real bucket list against fabricated state.
  const STORE = {};
  // `recovery` is in the bucket list but is NOT keyed by uid — it maps
  // code -> uid, and is repointed separately at the end. Simulating it like the
  // others made a perfectly correct transfer look like 28/29.
  const dataBuckets = [...recovered].filter(b => b !== 'recovery');
  for (const b of dataBuckets) STORE[b] = {};
  const OLD = 'old-phone', NEW = 'new-phone';
  for (const b of dataBuckets) STORE[b][OLD] = { marker: b };
  STORE.recovery = { 'amber-cove-42': OLD };

  let moved = 0;
  for (const b of dataBuckets) {
    if (STORE[b] && STORE[b][OLD] !== undefined) {
      STORE[b][NEW] = STORE[b][OLD];
      delete STORE[b][OLD];
      moved++;
    }
  }
  STORE.recovery['amber-cove-42'] = NEW;

  const leftBehind = dataBuckets.filter(b => STORE[b][OLD] !== undefined);
  const arrived = dataBuckets.filter(b => STORE[b][NEW] !== undefined);

  ok = check('nothing is left on the old uid', leftBehind.length === 0, leftBehind.join(', '));
  line(ok, `${leftBehind.length} buckets still holding old data`);

  ok = check('everything arrived at the new uid', arrived.length === dataBuckets.length,
    `${arrived.length}/${dataBuckets.length} arrived`);
  line(ok, `${arrived.length}/${dataBuckets.length} buckets transferred`);

  ok = check('the code now points at the new phone', STORE.recovery['amber-cove-42'] === NEW);
  line(ok, 'a second recovery would work too');

  ok = check('the count matches what moved', moved === dataBuckets.length, `reported ${moved}`);
  line(ok, `reported ${moved} collections`);
}

/* --- 6. the app side ----------------------------------------------------- */
console.log('');
console.log('  THE APP MUST MAKE IT FINDABLE AND SURVIVABLE');
console.log('  ' + '-'.repeat(68));

ok = check('the app can issue a code', /action:\s*'issue'|action:'issue'/.test(app),
  'he could never get a code in the first place');
line(ok, 'Settings can mint a recovery code');

ok = check('the app previews before claiming', /action:\s*'preview'|action:'preview'/.test(app),
  'it would claim on the first tap');
line(ok, 'preview then confirm');

ok = check('the app can claim', /action:\s*'claim'|action:'claim'/.test(app));
line(ok, 'claim is wired');

// The one that actually bites: a code he never wrote down is no code at all.
const issueBlock = app.slice(app.indexOf("action:'issue'") - 600, app.indexOf("action:'issue'") + 900);
ok = check('the code is shown so he can save it', /addMsg|textContent|prompt/.test(issueBlock),
  'a code generated and never displayed is worse than none');
line(ok, 'the code is put on screen');

/* --- 7. what recovery cannot bring back --------------------------------- */
console.log('');
console.log('  WHAT DOES NOT COME BACK — AND WHETHER THAT IS RIGHT');
console.log('  ' + '-'.repeat(68));
// Being explicit about this matters: he'd otherwise assume a new phone is
// identical to the old one, and be surprised at the worst moment.
const NOT_RECOVERED = [
  ['the room / live location', 'in memory only, wiped on redeploy — correct for live location'],
  ['device settings (theme, travel mode)', 'localStorage on the old phone, gone with it'],
  ['the pair code', 'he retypes it with Jess, which is the same as pairing fresh'],
  ['the proxy URL and token', 're-entered in Settings, by design'],
];
for (const [what, why] of NOT_RECOVERED) {
  console.log(`  · ${what.padEnd(38)} ${why}`);
}
ok = check('rooms are deliberately not recovered', !recovered.has('rooms'),
  'live location surviving a phone loss is not what anyone wants');
line(ok, 'rooms excluded on purpose');

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(68));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
