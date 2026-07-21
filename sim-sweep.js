'use strict';
/* sim-sweep.js — the final pass: everything at once.
 *
 * Fifteen suites each prove one area works. None of them can see the thing
 * that actually breaks a system this size: a fix in one place quietly
 * invalidating an assumption in another.
 *
 * Thirty-odd batches were built without a single deploy. Several bugs found
 * late in that run were introduced by an earlier batch in the same run — the
 * invented localStorage keys, the Thai voice, the mic contention. So this
 * sweep looks specifically for the shapes those bugs had:
 *
 *   ORPHANS      — something referenced that nothing provides
 *   DUPLICATES   — two implementations of one idea, drifting apart
 *   UNBOUNDED    — a store or list nothing trims
 *   UNSPOKEN     — a failure the user can't hear
 *   UNGUARDED    — a write with no confirmation, a route with no auth
 *   CONTRADICTED — two places disagreeing about the same fact
 *
 * Run: node sim-sweep.js
 */

const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const app = fs.readFileSync('app.html', 'utf8');
const caldav = fs.readFileSync('caldav.js', 'utf8');

let pass = 0, fail = 0;
const problems = [];
function check(name, ok, why) {
  if (ok) { pass++; return true; }
  fail++; problems.push(`${name}${why ? ' — ' + why : ''}`);
  return false;
}
function line(ok, text, extra) { console.log(`  ${ok ? '✓' : '✗'} ${text}${extra ? '  ' + extra : ''}`); }

console.log('');
console.log('  CROSS-MODULE SWEEP — THE WHOLE ECOSYSTEM AT ONCE');
console.log('  ' + '='.repeat(70));

