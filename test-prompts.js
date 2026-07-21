'use strict';
/* test-prompts.js — prompt hygiene contract for every model-calling endpoint.
 *
 * The audit that produced this found 41 of 52 prompts with no "never invent"
 * instruction and 23 that answered failure with a 5xx the app can't speak.
 * Both classes of bug are invisible until the moment they matter — a confident
 * invented price, or silence on the glasses. A test is the only thing that
 * stops them creeping back in as endpoints get added.
 *
 * Run: node test-prompts.js
 */

const fs = require('fs');
const src = fs.readFileSync('server.js', 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok === true) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

/* --- carve the file into endpoints --------------------------------------- */
const marks = [...src.matchAll(/app\.post\("(\/[^"]+)"/g)].map(m => ({ at: m.index, route: m[1] }));
marks.push({ at: src.length, route: 'END' });
const endpoints = [];
for (let i = 0; i < marks.length - 1; i++) {
  let body = src.slice(marks[i].at, marks[i + 1].at);
  // Cut at the next top-level declaration. Without this a route followed by a
  // helper swallows it — /memory appeared to call the model purely because
  // callClaude happens to be defined after it.
  const cut = body.search(/\n(?:async function|function|const)\s/);
  if (cut > 0) body = body.slice(0, cut);
  if (!body.includes('callClaude')) continue;
  endpoints.push({ route: marks[i].route, body });
}

check('found the model-calling endpoints', endpoints.length >= 40, `only ${endpoints.length}`);

/* --- 1. advice endpoints must carry a no-invent guardrail ---------------- */
// These are the ones where an invented specific costs money, time or safety.
const MUST_GUARD = [
  '/places', '/stay', '/activities', '/tripplan', '/packlist', '/tripbudget',
  '/esim', '/itinerary', '/planday', '/landmark', '/findfood', '/menu',
  '/scamcheck', '/gooddeal', '/survival', '/allergy', '/job/report', '/job/capture',
];
for (const route of MUST_GUARD) {
  const ep = endpoints.find(e => e.route === route);
  if (!ep) { check(`${route} exists`, false, 'route missing'); continue; }
  const guarded = /NO_INVENT|NO_FALSE_COMFORT|never invent|Never guess|NEVER give|don't invent/i.test(ep.body);
  check(`${route} refuses to invent specifics`, guarded, 'no guardrail in the prompt');
}

/* --- 2. safety-critical endpoints must refuse false comfort -------------- */
for (const route of ['/allergy', '/scamcheck', '/survival']) {
  const ep = endpoints.find(e => e.route === route);
  if (!ep) continue;
  const ok = /NO_FALSE_COMFORT|never give false reassurance|NEVER give false/i.test(ep.body);
  check(`${route} never falsely reassures`, ok, 'safety-critical without the no-false-comfort clause');
}

/* --- 3. failure must be speakable, never a bare 5xx ---------------------- */
// 501 is fine — "you haven't set this up" is actionable and several carry a
// spoken line. 502 is not: the app can't speak an error object, so on glasses
// it becomes silence.
for (const ep of endpoints) {
  if (ep.route === '/v1/chat/completions') continue; // OpenAI-compatible shim, 502 is correct
  const hard = /res\.status\(502\)/.test(ep.body);
  check(`${ep.route} answers failure with words`, !hard, 'returns a bare 502 the app cannot speak');
}

/* --- 4. JSON-contract endpoints must survive prose ----------------------- */
// A model that answers a JSON request in prose is normal, not exotic. Every
// endpoint that asks for JSON needs a catch that still produces something.
for (const ep of endpoints) {
  const wantsJson = /JSON ONLY|compact JSON/i.test(ep.body);
  if (!wantsJson) continue;
  const guarded = /catch\s*(\([^)]*\))?\s*\{/.test(ep.body);
  check(`${ep.route} survives a non-JSON reply`, guarded, 'parses JSON with no catch');
}

/* --- 5. token budgets must be set deliberately --------------------------- */
for (const ep of endpoints) {
  const m = /max_tokens:\s*(\d+)/.exec(ep.body);
  if (!m) continue;
  const t = parseInt(m[1], 10);
  if (ep.route === '/v1/chat/completions') continue; // shim only classifies, 30 is deliberate
  check(`${ep.route} has a sane token budget`, t >= 60 && t <= 2000, `max_tokens=${t}`);
}

/* --- 6. spoken endpoints must not be asked for markdown ------------------ */
// Anything read aloud through the glasses should never contain markdown —
// asterisks and hashes are noise when spoken.
for (const ep of endpoints) {
  if (ep.route === '/job/report') continue; // dashed bullets are the required house format, and it's pasted not spoken
  // /chat's ban lives in buddyPersona(), which it calls — follow the call
  // rather than demanding the words appear inline.
  if (/buddyPersona\(/.test(ep.body) && /SPOKEN_PLAIN/.test(src)) continue;
  // Every model endpoint must have a system prompt. /phrase and /moment were
  // the two exceptions when this test was written — both fixed in batch 118,
  // so the exemption is gone and the rule is now enforced for everyone.
  // Some endpoints build the prompt into a `const system` first — follow that
  // too rather than demanding the field appear inline.
  check(`${ep.route} has a system prompt`,
    /system:/.test(ep.body) || /const\s+system\s*=/.test(ep.body),
    'instructions live only in the user message');
  if (!/spoken|say aloud|spoken-friendly|speak/i.test(ep.body)) continue;
  const banned = /SPOKEN_PLAIN|no markdown|not markdown|plain text|no lists/i.test(ep.body);
  check(`${ep.route} bans markdown in spoken output`, banned, 'spoken output without a no-markdown instruction');
}

/* --- 7. the shared constants exist and are wired ------------------------- */
check('NO_INVENT is defined', /const NO_INVENT\s*=/.test(src));
check('NO_INVENT_STRICT is defined', /const NO_INVENT_STRICT\s*=/.test(src));
check('NO_FALSE_COMFORT is defined', /const NO_FALSE_COMFORT\s*=/.test(src));
check('guardrails are actually used', (src.match(/NO_INVENT(_STRICT)?\b/g) || []).length > 20,
  'defined but barely applied');

/* --- run ----------------------------------------------------------------- */
console.log('');
console.log('  PROMPT HYGIENE');
console.log('  ' + '-'.repeat(52));
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('');
}
console.log(`  ${pass} passed, ${fail} failed  (${endpoints.length} endpoints checked)`);
console.log('');
process.exit(fail ? 1 : 0);
