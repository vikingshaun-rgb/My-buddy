'use strict';
/* audit-109.js — contract checks across server.js + app.html */
const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const app = fs.readFileSync('app.html', 'utf8');

let fail = 0, pass = 0;
const bad = [];
function check(name, cond, detail) {
  if (cond === true) { pass++; return; }
  fail++; bad.push(`${name}${detail ? ' — ' + detail : ''}`);
}

/* 1. Every api('/path') the app calls must exist as a server route ------- */
const apiPaths = [...app.matchAll(/api\(\s*'(\/[^']+)'/g)].map(m => m[1]);
const routes = new Set([...server.matchAll(/app\.(get|post)\(\s*"(\/[^"]+)"/g)].map(m => m[2]));
const unresolved = [...new Set(apiPaths)].filter(p => !routes.has(p.split('?')[0]));
check('all api() paths resolve to a route', unresolved.length === 0, unresolved.join(', '));

/* 2. Every onclick in markup must name a defined function ---------------- */
// Inline conditionals (onclick="if(...)") are markup, not handler names.
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'try', 'do']);
const onclicks = [...new Set([...app.matchAll(/onclick="(\w+)\(/g)].map(m => m[1]))].filter(f => !KEYWORDS.has(f));
const deadHandlers = onclicks.filter(fn => {
  const re = new RegExp(`(async\\s+)?function\\s+${fn}\\s*\\(|(const|let|var)\\s+${fn}\\s*=`);
  return !re.test(app);
});
check('no dead onclick handlers', deadHandlers.length === 0, deadHandlers.join(', '));

/* 3. Every skill the router can emit must be dispatched somewhere -------- */
// Scan the ROUTER_SKILLS constant itself rather than a range between two
// markers — batch 116 inserted the hierarchical router between them, so the
// old range swallowed unrelated prompt text and reported phantom skills.
const rsStart = server.indexOf('const ROUTER_SKILLS');
const routerBlock = server.slice(rsStart, server.indexOf('const VALID_SKILLS', rsStart));
const declared = [...new Set([...routerBlock.matchAll(/\\"(\w+)\\"\s*\(/g)].map(m => m[1]))];
const dispatched = new Set([...app.matchAll(/skill===\s*'(\w+)'/g)].map(m => m[1]));
// 'chat' is the deliberate fallthrough — it has no dispatch branch by design.
const undispatched = declared.filter(s => s !== 'chat' && !dispatched.has(s));
check('every declared skill is dispatched', undispatched.length === 0, undispatched.join(', '));

/* 4. No per-user STORE key may be left out of profile recovery ----------- */
const storeKeys = [...new Set([...server.matchAll(/STORE\.(\w+)\s*=\s*STORE\.\1\s*\|\|\s*\{\}/g)].map(m => m[1]))];
const perUserWrites = [...new Set([...server.matchAll(/STORE\.(\w+)\[uid\]/g)].map(m => m[1]))];
const recoveryLine = server.slice(server.indexOf('const buckets'), server.indexOf('const buckets') + 700);
const recovered = new Set([...recoveryLine.matchAll(/"(\w+)"/g)].map(m => m[1]));
const missingFromRecovery = perUserWrites.filter(k => !recovered.has(k));
check('no per-user store key is left out of recovery', missingFromRecovery.length === 0, missingFromRecovery.join(', '));

/* 5. New endpoints must be auth-guarded ---------------------------------- */
const newRoutes = ['/converse/turn', '/converse/save', '/converse/phrases', '/converse/history', '/calendar/sources', '/calendar/prefs', '/calendar/day', '/calendar/list',
  '/calendar/tick/prepare', '/calendar/tick/confirm', '/calendar/add', '/calendar/event',
  '/calendar/free', '/calendar/check', '/job/report', '/job/capture', '/job/recall'];
const unguarded = newRoutes.filter(r => {
  const i = server.indexOf(`"${r}"`);
  return i === -1 || !server.slice(i, i + 120).includes('requireAuth');
});
check('every new route requires auth', unguarded.length === 0, unguarded.join(', '));

/* 6. Writes must never happen without a confirmation step ---------------- */
check('tick/confirm is a separate route from tick/prepare',
  routes.has('/calendar/tick/prepare') && routes.has('/calendar/tick/confirm'));
const prepIdx = server.indexOf('"/calendar/tick/prepare"');
const prepBody = server.slice(prepIdx, server.indexOf('app.post("/calendar/tick/confirm"'));
check('tick/prepare never calls completeTodo', !prepBody.includes('completeTodo('));

/* 7. New briefs must be wired into the persona --------------------------- */
check('calendarBrief is defined', /function calendarBrief/.test(server));
check('jobBrief is defined', /function jobBrief/.test(server));
check('calendar brief reaches the persona', /ctx\.calendar/.test(server));
check('jobs brief reaches the persona', /ctx\.jobs/.test(server));
check('briefs are populated in /chat ctx', /calendar:\s*calendarBrief/.test(server) && /jobs:\s*jobBrief/.test(server));

/* 8. No duplicate keys in the chat ctx object ---------------------------- */
const ctxStart = server.indexOf('const ctx = {');
const ctxBody = server.slice(ctxStart, server.indexOf('};', ctxStart));
const ctxKeys = [...ctxBody.matchAll(/^\s{6}(\w+):/gm)].map(m => m[1]);
const dupes = ctxKeys.filter((k, i) => ctxKeys.indexOf(k) !== i);
check('no duplicate keys in chat ctx', dupes.length === 0, dupes.join(', '));

/* 8b. GUI contracts (batch 118 audit) ------------------------------------- */
// A tile that sits silent during a slow call reads as broken, and the user
// taps again — firing a second request. Every tile that reaches the network
// must show something first.
const NETWORK_TILES = ['myDay', 'showList', 'tickOff', 'addToList', 'jobReport',
  'jobCapture', 'jobRecall', 'calendarPicker', 'convoPhrasebook', 'convoHistory'];
for (const fn of NETWORK_TILES) {
  const i = app.indexOf(`function ${fn}`);
  if (i === -1) { check(`${fn} exists`, false); continue; }
  let d = 0, j = i;
  for (let k = i; k < app.length; k++) {
    if (app[k] === '{') d++;
    else if (app[k] === '}') { d--; if (d === 0) { j = k; break; } }
  }
  const body = app.slice(i, j);
  if (!/api\(/.test(body)) continue; // doesn't hit the network
  check(`${fn} shows something while waiting`,
    /addMsg\([^)]*(Checking|Reading|Looking|Matching|Writing|Saving|Thinking|…)/.test(body) || /_wait/.test(body),
    'calls the server with no visible loading state');
  check(`${fn} survives a failed call`, /\.catch\(/.test(body), 'no catch on the api call');
}

// Every tile must be reachable — a tile with a handler that no longer exists
// is a dead button the user will keep pressing.
const tileHandlers = [...new Set([...app.matchAll(/class="tile"[^>]*onclick="(\w+)\(/g)].map(m => m[1]))];
const deadTiles = tileHandlers.filter(fn => {
  const re = new RegExp(`(async\\s+)?function\\s+${fn}\\s*\\(|(const|let|var)\\s+${fn}\\s*=`);
  return !re.test(app);
});
check('no dead tiles', deadTiles.length === 0, deadTiles.join(', '));
check('every tile has a handler',
  (app.match(/class="tile"/g) || []).length === (app.match(/class="tile"[^>]*onclick=/g) || []).length,
  'some tiles have no onclick at all');

/* 8c. Theme system (batch 119 audit) -------------------------------------- */
// Two independent theme families used to write the SAME data-theme attribute:
// the colour palette and the background artwork. applyLooks() runs on load
// after applyTheme(), so picking a colour looked fine until the next refresh
// wiped it. They must stay on separate attributes.
const colourThemes = [...new Set([...app.matchAll(/html\[data-theme="([a-z-]+)"\]/g)].map(m => m[1]))];
const bgThemes = [...new Set([...app.matchAll(/html\[data-bg="([a-z-]+)"\]/g)].map(m => m[1]))];
const clash = colourThemes.filter(t => bgThemes.includes(t));
check('colour themes and backgrounds use separate attributes', clash.length === 0, `both claim: ${clash.join(', ')}`);
check('background art is on data-bg', bgThemes.length >= 10, `only ${bgThemes.length} background themes found`);
check('colour palettes are on data-theme', colourThemes.length >= 8, `only ${colourThemes.length} colour themes found`);
// Every colour theme must actually define the variables the UI reads.
for (const t of colourThemes) {
  const rule = new RegExp(`html\\[data-theme="${t}"\\]\\{[^}]*--midnight`);
  check(`colour theme "${t}" defines its palette`, rule.test(app), 'no --midnight variable');
}
// applyLooks must not touch data-theme, or the collision returns.
const looksIdx = app.indexOf('function applyLooks');
if (looksIdx > -1) {
  let d = 0, end = looksIdx;
  for (let k = looksIdx; k < app.length; k++) {
    if (app[k] === '{') d++;
    else if (app[k] === '}') { d--; if (d === 0) { end = k; break; } }
  }
  const looksBody = app.slice(looksIdx, end);
  check('applyLooks never writes data-theme', !/setAttribute\(['"]data-theme/.test(looksBody),
    'background setter is overwriting the colour palette again');
}

/* 8d. Image pipeline (batch 120 audit) ------------------------------------ */
// Eight endpoints accept images. Four had no size check, so an oversized photo
// travelled all the way to Anthropic before rejection — the user waits out a
// slow upload and hears "my brain hiccuped".
const IMAGE_ROUTES = ['/vision', '/allergy', '/landmark', '/receipt', '/menu', '/moment', '/job/capture'];
for (const r of IMAGE_ROUTES) {
  const i = server.indexOf(`app.post("${r}"`);
  if (i === -1) { check(`${r} exists`, false); continue; }
  const j = server.indexOf('app.post(', i + 10);
  const body = server.slice(i, j > 0 ? j : undefined);
  const bounded = /checkImage\(|\.length\s*[<>]|slice\(0,\s*\d/.test(body);
  check(`${r} bounds the image it accepts`, bounded, 'no size or validity check before sending to the model');
}
check('checkImage is defined', /function checkImage/.test(server));
check('image size ceiling is set', /IMG_MAX_B64/.test(server));

// The client must never hand a bare split() result to the server — an empty
// downscale becomes the string "undefined" masquerading as a photo.
check('client unwraps images through one guarded helper',
  /async function imageForUpload/.test(app), 'no imageForUpload helper');
const rawSplits = [...app.matchAll(/shrinkImage\([^)]*\)[^;]{0,40}\.split\(','\)/g)];
check('no caller splits a shrinkImage result directly', rawSplits.length === 0,
  `${rawSplits.length} caller(s) still unwrap without checking`);
// A failed decode must always release its blob URL.
const shrinkIdx = app.indexOf('function shrinkImage');
if (shrinkIdx > -1) {
  const body = app.slice(shrinkIdx, shrinkIdx + 2200);
  check('shrinkImage releases the blob URL on failure too',
    (body.match(/revokeObjectURL/g) || []).length >= 1 && /finish\(/.test(body),
    'revoke only runs on success — every failed photo leaks');
}

/* 8e. Vendor / deep-link layer (batch 121 audit) --------------------------- */
// Deep links fail silently: a malformed URL still opens the app, just without
// the thing he asked for. Three real faults were found here, all invisible
// without actually tapping through.

// wa.me needs full international format. Stripping non-digits alone leaves the
// leading 0 on every Australian number — which is how they're all saved.
check('WhatsApp numbers are normalised, not just stripped',
  /function waNumber/.test(app), 'no waNumber() — local numbers will 404');
const rawWa = [...app.matchAll(/wa\.me\/[^`'"]*\$\{[^}]*replace\(\/\[\^0-9\]/g)];
check('no wa.me builder strips digits without normalising', rawWa.length === 0,
  `${rawWa.length} builder(s) still send local-format numbers`);

// A URL that attaches '?' to an optional param produces '…&foo=' when that
// param is absent, and vendors drop malformed params silently.
const condQuery = [...app.matchAll(/url:\s*\(q\)\s*=>\s*`[^`]*\$\{q\.\w+\?`\?/g)];
check('no vendor URL attaches "?" to an optional param', condQuery.length === 0,
  `${condQuery.length} builder(s) produce a malformed query when the first param is missing`);

// Every builder interpolates q.where; a blank one searches for "undefined".
const vhIdx = app.indexOf('async function vendorHandoff');
if (vhIdx > -1) {
  const body = app.slice(vhIdx, vhIdx + 900);
  check('vendorHandoff guards a blank destination',
    /String\(q\.where\)\.trim\(\)|!q\.where/.test(body),
    'a missing destination reaches the vendor as the word "undefined"');
}

// Batch 124: two localStorage keys were invented by a vendor builder and never
// written by anything (buddy_cc, buddy_cc2), so both silently fell through to
// a wrong default — WhatsApp assumed +61 for every number and GrabFood opened
// Singapore while he was in Hanoi. A key that is only ever READ is a bug.
const readKeys = [...new Set([...app.matchAll(/localStorage\.getItem\(['"](buddy_\w+)['"]\)/g)].map(m => m[1]))];
const writtenKeys = new Set([
  ...[...app.matchAll(/localStorage\.setItem\(['"](buddy_\w+)['"]/g)].map(m => m[1]),
  ...[...app.matchAll(/localStorage\.(buddy_\w+)\s*=/g)].map(m => m[1]),
  ...[...app.matchAll(/localStorage\[['"](buddy_\w+)['"]\]\s*=/g)].map(m => m[1]),
]);
// Deliberate: buddy_url/buddy_tok are legacy fallbacks behind ap_url/ap_tok
// (kept so an old install keeps working), and buddy_home_dial is an optional
// override with a correct default. These are patterns, not orphans.
const INTENTIONAL_DEFAULTS = new Set(['buddy_url', 'buddy_tok', 'buddy_home_dial']);
const orphanKeys = readKeys.filter(k => !writtenKeys.has(k) && !INTENTIONAL_DEFAULTS.has(k));
check('no localStorage key is read but never written', orphanKeys.length === 0,
  `${orphanKeys.join(', ')} — always falls back to a default`);

// A vendor category nobody calls is dead weight that looks like a feature.
// 'eat' sat unreachable from the day it was written — three vendors defined,
// no tile, no skill, no caller.
const catBlock = app.slice(app.indexOf('const VENDORS={'), app.indexOf('function vendorScore'));
const categories = [...new Set([...catBlock.matchAll(/^\s{4}(\w+):\s*\[/gm)].map(m => m[1]))];
check('vendor categories were found', categories.length >= 3, `only ${categories.length}`);
for (const cat of categories) {
  const reachable = app.includes(`vendorHandoff('${cat}'`) || app.includes(`vendorList('${cat}'`);
  check(`vendor category "${cat}" is reachable`, reachable, 'defined but nothing ever calls it');
}

// Deep links to native apps must fall back when the app isn't installed.
for (const scheme of ['grab://', 'uber://']) {
  const i = app.indexOf(scheme);
  if (i === -1) continue;
  const near = app.slice(i, i + 500);
  check(`${scheme} falls back when the app is missing`, /setTimeout\(/.test(near),
    'no fallback — the tap does nothing at all if the app is not installed');
}

/* 8f. Auth & secrets (batch 130 audit) ------------------------------------ */
// Every route must be guarded. The four that aren't check a token in the query
// string instead, because Safari can't set headers when he opens them by hand.
const allRoutes = [...server.matchAll(/app\.(get|post)\("(\/[^"]+)"/g)].map(m => ({ m: m[1], p: m[2], at: m.index }));
const QUERY_TOKEN_OK = new Set(['/v1/selftest', '/routecheck', '/perf']);
const authGaps = allRoutes.filter(r => {
  if (r.p === '/ping') return false;                    // returns the literal string "ok"
  const head = server.slice(r.at, r.at + 160);
  if (head.includes('requireAuth')) return false;
  if (QUERY_TOKEN_OK.has(r.p)) {
    const body = server.slice(r.at, r.at + 400);
    return !/safeEqual\(req\.query\.tok/.test(body);   // must still check, and in constant time
  }
  return true;
});
check('every route is authenticated', authGaps.length === 0, authGaps.map(r => r.p).join(', '));

// A leaked token must not mean an unlimited bill. His APP_SHARED_TOKEN has
// already been exposed in a chat and a screenshot once.
check('failed auth is rate limited', /_authFails/.test(server) && /AUTH_LOCK_MS/.test(server),
  'no lockout — a token can be guessed indefinitely');
check('authenticated calls are rate limited', /CALL_MAX/.test(server) && /rate limited/.test(server),
  'a leaked token means unlimited spend');
check('token comparison is constant-time', /timingSafeEqual/.test(server),
  'string compare short-circuits and leaks how much of a guess was right');
check('no query-token check uses a plain !==',
  !/req\.query\.tok \|\| ""\) !== APP_TOKEN/.test(server));

// CORS: * is harmless alone, but with a leaked token any page he visits could
// use his brain on his bill.
check('CORS is not wide open', !/Access-Control-Allow-Origin", "\*"\)/.test(server),
  'any website can call the backend from a browser');
check('allowed origins are configurable', /ALLOWED_ORIGINS/.test(server));

// Nothing that identifies a secret may appear in a response body.
const leaky = [...server.matchAll(/res\.(?:json|send)\(([^;]{0,300})/g)]
  .filter(m => /\b(APP_TOKEN|ANTHROPIC_API_KEY|ICLOUD_APP_PW|GMAPS_KEY|FLIGHT_KEY)\b/.test(m[1]));
check('no response body contains a secret', leaky.length === 0, `${leaky.length} response(s) reference a key`);
check('/keys never returns a stored value',
  !/res\.json\(\{[^}]*value:\s*STORE\.keys/.test(server), 'stored service keys are readable back');

/* 8g. Pending flows (batch 131 audit) ------------------------------------- */
// The app offers three answers to "how did that go?" — Done / Not yet /
// Didn't do it — but the server collapsed anything that wasn't done or
// abandoned into "done". Tapping "Not yet" therefore marked the flow COMPLETE,
// wrote a false "completed:" fact into the memory the brain uses to judge what
// he follows through on, and never asked again.
const pendBlock = server.slice(server.indexOf('if (action === "close" && id)'), server.indexOf('if (action === "nextstep"'));
check('"not yet" defers instead of completing', /outcome === "waiting"/.test(pendBlock),
  'a deferral is silently recorded as done');
check('a deferral writes nothing to memory',
  pendBlock.indexOf('mem.push(') > pendBlock.indexOf('return res.json({ ok: true, pending: p, deferred: true })'),
  'deferring writes a "completed" fact that never happened');
check('repeated deferrals eventually stop asking', /deferred >= 3/.test(pendBlock),
  'he can be asked the same question forever');

// Every state the app can send must be handled by name, not by fallthrough.
const appStates = [...new Set([...app.matchAll(/closePending\([^,]+,\s*[^?]*\?\s*'(\w+)'\s*:\s*[^?]*\?\s*'(\w+)'\s*:\s*'(\w+)'/g)]
  .flatMap(m => [m[1], m[2], m[3]]))];
for (const st of appStates) {
  check(`pending state "${st}" is handled explicitly`,
    new RegExp(`"${st}"`).test(pendBlock), 'falls through to another state');
}

// A flow must never be able to sit waiting forever.
check('flows lapse on a TTL', /function lapseFlows/.test(server) && /FLOW_TTL_MS/.test(server));
check('lapsing runs whenever the brief is built', /lapseFlows\(uid\);[\s\S]{0,200}state === "waiting"/.test(server),
  'expired flows keep appearing in the brief');
check('the pending list is bounded', /while \(list\.length > 20\) list\.shift\(\)/.test(server));

/* 8g. Navigation handover (batch 134 audit) -------------------------------- */
// Anything that names a real place must be one tap from turn-by-turn with
// voice. Speaking "the pho place on Hang Bac" and stopping leaves him to
// remember a name and type it into Maps — and getUnlost read out eight steps
// to someone who was actually lost, which is the worst version of it.
const NAV_FUNCS = ['navigateWith', 'getUnlost', 'backToSpot', 'findNearby', 'meetMiddle', 'rideHandoff'];
for (const fn of NAV_FUNCS) {
  const i = app.indexOf(`function ${fn}`);
  if (i === -1) continue;
  let d = 0, j = i;
  for (let k = i; k < app.length; k++) {
    if (app[k] === '{') d++;
    else if (app[k] === '}') { d--; if (d === 0) { j = k; break; } }
  }
  const body = app.slice(i, j);
  check(`${fn} hands over to Maps`, /openMaps\(|openAppleMaps\(|navigateWith\(/.test(body),
    'gives directions without opening a map');
  check(`${fn} speaks`, /say\(/.test(body), 'silent — useless hands-free');
}

// The handover itself must start NAVIGATION, not drop a marker. A marker means
// tap, then Directions, then pick a mode — three taps at the side of a road.
const omIdx = app.indexOf('function openMaps');
if (omIdx > -1) {
  const om = app.slice(omIdx, omIdx + 900);
  check('openMaps starts turn-by-turn, not a marker',
    /dir_action=navigate/.test(om) && /directionsmode/.test(om),
    'opens a pin the user must then press Directions on');
  check('openMaps tries the native app first', /comgooglemaps:\/\//.test(om),
    'web Maps has no voice guidance');
  check('openMaps falls back when the app is missing', /setTimeout\(/.test(om),
    'the tap does nothing if Google Maps is not installed');
}

// A dropped marker link anywhere is the old broken pattern.
const markerLinks = [...app.matchAll(/maps\.google\.com\/\?q=/g)];
check('no marker-only map links remain', markerLinks.length === 0,
  `${markerLinks.length} link(s) drop a pin instead of navigating`);

/* 9. Balanced braces in app.html script ---------------------------------- */
const scriptBody = app.slice(app.indexOf('<script>'), app.lastIndexOf('</script>'));
const opens = (scriptBody.match(/\{/g) || []).length;
const closes = (scriptBody.match(/\}/g) || []).length;
check('app.html braces balanced', opens === closes, `${opens} open / ${closes} close`);

/* 10. caldav module present and complete --------------------------------- */
check('caldav.js exists', fs.existsSync('caldav.js'));
const CALDAV = require('./caldav.js');
const needed = ['discover', 'readEvents', 'readTodos', 'readIcsFeed', 'gather', 'completeTodo',
  'addTodo', 'createEvent', 'prepareTickOff', 'matchList', 'matchItems', 'mergePrefs',
  'buildDayBrief', 'detectChanges', 'isFree', 'findSlots', 'similarity'];
const missingFns = needed.filter(f => typeof CALDAV[f] !== 'function');
check('caldav exports everything server.js uses', missingFns.length === 0, missingFns.join(', '));

console.log('');
console.log('  BATCH 147 AUDIT');
console.log('  ' + '-'.repeat(46));
if (bad.length) { for (const b of bad) console.log('  ✗ ' + b); }
console.log(fail
  ? `\n  ${fail} of ${pass + fail} contracts broken\n`
  : `  ${pass} passed, 0 failed  (contracts)\n`);
process.exit(fail ? 1 : 0);
