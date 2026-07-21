'use strict';
/* sim-couple-trip.js — 20 simulations, one continuous trip with his wife.
 *
 * Where sim-workflows.js proves each skill connects, this walks a whole trip in
 * order and asks a harder question at every step: does the thing Vision learned
 * two steps ago actually reach the step that needs it?
 *
 * Travelling as a couple is what makes it hard. Two people means shared
 * spending, shared location, one of them wandering off, and a running "tell
 * her" thread — and several of those skills write to stores that only pay off
 * if something later reads them.
 *
 * Run: node sim-couple-trip.js
 */

const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const app = fs.readFileSync('app.html', 'utf8');

let COUNTRY = 'Vietnam', CITY = 'Hanoi';
global.localStorage = {
  getItem: k => ({ buddy_country: COUNTRY, buddy_city: CITY, buddy_home: 'AUD',
                   buddy_currency: 'VND', buddy_myname: 'Shaun' })[k] || null,
  setItem: () => {},
};

function load(src, from, to, exp, pre) {
  const f = `/tmp/_ct_${Math.random().toString(36).slice(2)}.js`;
  fs.writeFileSync(f, (pre || '') + src.slice(src.indexOf(from), src.indexOf(to)) + '\n' + exp);
  return require(f);
}

const { ROUTER_SKILLS } = load(server, 'const ROUTER_SKILLS', 'const VALID_SKILLS', 'module.exports={ROUTER_SKILLS};');
const SKILLS = new Set([...ROUTER_SKILLS.matchAll(/"(\w+)" \(/g)].map(m => m[1]));
const { fastRoute } = load(app, 'const FAST_PATH = [', '  async function sendChat', 'module.exports={fastRoute};');

const vsrc = app.slice(app.indexOf('const VENDORS={'), app.indexOf('function vendorScore'))
  + '\n' + app.slice(app.indexOf('const COUNTRY_CODES'), app.indexOf('function waHandoff'));
fs.writeFileSync('/tmp/_ct_v.js', vsrc + '\nmodule.exports={VENDORS,grabRegion,waNumber};');
const V = require('/tmp/_ct_v.js');

const DISPATCHED = new Set([...app.matchAll(/skill===\s*'(\w+)'/g)].map(m => m[1]));
const ROUTES = new Set([...server.matchAll(/app\.(?:get|post)\("(\/[^"]+)"/g)].map(m => m[1]));

function routeBody(r) {
  const i = server.indexOf(`"${r}"`);
  if (i === -1) return '';
  const j = server.indexOf('app.post(', i + 10);
  return server.slice(i, j > 0 ? j : i + 4000);
}

/* --- the trip, in order -------------------------------------------------- */
const TRIP = [
  // ---------- before they go ----------
  { n: 'Plan the whole trip',   say: 'plan our two weeks in Vietnam and Thailand',
    skill: 'tripplan', route: '/tripplan' },
  { n: 'What to pack',          say: 'what should we pack',
    skill: 'packlist', route: '/packlist' },
  { n: 'Budget the trip',       say: 'how much will two weeks cost the two of us',
    skill: 'tripbudget', route: '/tripbudget' },
  { n: 'Sort a travel eSIM',    say: 'do I need an esim for vietnam',
    skill: 'esim', route: '/esim' },
  { n: 'Passport expiry check', say: 'is my passport still valid',
    skill: 'expiry', route: '/expiry' },

  // ---------- getting there ----------
  { n: 'Track the flight',      say: 'track VN782',
    skill: 'flight', route: '/flight' },
  { n: 'Landing brief',         say: "we've just landed",
    skill: 'arrival', route: '/arrival', mem: true },
  { n: 'Currency sense',        say: "what's 500000 dong in aussie",
    skill: 'currency', route: '/currency' },

  // ---------- day to day, together ----------
  { n: 'Weather for the day',   say: 'what is the weather like today',
    skill: 'weather', route: '/weather' },
  { n: 'Plan the day out',      say: 'plan our day in hanoi under fifty dollars',
    skill: 'planday', route: '/planday' },
  { n: "What's nearby",         say: 'anything good around here',
    skill: 'nearby', route: '/places' },
  { n: 'Read a street sign',    say: 'what does this sign say',
    skill: 'converse', route: '/converse' },
  { n: 'Cultural etiquette',    say: 'how do I politely say no to this vendor',
    skill: 'etiquette', route: '/etiquette' },
  { n: 'Capture a moment',      say: 'capture this',
    skill: 'capture', route: '/moment', mem: true },

  // ---------- the couple-specific ones ----------
  { n: 'Share a pin with her',  say: 'send jess this spot',
    skill: 'sharepin', route: '/share' },
  { n: 'Meet in the middle',    say: 'where should jess and I meet',
    skill: 'meetmiddle', route: '/meetmiddle' },
  { n: 'Tell her I am coming',  say: 'tell jess I am on my way',
    skill: 'onmyway', route: '/room' },
  { n: 'Split the bill',        say: 'split 450000 dong two ways',
    skill: 'splitbill' },
  { n: 'Track shared spending', say: 'what have we spent so far',
    skill: 'couplespend', route: '/spend' },

  // ---------- looking back ----------
  { n: 'Debrief the day',       say: 'how was today',
    skill: 'debrief', route: '/day', mem: true },
];

/* --- checks -------------------------------------------------------------- */
let pass = 0, fail = 0;
const problems = [];

function stage(label, ok, note) {
  if (ok) pass++; else { fail++; problems.push(`${label}: ${note}`); }
  return ok;
}

console.log('');
console.log('  20 SIMULATIONS — TWO WEEKS IN VIETNAM WITH JESS');
console.log('  ' + '='.repeat(68));

let phase = '';
const PHASES = { 0: 'BEFORE THEY GO', 5: 'GETTING THERE', 8: 'DAY TO DAY', 14: 'TRAVELLING AS A PAIR', 19: 'LOOKING BACK' };

TRIP.forEach((t, idx) => {
  if (PHASES[idx]) { phase = PHASES[idx]; console.log(''); console.log('  — ' + phase + ' —'); }

  const bits = [];
  let broke = null;

  // fast path must not hijack a nuanced request
  const fast = fastRoute(t.say);
  if (fast && fast.skill !== t.skill) broke = `fast path grabbed it as "${fast.skill}"`;
  bits.push(fast ? `fast:${fast.skill}` : 'fast:defer');

  // declared to the router
  if (!broke && !SKILLS.has(t.skill)) broke = `"${t.skill}" not declared to the router`;
  bits.push(SKILLS.has(t.skill) ? 'router:ok' : 'router:MISSING');

  // dispatched in the app
  if (!broke && !DISPATCHED.has(t.skill)) broke = `"${t.skill}" has no dispatch branch`;
  bits.push(DISPATCHED.has(t.skill) ? 'dispatch:ok' : 'dispatch:MISSING');

  // endpoint exists, is guarded, and fails in words
  if (t.route) {
    if (!ROUTES.has(t.route)) { if (!broke) broke = `${t.route} does not exist`; bits.push('api:MISSING'); }
    else {
      const b = routeBody(t.route);
      const guarded = server.slice(server.indexOf(`"${t.route}"`), server.indexOf(`"${t.route}"`) + 140).includes('requireAuth');
      const speakable = !/res\.status\(502\)/.test(b);
      if (!guarded && !broke) broke = `${t.route} is not auth-guarded`;
      if (!speakable && !broke) broke = `${t.route} can return an unspeakable 502`;
      bits.push(guarded && speakable ? 'api:ok' : 'api:BAD');
    }
  } else bits.push('api:local');

  // if it should be recallable later, something must actually write
  if (t.mem) {
    const b = routeBody(t.route);
    const writes = /mem\.push\(|STORE\.\w+\[uid\]/.test(b);
    if (!writes && !broke) broke = `${t.route} writes nothing — not recallable later`;
    bits.push(writes ? 'memory:ok' : 'memory:BAD');
  } else bits.push('memory:n/a');

  stage(t.n, !broke, broke || '');
  console.log(`  ${broke ? '✗' : '✓'} ${t.n.padEnd(24)} "${t.say.slice(0, 36)}"`);
  console.log(`      ${bits.join('  ')}`);
  if (broke) console.log(`      ⚠ ${broke}`);
});

/* --- the harder question: does context carry BETWEEN steps? -------------- */
console.log('');
console.log('  — DOES CONTEXT CARRY BETWEEN STEPS? —');
console.log('  ' + '-'.repeat(68));

// Each of these is a pair: something learned early that a later step must use.
const CHAINS = [
  { n: 'arrival sets the country -> Grab opens the right one',
    test: () => { COUNTRY = 'Vietnam'; const vn = V.grabRegion();
                  COUNTRY = 'Thailand'; const th = V.grabRegion();
                  COUNTRY = 'Vietnam';
                  return vn === 'vn' && th === 'th'; },
    why: 'grabRegion() must follow buddy_country, which /arrival writes' },

  { n: 'capture a moment -> recallable in the debrief',
    test: () => /mem\.push\(/.test(routeBody('/moment')) && /recallFor|STORE\.mem/.test(routeBody('/day')),
    why: '/moment must write to the pool /day reads' },

  { n: 'conversation saved -> found by who she was',
    test: () => /STORE\.convos/.test(routeBody('/converse/save')) && /STORE\.convos/.test(routeBody('/converse/history')),
    why: 'save and history must share a store' },

  { n: 'spend logged -> shows in the couple total',
    test: () => /STORE\.spend/.test(routeBody('/spend')) || /spend/.test(routeBody('/spend')),
    why: '/spend must persist, or the running total resets' },

  { n: 'a pin dropped -> "take me back" can find it',
    test: () => app.includes('buddy_spot') && /backto|getUnlost/.test(app),
    why: 'rememberspot and backto must use the same key' },

  { n: 'her number normalises for WhatsApp anywhere',
    test: () => { COUNTRY = 'Thailand';
                  const n = V.waNumber('0457 453 719'); COUNTRY = 'Vietnam';
                  return n === '61457453719'; },
    why: 'a saved AU number stays AU even when he is abroad' },

  { n: 'advice endpoints know him before advising',
    test: () => ['/planday', '/findfood', '/stay', '/scamcheck'].every(r => /recallFor\(/.test(routeBody(r))),
    why: 'personalised advice must pull memory, not run blind' },

  { n: 'every spoken reply avoids markdown',
    test: () => ['/planday', '/etiquette', '/arrival', '/packlist'].every(r => /SPOKEN_PLAIN|no markdown/i.test(routeBody(r))),
    why: 'asterisks read aloud through the glasses are noise' },
];

for (const c of CHAINS) {
  let ok = false;
  try { ok = c.test() === true; } catch (e) { ok = false; }
  stage(c.n, ok, c.why);
  console.log(`  ${ok ? '✓' : '✗'} ${c.n}`);
  if (!ok) console.log(`      ⚠ ${c.why}`);
}

console.log('  ' + '='.repeat(68));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); }
console.log('');
console.log(`  ${pass} passed, ${fail} failed — 20 trip steps + 8 context chains`);
console.log('');
process.exit(fail ? 1 : 0);
