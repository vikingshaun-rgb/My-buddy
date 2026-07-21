'use strict';
/* sim-workflows.js — 15 end-to-end simulations.
 *
 * The unit tests check pieces. This traces a REAL SENTENCE through every stage
 * it would actually pass:
 *
 *   what he says
 *     -> fast path (does it resolve locally, and should it?)
 *     -> router (is the skill declared? would it be validated?)
 *     -> dispatch (does app.html have a branch, and does it forward the args?)
 *     -> endpoint (does the route exist, is it auth-guarded, does it fail speakably?)
 *     -> vendor URL (if it hands off, does the link actually build?)
 *     -> memory (does anything get written, and can it be recalled later?)
 *
 * A break anywhere in that chain is a request that silently does nothing —
 * which is exactly the class of bug that survives unit tests.
 *
 * Run: node sim-workflows.js
 */

const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const app = fs.readFileSync('app.html', 'utf8');

/* --- load the real pieces out of the source ------------------------------ */
function extract(src, from, to, exportsLine, pre) {
  const i = src.indexOf(from), j = src.indexOf(to);
  const f = `/tmp/_sim_${Math.random().toString(36).slice(2)}.js`;
  fs.writeFileSync(f, (pre || '') + src.slice(i, j) + '\n' + exportsLine);
  return require(f);
}

let COUNTRY = 'Vietnam', CITY = 'Hanoi';
global.localStorage = {
  getItem: k => ({ buddy_country: COUNTRY, buddy_city: CITY, buddy_home: 'AUD' })[k] || null,
  setItem: () => {},
};

