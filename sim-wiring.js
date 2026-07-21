'use strict';
/* sim-wiring.js — is it all actually plugged together?
 *
 * Twenty suites each prove a part works. This asks a different question: is
 * every part CONNECTED to the parts it needs? A module can pass its own tests
 * perfectly while being unreachable, or reachable but ignored by the brain, or
 * wired to a store nothing ever reads.
 *
 * The specific failures this looks for are the ones that don't announce
 * themselves:
 *
 *   ISLAND      a module nothing calls — passes its tests, never runs
 *   ONE-WAY     writes somewhere nothing reads, or reads what nothing writes
 *   UNHEARD     works, but the brain never learns it happened
 *   INVISIBLE   works, but he has no way to reach it
 *   FORGOTTEN   works, until he gets a new phone
 *
 * Run: node sim-wiring.js
 */

const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const app = fs.readFileSync('app.html', 'utf8');
const swift = fs.existsSync('VisionBrain.swift') ? fs.readFileSync('VisionBrain.swift', 'utf8') : '';

let pass = 0, fail = 0;
const problems = [];
function check(name, ok, why) {
  if (ok) { pass++; return true; }
  fail++; problems.push(`${name}${why ? ' — ' + why : ''}`);
  return false;
}
function line(ok, text, extra) { console.log(`  ${ok ? '✓' : '✗'} ${text}${extra ? '  ' + extra : ''}`); }