/* --- 1. orphans: referenced but never provided -------------------------- */
console.log('');
console.log('  1. ORPHANS — REFERENCED BUT NOTHING PROVIDES IT');
console.log('  ' + '-'.repeat(70));
{
  // The exact shape of the buddy_cc / buddy_cc2 bug: a key read forever,
  // written never, silently falling back to a wrong default.
  const read = new Set([...app.matchAll(/localStorage\.getItem\(['"](buddy_\w+)['"]\)/g)].map(m => m[1]));
  const written = new Set([
    ...[...app.matchAll(/localStorage\.setItem\(['"](buddy_\w+)['"]/g)].map(m => m[1]),
    ...[...app.matchAll(/localStorage\.(buddy_\w+)\s*=/g)].map(m => m[1]),
    ...[...app.matchAll(/localStorage\[['"](buddy_\w+)['"]\]\s*=/g)].map(m => m[1]),
  ]);
  const ALLOWED = new Set(['buddy_url', 'buddy_tok', 'buddy_home_dial']);
  const orphans = [...read].filter(k => !written.has(k) && !ALLOWED.has(k));
  let ok = check('no storage key is read but never written', orphans.length === 0, orphans.join(', '));
  line(ok, `${read.size} keys read, ${orphans.length} orphaned`);

  // Server helpers referenced from anywhere must exist.
  const called = new Set([...server.matchAll(/\b(recallFor|profileOf|flagsOf|uidOf|saveStore|dlog|callClaude|checkImage|safeEqual|writeStoreNow)\s*\(/g)].map(m => m[1]));
  const declared = [...called].filter(fn => new RegExp(`function ${fn}\\b`).test(server));
  ok = check('every core helper called is declared', declared.length === called.size,
    [...called].filter(f => !declared.includes(f)).join(', '));
  line(ok, `${called.size} helpers referenced, all defined`);

  // Every CAL.* the server uses must be exported by caldav.js.
  const calUsed = [...new Set([...server.matchAll(/CAL\.(\w+)/g)].map(m => m[1]))];
  const calExported = caldav.slice(caldav.indexOf('module.exports'));
  const calMissing = calUsed.filter(f => !calExported.includes(f));
  ok = check('every CAL method used is exported', calMissing.length === 0, calMissing.join(', '));
  line(ok, `${calUsed.length} CalDAV methods used, all exported`);
}

/* --- 2. duplicates: two implementations of one idea --------------------- */
console.log('');
console.log('  2. DUPLICATES — TWO IMPLEMENTATIONS, ONE IDEA');
console.log('  ' + '-'.repeat(70));
{
  // findFlights and findFoodWith each hardcoded a provider outside the vendor
  // registry. Both were caught; nothing else should reintroduce the pattern.
  // Count only in LIVE code — the comment explaining that a hardcoded link was
  // removed would otherwise trip the check that the removal created.
  const appCode = app.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const hardcoded = [
    ['food.grab.com only in the registry', (appCode.match(/food\.grab\.com/g) || []).length <= 1],
    ['google flights only in the registry', (appCode.match(/google\.com\/travel\/flights/g) || []).length <= 1],
    ['no second vendor render loop', (appCode.match(/vendorScore\(b\.id\)-vendorScore\(a\.id\)/g) || []).length <= 1],
  ];
  for (const [label, ok] of hardcoded) {
    check(label, ok, 'a provider bolted on outside the registry misses vendor scoring');
    line(ok, label);
  }

  // One route table, one skill list — anything else drifts.
  const routeDefs = [...server.matchAll(/app\.post\("(\/[^"]+)"/g)].map(m => m[1]);
  const dupes = routeDefs.filter((r, i) => routeDefs.indexOf(r) !== i);
  const ok = check('no route is defined twice', dupes.length === 0, [...new Set(dupes)].join(', '));
  line(ok, `${routeDefs.length} POST routes, ${dupes.length} duplicated`);

  // The ctx object: a duplicate key silently discards one of them.
  const ctxStart = server.indexOf('const ctx = {');
  const ctxBody = server.slice(ctxStart, server.indexOf('};', ctxStart));
  const keys = [...ctxBody.matchAll(/^\s{6}(\w+):/gm)].map(m => m[1]);
  const ctxDupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  const ok2 = check('no duplicate key in the chat context', ctxDupes.length === 0, ctxDupes.join(', '));
  line(ok2, `${keys.length} context slots, ${ctxDupes.length} duplicated`);
}

/* --- 3. unbounded: anything that grows forever -------------------------- */
console.log('');
console.log('  3. UNBOUNDED — WHAT GROWS FOREVER');
console.log('  ' + '-'.repeat(70));
{
  const perUser = [...new Set([...server.matchAll(/STORE\.(\w+)\[uid\]/g)].map(m => m[1]))];
  const unbounded = [];
  for (const k of perUser) {
    // Find every write site and look for a trim nearby.
    const sites = [...server.matchAll(new RegExp(`STORE\\.${k}\\[uid\\]`, 'g'))].map(m => m.index);
    const isArray = new RegExp(`STORE\\.${k}\\[uid\\]\\s*=\\s*STORE\\.${k}\\[uid\\]\\s*\\|\\|\\s*\\[\\]`).test(server);
    const isObject = new RegExp(`STORE\\.${k}\\[uid\\]\\s*=\\s*STORE\\.${k}\\[uid\\]\\s*\\|\\|\\s*\\{\\}`).test(server);
    if (!isArray && !isObject) continue;   // scalar, self-bounding
    const trimmed = sites.some(i => {
      // Wide enough to see a prune that lives near the write but not adjacent
      // to it — calPrefs is trimmed in the discovery path, a little downstream.
      const near = server.slice(Math.max(0, i - 900), i + 1800);
      return /while\s*\([\w.]+\.length\s*>/.test(near) || /\.length = /.test(near)
          || /\.slice\(0,\s*\d+\)/.test(near) || /trim\w+\(uid\)/.test(near)
          // An object keyed by something external is bounded by pruning
          // against what still exists, not by a length cap.
          || /delete prefs\[id\]|delete jobs\[/.test(near)
          // A named trim function called at the write site counts too —
          // demanding the loop be inline would just reward copy-paste.
          || /trim[A-Z]\w*\(uid\)/.test(near);
    });
    if (!trimmed) unbounded.push(`${k}(${isArray ? 'array' : 'object'})`);
  }
  const ok = check('every growing per-user store is trimmed', unbounded.length === 0, unbounded.join(', '));
  line(ok, `${perUser.length} per-user stores, ${unbounded.length} unbounded`);

  // In-memory structures outside STORE need their own sweep.
  const ok2 = check('rooms are swept when idle', /ROOM_IDLE_MS/.test(server) && /delete rooms\[k\]/.test(server));
  line(ok2, 'abandoned rooms and typos are cleared');

  const ok3 = check('rate-limit maps are swept', /_authFails\.delete|_callRate\.delete/.test(server),
    'the maps would grow one entry per IP forever');
  line(ok3, 'auth and rate maps are housekept');
}

/* --- 4. unspoken: a failure he cannot hear ------------------------------ */
console.log('');
console.log('  4. UNSPOKEN — A FAILURE HE CANNOT HEAR');
console.log('  ' + '-'.repeat(70));
{
  const marks = [...server.matchAll(/app\.post\("(\/[^"]+)"/g)].map(m => ({ at: m.index, p: m[1] }));
  marks.push({ at: server.length, p: 'END' });
  const hard = [];
  for (let i = 0; i < marks.length - 1; i++) {
    if (marks[i].p === '/v1/chat/completions') continue;   // OpenAI shim, 502 is correct
    let b = server.slice(marks[i].at, marks[i + 1].at);
    const cut = b.search(/\n(?:async function|function|const)\s/);
    if (cut > 0) b = b.slice(0, cut);
    if (/res\.status\(502\)/.test(b)) hard.push(marks[i].p);
  }
  const ok = check('no endpoint answers failure with a bare 502', hard.length === 0, hard.join(', '));
  line(ok, `${hard.length} unspeakable failures`);

  // Timeouts everywhere that touches the network.
  const ok2 = check('the Claude gateway is bounded', /CLAUDE_TIMEOUT_MS/.test(server));
  line(ok2, 'model calls cannot hang a watcher');
  const ok3 = check('CalDAV and ICS are bounded', /DAV_TIMEOUT_MS/.test(caldav));
  line(ok3, 'a hung calendar cannot stall the sweep');
  const ok4 = check('watcher fetches are bounded', /AbortController/.test(server.slice(server.indexOf('function watchFetch'), server.indexOf('function watchFetch') + 700)));
  line(ok4, 'a hung watch cannot block the hour');
}

/* --- 5. unguarded: writes and routes ------------------------------------ */
console.log('');
console.log('  5. UNGUARDED — WRITES AND ROUTES');
console.log('  ' + '-'.repeat(70));
{
  const QUERY_OK = new Set(['/v1/selftest', '/routecheck', '/perf']);
  const routes = [...server.matchAll(/app\.(get|post)\("(\/[^"]+)"/g)].map(m => ({ at: m.index, p: m[2] }));
  const unguarded = routes.filter(r => {
    if (r.p === '/ping') return false;
    const head = server.slice(r.at, r.at + 160);
    if (head.includes('requireAuth')) return false;
    if (QUERY_OK.has(r.p)) return !/safeEqual\(req\.query\.tok/.test(server.slice(r.at, r.at + 400));
    return true;
  });
  const ok = check('every route is authenticated', unguarded.length === 0, unguarded.map(r => r.p).join(', '));
  line(ok, `${routes.length} routes, ${unguarded.length} unguarded`);

  // Anything that writes to a SHARED list needs a read-back — four of his
  // lists are his wife's.
  const prepIdx = server.indexOf('"/calendar/tick/prepare"');
  const prepBody = server.slice(prepIdx, server.indexOf('app.post("/calendar/tick/confirm"'));
  const ok2 = check('ticking off is two-step', !prepBody.includes('completeTodo('),
    'a mis-parse would tick items off her list with no confirmation');
  line(ok2, 'prepare never writes');

  const ok3 = check('the advisor never acts', !/mem\.push\(|saveStore\(|callClaude\(/.test(
    server.slice(server.indexOf('const ADVISORS = ['), server.indexOf('const ALTERNATIVE_PROMPT'))),
    'it would act on a guess');
  line(ok3, 'advisors are pure reads');
}

/* --- 6. contradictions: two places disagreeing -------------------------- */
console.log('');
console.log('  6. CONTRADICTIONS — TWO PLACES DISAGREEING');
console.log('  ' + '-'.repeat(70));
{
  // Declared skills vs dispatched skills — the contract that keeps voice working.
  const i = server.indexOf('const ROUTER_SKILLS'), j = server.indexOf('const VALID_SKILLS');
  fs.writeFileSync('/tmp/_sweep_sk.js', server.slice(i, j) + '\nmodule.exports={ROUTER_SKILLS};');
  const declared = [...require('/tmp/_sweep_sk.js').ROUTER_SKILLS.matchAll(/"(\w+)" \(/g)].map(m => m[1]);
  const dispatched = new Set([...app.matchAll(/skill===\s*'(\w+)'/g)].map(m => m[1]));
  const undispatched = declared.filter(s => s !== 'chat' && !dispatched.has(s));
  const undeclared = [...dispatched].filter(s => !declared.includes(s));
  let ok = check('every declared skill is dispatched', undispatched.length === 0, undispatched.join(', '));
  line(ok, `${declared.length} skills declared`);
  // texts/text were merged into readtexts/sendtext in batch 117. Their dispatch
  // branches remain as harmless back-compat for a cached app.html, so they are
  // not contradictions — but anything ELSE undeclared would be.
  const MERGED_ALIASES = new Set(['texts', 'text']);
  const realUndeclared = undeclared.filter(s => !MERGED_ALIASES.has(s));
  ok = check('nothing is dispatched that was never declared', realUndeclared.length === 0, realUndeclared.join(', '));
  line(ok, `${dispatched.size} dispatch branches`);

  // Every api() path the app calls must be a real route.
  const called = [...new Set([...app.matchAll(/api\(\s*'(\/[^']+)'/g)].map(m => m[1]))];
  const routeSet = new Set([...server.matchAll(/app\.(?:get|post)\("(\/[^"]+)"/g)].map(m => m[1]));
  const dead = called.filter(p => !routeSet.has(p.split('?')[0]));
  ok = check('every api() call resolves to a route', dead.length === 0, dead.join(', '));
  line(ok, `${called.length} endpoints called by the app`);

  // Every tile must have a live handler.
  const tiles = [...new Set([...app.matchAll(/class="tile"[^>]*onclick="(\w+)\(/g)].map(m => m[1]))];
  const deadTiles = tiles.filter(fn => !new RegExp(`(async\\s+)?function\\s+${fn}\\s*\\(|(const|let|var)\\s+${fn}\\s*=`).test(app));
  ok = check('no dead tiles', deadTiles.length === 0, deadTiles.join(', '));
  line(ok, `${tiles.length} tile handlers, all live`);

  // Colour themes and background art must not share an attribute.
  const colour = new Set([...app.matchAll(/html\[data-theme="([a-z-]+)"\]/g)].map(m => m[1]));
  const bg = new Set([...app.matchAll(/html\[data-bg="([a-z-]+)"\]/g)].map(m => m[1]));
  const clash = [...colour].filter(t => bg.has(t));
  ok = check('themes and backgrounds stay on separate attributes', clash.length === 0, clash.join(', '));
  line(ok, `${colour.size} colour themes, ${bg.size} backgrounds, no overlap`);
}

/* --- 7. the whole-system invariants ------------------------------------- */
console.log('');
console.log('  7. INVARIANTS THAT MUST HOLD ACROSS EVERYTHING');
console.log('  ' + '-'.repeat(70));
{
  const INVARIANTS = [
    ['every model endpoint can be spoken', () => {
      const marks = [...server.matchAll(/app\.post\("(\/[^"]+)"/g)].map(m => ({ at: m.index, p: m[1] }));
      marks.push({ at: server.length, p: 'END' });
      const SILENT = new Set(['/route', '/lifelog', '/pending', '/keys', '/memory', '/profile', '/state']);
      for (let i = 0; i < marks.length - 1; i++) {
        let b = server.slice(marks[i].at, marks[i + 1].at);
        const cut = b.search(/\n(?:async function|function|const)\s/);
        if (cut > 0) b = b.slice(0, cut);
        if (/callClaude/.test(b) && !SILENT.has(marks[i].p) && !/spoken/.test(b)) return false;
      }
      return true;
    }, 'a native client would need per-endpoint field mappings'],

    ['every advice endpoint refuses to invent', () => ['/places', '/stay', '/scamcheck', '/gooddeal', '/planday', '/findfood']
      .every(r => { const i = server.indexOf(`"${r}"`); return i > -1 &&
        /NO_INVENT|NO_FALSE_COMFORT|never invent/i.test(server.slice(i, server.indexOf('app.post(', i + 10))); }),
      'a confidently invented price is something he would act on'],

    ['every per-user store survives a new phone', () => {
      const bStart = server.indexOf('const buckets');
      const rec = new Set([...server.slice(bStart, server.indexOf(']', bStart)).matchAll(/"(\w+)"/g)].map(m => m[1]));
      return [...new Set([...server.matchAll(/STORE\.(\w+)\[uid\]/g)].map(m => m[1]))].every(k => rec.has(k));
    }, 'a store added later would be silently lost on recovery'],

    ['the store cannot be destroyed by a crash', () => /renameSync\(STORE_TMP/.test(server) && /fsyncSync/.test(server),
      'a half-written file resets everything he told Vision'],

    ['a deploy cannot eat the last save', () => /process\.on\("SIGTERM"/.test(server)],

    ['every navigation path speaks and opens a map', () => ['navigateWith', 'getUnlost', 'backToSpot', 'findNearby', 'meetMiddle']
      .every(fn => { const i = app.indexOf(`function ${fn}`); if (i === -1) return true;
        let d = 0, j = i; for (let k = i; k < app.length; k++) { if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) { j = k; break; } } }
        const b = app.slice(i, j); return /openMaps\(|navigateWith\(/.test(b) && /say\(/.test(b); }),
      'directions he cannot follow'],

    ['schedulers cannot stack or collide', () => /function once\(/.test(server) && /OFFSET/.test(server)],

    ['the model gateway retries transient failures', () => /RETRYABLE/.test(server) && /retry-after/.test(server)],

    ['nothing writes to a shared list without a read-back', () => /needsConfirmation/.test(server)],

    ['a stale partner fix is spoken in the past tense', () => /WAS about/.test(app),
      'he would walk to where she was'],
  ];
  for (const [label, fn, why] of INVARIANTS) {
    let ok = false;
    try { ok = fn() === true; } catch (e) { ok = false; }
    check(label, ok, why);
    line(ok, label);
    if (!ok && why) console.log(`      ⚠ ${why}`);
  }
}

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(70));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