const { ROUTER_SKILLS } = extract(server, 'const ROUTER_SKILLS', 'const VALID_SKILLS', 'module.exports={ROUTER_SKILLS};');
const SKILLS = new Set([...ROUTER_SKILLS.matchAll(/"(\w+)" \(/g)].map(m => m[1]));

const { fastRoute } = extract(app, 'const FAST_PATH = [', '  async function sendChat', 'module.exports={fastRoute};');

const vendorSrc = app.slice(app.indexOf('const VENDORS={'), app.indexOf('function vendorScore'))
  + '\n' + app.slice(app.indexOf('const COUNTRY_CODES'), app.indexOf('function waHandoff'));
const vf = '/tmp/_sim_vendors.js';
fs.writeFileSync(vf, vendorSrc + '\nmodule.exports={VENDORS,grabRegion,waNumber,homeDial};');
const V = require(vf);

/* --- the checks each stage performs -------------------------------------- */
const DISPATCHED = new Set([...app.matchAll(/skill===\s*'(\w+)'/g)].map(m => m[1]));
const ROUTES = new Set([...server.matchAll(/app\.(?:get|post)\("(\/[^"]+)"/g)].map(m => m[1]));

function endpointOK(route) {
  if (!route) return { ok: true, note: 'no server call' };
  if (!ROUTES.has(route)) return { ok: false, note: `route ${route} does not exist` };
  const i = server.indexOf(`"${route}"`);
  const guarded = server.slice(i, i + 140).includes('requireAuth');
  const j = server.indexOf('app.post(', i + 10);
  const body = server.slice(i, j > 0 ? j : i + 4000);
  const speakable = !/res\.status\(502\)/.test(body);
  if (!guarded) return { ok: false, note: `${route} is not auth-guarded` };
  if (!speakable) return { ok: false, note: `${route} can return an unspeakable 502` };
  return { ok: true, note: `${route} guarded + fails speakably` };
}

function vendorOK(kind, q) {
  if (!kind) return { ok: true, note: 'no vendor handoff' };
  const list = V.VENDORS[kind];
  if (!list || !list.length) return { ok: false, note: `vendor category "${kind}" is empty` };
  const safe = {};
  for (const k of ['where', 'from', 'to', 'when', 'what', 'people', 'from8', 'fromCode', 'toCode']) {
    safe[k] = (q && q[k] != null && String(q[k]).trim()) ? q[k] : '';
  }
  for (const v of list) {
    let u;
    try { u = v.url(safe); } catch (e) { return { ok: false, note: `${v.id} threw: ${e.message}` }; }
    if (!u.startsWith('http')) return { ok: false, note: `${v.id} built a non-URL` };
    if (u.includes('undefined')) return { ok: false, note: `${v.id} leaked "undefined"` };
    if (/\/homes&|\.[a-z]+\/?&/.test(u)) return { ok: false, note: `${v.id} malformed query` };
  }
  return { ok: true, note: `${list.length} vendors, all links build` };
}

function memoryOK(route, expectWrite) {
  if (!expectWrite) return { ok: true, note: 'no memory write expected' };
  if (!route) return { ok: false, note: 'expected a memory write but no endpoint' };
  const i = server.indexOf(`"${route}"`);
  const j = server.indexOf('app.post(', i + 10);
  const body = server.slice(i, j > 0 ? j : i + 4000);
  const writes = /mem\.push\(|STORE\.\w+\[uid\]\s*=/.test(body);
  return writes ? { ok: true, note: 'writes to memory' } : { ok: false, note: 'nothing reaches memory — not recallable later' };
}

/* --- the 15 workflows ---------------------------------------------------- */
const SIMS = [
  { n: 'Book a flight',        say: 'flights from Brisbane to Hanoi in August',
    skill: 'flightsearch', vendor: 'fly',  q: { where: 'Hanoi', from: 'Brisbane', when: 'August' } },

  { n: 'Find a hotel',         say: 'find me somewhere to stay in Hanoi for two from the 1st',
    skill: 'findstay',     vendor: 'stay', q: { where: 'Hanoi', from: '2026-08-01', to: '2026-08-04', people: 2 } },

  { n: 'Overland travel',      say: 'how do I get from Hanoi to Sapa',
    skill: 'getthere',     vendor: 'getthere', q: { from: 'Hanoi', where: 'Sapa' } },

  { n: 'Order food in',        say: 'order me some pho',
    skill: 'orderfood',    vendor: 'order', q: { where: 'Hanoi', what: 'pho' } },

  { n: 'Eat out',              say: 'where should we eat tonight',
    skill: 'eatout',       vendor: 'eat',  q: { where: 'Hanoi' } },

  { n: 'Sightseeing',          say: 'things to do in Hanoi',
    skill: 'thingstobook', vendor: 'doing', q: { where: 'Hanoi', what: 'things to do' } },

  { n: 'Identify a landmark',  say: "what's that building",
    skill: 'landmark',     route: '/landmark' },

  { n: 'Read a menu',          say: 'read this menu for me',
    skill: 'menu',         route: '/menu' },

  { n: 'Is it safe to eat',    say: 'can I eat this with a peanut allergy',
    skill: 'allergy',      route: '/allergy' },

  { n: 'Fair price check',     say: 'is 400 baht fair for a tuk tuk',
    skill: 'scamcheck',    route: '/scamcheck' },

  { n: 'Navigate somewhere',   say: 'take me to the old quarter',
    skill: 'navigate',     route: '/directions' },

  { n: 'Talk to a local',      say: 'help me talk to this bloke',
    skill: 'talkto',       route: '/converse/turn', mem: true },

  { n: 'Log a work job',       say: 'log this job',
    skill: 'jobcapture',   route: '/job/capture', mem: true },

  { n: 'Write a job report',   say: 'job report for 1295115',
    skill: 'jobreport',    route: '/job/report',  mem: true },

  { n: 'Recall it months on',  say: 'what did I do for 1295115',
    skill: 'jobrecall',    route: '/job/recall' },
];

/* --- run ----------------------------------------------------------------- */
let pass = 0, fail = 0;
const problems = [];

console.log('');
console.log('  15 END-TO-END WORKFLOW SIMULATIONS');
console.log('  ' + '='.repeat(66));

for (const s of SIMS) {
  const stages = [];
  let broke = null;

  // 1. fast path — either it resolves locally to the right skill, or defers
  const fast = fastRoute(s.say);
  if (fast && fast.skill !== s.skill) {
    broke = `fast path sent it to "${fast.skill}" instead of "${s.skill}"`;
  }
  stages.push(fast ? `fast:${fast.skill}` : 'fast:defer');

  // 2. router
  if (!broke && !SKILLS.has(s.skill)) broke = `"${s.skill}" is not declared to the router`;
  stages.push(SKILLS.has(s.skill) ? 'router:ok' : 'router:MISSING');

  // 3. dispatch
  if (!broke && !DISPATCHED.has(s.skill)) broke = `"${s.skill}" has no dispatch branch in app.html`;
  stages.push(DISPATCHED.has(s.skill) ? 'dispatch:ok' : 'dispatch:MISSING');

  // 4. endpoint
  const ep = endpointOK(s.route);
  if (!broke && !ep.ok) broke = ep.note;
  stages.push(s.route ? (ep.ok ? 'endpoint:ok' : 'endpoint:BAD') : 'endpoint:n/a');

  // 5. vendor links
  const vr = vendorOK(s.vendor, s.q);
  if (!broke && !vr.ok) broke = vr.note;
  stages.push(s.vendor ? (vr.ok ? 'links:ok' : 'links:BAD') : 'links:n/a');

  // 6. memory
  const mr = memoryOK(s.route, s.mem);
  if (!broke && !mr.ok) broke = mr.note;
  stages.push(s.mem ? (mr.ok ? 'memory:ok' : 'memory:BAD') : 'memory:n/a');

  if (broke) { fail++; problems.push(`${s.n}: ${broke}`); }
  else pass++;

  console.log(`  ${broke ? '✗' : '✓'} ${s.n.padEnd(22)} "${s.say.slice(0, 34)}"`);
  console.log(`      ${stages.join('  ')}`);
  if (s.vendor) console.log(`      ${vr.note}`);
  if (broke) console.log(`      ⚠ ${broke}`);
}

console.log('  ' + '='.repeat(66));

/* --- part 2: the fast path must never guess -------------------------------
 * A wrong local guess is worse than a slower correct answer, because the user
 * gets a confident wrong action rather than a pause. These must ALL defer.
 */
console.log('');
console.log('  FAST PATH RESTRAINT — these must reach the model, not be guessed');
console.log('  ' + '-'.repeat(66));
const MUST_DEFER = [
  ['is 400 baht fair for a tuk tuk', 'a judgement, not a command'],
  ['what did the guesthouse bloke say', 'memory recall, ambiguous'],
  ['what is on my to do list', 'three of his lists contain "to do"'],
  ['should I take an umbrella', 'opinion'],
  ['order me some pho', 'orderfood or findfood — the model should weigh it'],
  ['where should we eat tonight', 'eatout or findfood'],
  ['take me to the old quarter', 'navigate or backto'],
  ['read this menu for me', 'needs a photo, not a shortcut'],
];
for (const [say, why] of MUST_DEFER) {
  const r = fastRoute(say);
  if (r) { fail++; problems.push(`fast path grabbed "${say}" as ${r.skill} — ${why}`); }
  else pass++;
  console.log(`  ${r ? '✗' : '✓'} ${say.padEnd(36)} ${r ? 'GRABBED as ' + r.skill : why}`);
}

/* --- part 3: the memory loop must close ----------------------------------
 * Writing to memory is half of it. The question that matters is whether the
 * thing written can be found again months later by the words he'd actually
 * use — a job number, or a customer's name.
 */
console.log('');
console.log('  MEMORY LOOP — is what gets written findable later?');
console.log('  ' + '-'.repeat(66));
const LOOPS = [
  { write: '/job/report',   read: '/job/recall',       by: 'job number or customer name' },
  { write: '/job/capture',  read: '/job/recall',       by: 'job number from a screenshot' },
  { write: '/converse/save', read: '/converse/history', by: 'who he was talking to' },
  { write: '/calendar/tick/confirm', read: '/chat',    by: 'the shared memory pool' },
];
for (const l of LOOPS) {
  const wi = server.indexOf(`"${l.write}"`);
  const wj = server.indexOf('app.post(', wi + 10);
  const wbody = server.slice(wi, wj > 0 ? wj : wi + 4000);
  const ri = server.indexOf(`"${l.read}"`);
  const rj = server.indexOf('app.post(', ri + 10);
  const rbody = server.slice(ri, rj > 0 ? rj : ri + 4000);

  const writes = /mem\.push\(|STORE\.\w+\[uid\]/.test(wbody);
  // The read side must look in the same place the write side put it.
  const sharedPool = /mem\.push\(/.test(wbody) && /recallFor|STORE\.mem/.test(rbody);
  // The read side guards with (STORE.jobs || {})[uid], so match the store name
  // rather than the exact indexing shape — otherwise this reports a phantom
  // break on a loop that closes perfectly well.
  const wStore = (wbody.match(/STORE\.(jobs|convos)\b/) || [])[1];
  const ownStore = !!wStore && new RegExp(`STORE\\.${wStore}\\b`).test(rbody);
  const closes = writes && (sharedPool || ownStore || l.read === '/chat');

  if (!closes) { fail++; problems.push(`${l.write} -> ${l.read}: written but not findable`); }
  else pass++;
  console.log(`  ${closes ? '✓' : '✗'} ${l.write.padEnd(24)} -> ${l.read.padEnd(20)} by ${l.by}`);
}

console.log('  ' + '='.repeat(66));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); }
console.log('');
console.log(`  ${pass} checks passed, ${fail} failed — ${SIMS.length} workflows + restraint + memory loops`);
console.log('');
process.exit(fail ? 1 : 0);