/* --- the pieces ---------------------------------------------------------- */
const SKILLS = (() => {
  const i = server.indexOf('const ROUTER_SKILLS'), j = server.indexOf('const VALID_SKILLS');
  fs.writeFileSync('/tmp/_wire.js', server.slice(i, j) + '\nmodule.exports={ROUTER_SKILLS};');
  return [...require('/tmp/_wire.js').ROUTER_SKILLS.matchAll(/"(\w+)" \(/g)].map(m => m[1]);
})();
const DISPATCHED = new Set([...app.matchAll(/skill===\s*'(\w+)'/g)].map(m => m[1]));
const ROUTES = [...new Set([...server.matchAll(/app\.(?:get|post)\("(\/[^"]+)"/g)].map(m => m[1]))];
const CALLED = new Set([...app.matchAll(/api\(\s*'(\/[^']+)'/g)].map(m => m[1]));
const TILES = [...new Set([...app.matchAll(/class="tile"[^>]*onclick="(\w+)\(/g)].map(m => m[1]))];

console.log('');
console.log('  WIRING — IS IT ALL PLUGGED TOGETHER?');
console.log('  ' + '='.repeat(70));
console.log(`  ${SKILLS.length} skills · ${ROUTES.length} routes · ${TILES.length} tiles`);

/* --- 1. can he actually reach everything? -------------------------------- */
console.log('');
console.log('  1. NOTHING IS UNREACHABLE');
console.log('  ' + '-'.repeat(70));
{
  const undispatched = SKILLS.filter(s => s !== 'chat' && !DISPATCHED.has(s));
  let ok = check('every skill has a dispatch branch', undispatched.length === 0, undispatched.join(', '));
  line(ok, `${SKILLS.length} skills declared`, `${undispatched.length} unreachable`);

  // A skill declared to the model but with no handler wastes a round trip and
  // lands on a generic answer — the user sees "it didn't understand".
  const MERGED = new Set(['texts', 'text']);   // deliberate back-compat aliases
  const undeclared = [...DISPATCHED].filter(s => !SKILLS.includes(s) && !MERGED.has(s));
  ok = check('nothing is dispatched that was never declared', undeclared.length === 0, undeclared.join(', '));
  line(ok, `${DISPATCHED.size} dispatch branches`);

  const deadTiles = TILES.filter(fn =>
    !new RegExp(`(async\\s+)?function\\s+${fn}\\s*\\(|(const|let|var)\\s+${fn}\\s*=`).test(app));
  ok = check('every tile has a live handler', deadTiles.length === 0, deadTiles.join(', '));
  line(ok, `${TILES.length} tiles`);

  const deadCalls = [...CALLED].filter(p => !ROUTES.includes(p.split('?')[0]));
  ok = check('every api() call resolves to a route', deadCalls.length === 0, deadCalls.join(', '));
  line(ok, `${CALLED.size} endpoints called by the app`);
}

/* --- 2. islands: built, tested, never called ---------------------------- */
console.log('');
console.log('  2. NO ISLANDS — BUILT, TESTED, NEVER CALLED');
console.log('  ' + '-'.repeat(70));
{
  // Every module added tonight, and the one thing that proves it is connected
  // rather than merely present.
  const MODULES = [
    ['calendar',     '/calendar/day',      'myday',       null],
    ['jobs',         '/job/report',        'jobreport',   null],
    ['conversation', '/converse/turn',     'talkto',      null],
    ['advisor',      '/advise',            'advise',      'attentionBrief'],
    ['attention',    '/attention/digest',  'digest',      'attentionBrief'],
    ['investigator', '/scene/capture',     'scan',        null],
    ['vendors',      null,                 'findstay',    null],
    ['rooms',        '/room',              'whereis',     null],
    ['watchers',     '/watchers',          'watcher',     null],
    ['recovery',     '/recover',           null,          null],
    ['native',       '/native/hello',      null,          null],
  ];
  for (const [name, route, skill, brainHook] of MODULES) {
    const bits = [];
    if (route && !ROUTES.includes(route)) bits.push(`${route} missing`);
    if (route && !CALLED.has(route) && !['/native/hello', '/recover'].includes(route)) {
      // /native/hello and /recover are called by Swift and Settings respectively.
      bits.push(`${route} exists but the app never calls it`);
    }
    if (skill && !SKILLS.includes(skill)) bits.push(`"${skill}" not declared`);
    if (skill && !DISPATCHED.has(skill)) bits.push(`"${skill}" not dispatched`);
    if (brainHook && !new RegExp(brainHook).test(server)) bits.push(`${brainHook} not wired to the brain`);
    const ok = check(`${name} is connected`, bits.length === 0, bits.join('; '));
    line(ok, name.padEnd(16), bits.length ? bits[0] : 'route + skill + dispatch');
  }
}

/* --- 3. one-way wiring: writes nothing reads ---------------------------- */
console.log('');
console.log('  3. NO ONE-WAY WIRING');
console.log('  ' + '-'.repeat(70));
{
  // A store written but never read is work thrown away; a store read but never
  // written silently falls back to a default forever. Both are invisible.
  const written = new Set([...server.matchAll(/STORE\.(\w+)\[uid\]\s*=/g)].map(m => m[1]));
  const read = new Set([
    ...[...server.matchAll(/\(STORE\.(\w+)\s*\|\|\s*\{\}\)\[uid\]/g)].map(m => m[1]),
    ...[...server.matchAll(/STORE\.(\w+)\[uid\]/g)].map(m => m[1]),
  ]);
  const writtenNeverRead = [...written].filter(k => {
    const direct = (server.match(new RegExp(`STORE\\.${k}\\b`, 'g')) || []).length;
    // Several stores are read through an accessor — flagsOf(), briefOf() —
    // rather than by repeating STORE.flags everywhere. Counting only direct
    // references calls a well-encapsulated store "never read", which is
    // exactly backwards.
    const singular = k.replace(/s$/, '');
    const viaAccessor = new RegExp(`function ${singular}Of\\b|function ${k}Of\\b`).test(server)
      && (server.match(new RegExp(`\\b${singular}Of\\(|\\b${k}Of\\(`, 'g')) || []).length > 1;
    return direct <= 2 && !viaAccessor;
  });
  let ok = check('no store is written but never read', writtenNeverRead.length === 0,
    `${writtenNeverRead.join(', ')} — work thrown away`);
  line(ok, `${written.size} per-user stores written`);

  // localStorage: the bug class that bit three times tonight.
  const lsRead = new Set([...app.matchAll(/localStorage\.getItem\(['"](buddy_\w+)['"]\)/g)].map(m => m[1]));
  const lsWritten = new Set([
    ...[...app.matchAll(/localStorage\.setItem\(['"](buddy_\w+)['"]/g)].map(m => m[1]),
    ...[...app.matchAll(/localStorage\.(buddy_\w+)\s*=/g)].map(m => m[1]),
  ]);
  const ALLOWED = new Set(['buddy_url', 'buddy_tok', 'buddy_home_dial']);
  const orphans = [...lsRead].filter(k => !lsWritten.has(k) && !ALLOWED.has(k));
  ok = check('no client key is read but never written', orphans.length === 0,
    `${orphans.join(', ')} — always falls back to a default`);
  line(ok, `${lsRead.size} client keys read`);
}

/* --- 4. does the brain learn what happened? ------------------------------ */
console.log('');
console.log('  4. THE BRAIN LEARNS WHAT HAPPENED');
console.log('  ' + '-'.repeat(70));
{
  // An action that leaves no trace is one Vision can never recall or reason
  // about later — it happened, and nothing knows.
  const SHOULD_REMEMBER = [
    ['/job/report',      'a job written up'],
    ['/job/capture',     'a job logged'],
    ['/scene/capture',   'a scene recorded'],
    ['/converse/save',   'a conversation kept'],
    ['/arrival',         'landing somewhere new'],
    ['/moment',          'a captured moment'],
  ];
  for (const [route, what] of SHOULD_REMEMBER) {
    const i = server.indexOf(`"${route}"`);
    const j = server.indexOf('app.post(', i + 10);
    const body = server.slice(i, j > 0 ? j : i + 5000);
    const ok = check(`${route} reaches memory`, /mem\.push\(/.test(body),
      `${what} would leave no trace`);
    line(ok, route.padEnd(18), what);
  }

  // And the brief must actually carry it into the next conversation.
  const ctxStart = server.indexOf('const ctx = {');
  const ctx = server.slice(ctxStart, server.indexOf('};', ctxStart));
  for (const slot of ['recall', 'calendar', 'jobs', 'advice', 'texts', 'pending']) {
    const ok = check(`the brief carries "${slot}"`, new RegExp(`${slot}:`).test(ctx),
      'the brain would not know about it in the next reply');
    line(ok, `brief slot: ${slot}`);
  }
}

/* --- 5. everything survives a new phone --------------------------------- */
console.log('');
console.log('  5. EVERYTHING SURVIVES A NEW PHONE');
console.log('  ' + '-'.repeat(70));
{
  const bStart = server.indexOf('const buckets');
  const recovered = new Set([...server.slice(bStart, server.indexOf(']', bStart)).matchAll(/"(\w+)"/g)].map(m => m[1]));
  const perUser = [...new Set([...server.matchAll(/STORE\.(\w+)\[uid\]/g)].map(m => m[1]))];
  const lost = perUser.filter(k => !recovered.has(k));
  const ok = check('every per-user store is recoverable', lost.length === 0,
    `${lost.join(', ')} — silently lost on a new device`);
  line(ok, `${perUser.length} stores`, `${recovered.size} in the recovery bucket`);
}

/* --- 6. the native contract still holds --------------------------------- */
console.log('');
console.log('  6. THE NATIVE CONTRACT STILL HOLDS');
console.log('  ' + '-'.repeat(70));
{
  // Every batch since 138 could have broken this without noticing, because
  // nothing in the web app depends on it.
  const marks = [...server.matchAll(/app\.post\("(\/[^"]+)"/g)].map(m => ({ at: m.index, p: m[1] }));
  marks.push({ at: server.length, p: 'END' });
  const SILENT = new Set(['/route', '/lifelog', '/pending', '/keys', '/memory', '/profile', '/state']);
  const mute = [];
  for (let i = 0; i < marks.length - 1; i++) {
    let b = server.slice(marks[i].at, marks[i + 1].at);
    const cut = b.search(/\n(?:async function|function|const)\s/);
    if (cut > 0) b = b.slice(0, cut);
    if (/callClaude/.test(b) && !SILENT.has(marks[i].p) && !/spoken/.test(b)) mute.push(marks[i].p);
  }
  let ok = check('every model endpoint still answers in words', mute.length === 0, mute.join(', '));
  line(ok, 'the thin-connector promise', `${mute.length} silent`);

  if (swift) {
    const mapped = [...swift.matchAll(/return "([a-z/]+)"/g)].map(m => m[1]);
    const missing = mapped.filter(m => !ROUTES.includes('/' + m));
    ok = check('every endpoint Swift maps to exists', missing.length === 0,
      `${missing.join(', ')} — a 404 on rented Mac time`);
    line(ok, `${mapped.length} Swift endpoint mappings`);

    // The handshake is how a native app learns the skill list without
    // hardcoding it — so it must be generated, not typed.
    ok = check('the handshake derives skills from the router', /ROUTER_SKILLS\.matchAll/.test(
      server.slice(server.indexOf('/native/hello'), server.indexOf('/native/hello') + 2000)),
      'a hardcoded list would go stale the moment a skill is added');
    line(ok, 'handshake reads the live skill list');
  }
}

/* --- 7. the newest modules, specifically -------------------------------- */
console.log('');
console.log('  7. TONIGHT\'S ADDITIONS, END TO END');
console.log('  ' + '-'.repeat(70));
{
  const CHAINS = [
    ['a scene capture is recallable months later',
      () => /mem\.push\(/.test(server.slice(server.indexOf('"/scene/capture"'), server.indexOf('"/scene/diff"')))],
    ['and a second visit compares against it',
      () => /scenesFor\(uid, place, coords\)/.test(server)],
    ['a site is matched by coordinates, not a typed name',
      () => /SAME_SITE_METRES/.test(server) && /sceneFix/.test(app)],
    ['the advisor feeds the attention gate, not the brief directly',
      () => /advice: attentionBrief/.test(server) && /function attentionBrief/.test(server)],
    ['the gate can hold things without losing them',
      () => /saved for your brief/.test(server)],
    ['a dismissal is remembered across a new phone',
      () => /"dismissed"/.test(server.slice(server.indexOf('const buckets'), server.indexOf('const buckets') + 900))],
    ['the night check uses his timezone, not the server\'s',
      () => /COUNTRY_TZ/.test(server)],
    ['job number flows from capture into the scene tools',
      () => /buddy_currentjob/.test(app) && /setItem\('buddy_currentjob'/.test(app)],
  ];
  for (const [label, fn] of CHAINS) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    check(label, ok, 'the chain is broken between two modules');
    line(ok, label);
  }
}

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(70));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
