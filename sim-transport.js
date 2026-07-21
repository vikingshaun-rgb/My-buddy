'use strict';
/* sim-transport.js — 50 simulations across 20 real transport scenarios.
 *
 * Transport is where a travel assistant earns its keep or embarrasses itself,
 * because almost none of it is a single question. "Can we get to Sapa on
 * Thursday" is a date, a route, a mode, a cost, a weather risk and a hotel
 * booking that all have to agree with each other.
 *
 * So this doesn't test skills in isolation. Each SCENARIO is a real situation
 * with several requests in sequence, and the report at the end shows which
 * scenarios hold together end to end and which have a weak link.
 *
 * Run: node sim-transport.js
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
  const f = `/tmp/_tr_${Math.random().toString(36).slice(2)}.js`;
  fs.writeFileSync(f, (pre || '') + src.slice(src.indexOf(from), src.indexOf(to)) + '\n' + exp);
  return require(f);
}

const { ROUTER_SKILLS } = load(server, 'const ROUTER_SKILLS', 'const VALID_SKILLS', 'module.exports={ROUTER_SKILLS};');
const SKILLS = new Set([...ROUTER_SKILLS.matchAll(/"(\w+)" \(/g)].map(m => m[1]));
const { fastRoute } = load(app, 'const FAST_PATH = [', '  async function sendChat', 'module.exports={fastRoute};');

const vsrc = app.slice(app.indexOf('const VENDORS={'), app.indexOf('function vendorScore'))
  + '\n' + app.slice(app.indexOf('const COUNTRY_CODES'), app.indexOf('function waHandoff'));
fs.writeFileSync('/tmp/_tr_v.js', vsrc + '\nmodule.exports={VENDORS,grabRegion,waNumber};');
const V = require('/tmp/_tr_v.js');

const DISPATCHED = new Set([...app.matchAll(/skill===\s*'(\w+)'/g)].map(m => m[1]));
const ROUTES = new Set([...server.matchAll(/app\.(?:get|post)\("(\/[^"]+)"/g)].map(m => m[1]));

function routeBody(r) {
  const i = server.indexOf(`"${r}"`);
  if (i === -1) return '';
  const j = server.indexOf('app.post(', i + 10);
  return server.slice(i, j > 0 ? j : i + 4000);
}

/* --- one request, all the way through ----------------------------------- */
function step(say, skill, opts) {
  opts = opts || {};
  const issues = [];

  const fast = fastRoute(say);
  if (fast && fast.skill !== skill) issues.push(`fast path took it as "${fast.skill}"`);

  if (!SKILLS.has(skill)) issues.push(`"${skill}" not declared to the router`);
  if (!DISPATCHED.has(skill)) issues.push(`"${skill}" has no dispatch branch`);

  if (opts.route) {
    if (!ROUTES.has(opts.route)) issues.push(`${opts.route} does not exist`);
    else {
      const head = server.slice(server.indexOf(`"${opts.route}"`), server.indexOf(`"${opts.route}"`) + 140);
      if (!head.includes('requireAuth')) issues.push(`${opts.route} unguarded`);
      if (/res\.status\(502\)/.test(routeBody(opts.route))) issues.push(`${opts.route} can return a bare 502`);
    }
  }

  if (opts.vendor) {
    const list = V.VENDORS[opts.vendor];
    if (!list || !list.length) issues.push(`vendor "${opts.vendor}" empty`);
    else {
      const safe = {};
      for (const k of ['where', 'from', 'to', 'when', 'what', 'people', 'from8', 'fromCode', 'toCode']) {
        safe[k] = (opts.q && opts.q[k] != null && String(opts.q[k]).trim()) ? opts.q[k] : '';
      }
      for (const v of list) {
        let u; try { u = v.url(safe); } catch (e) { issues.push(`${v.id} threw`); continue; }
        if (!u.startsWith('http') || u.includes('undefined') || /\/homes&/.test(u)) issues.push(`${v.id} bad link`);
      }
    }
  }

  if (opts.mem) {
    const b = routeBody(opts.route);
    if (!/mem\.push\(|STORE\.\w+\[uid\]/.test(b)) issues.push(`${opts.route} records nothing`);
  }

  return { say, skill, issues };
}

/* --- 20 scenarios, 50 steps --------------------------------------------- */
const SCENARIOS = [
  { n: 'Booking the flights out', why: 'the first real decision of the trip',
    steps: [
      ['flights from Brisbane to Hanoi in August', 'flightsearch', { vendor: 'fly', q: { where: 'Hanoi', from: 'Brisbane', when: 'August' } }],
      ['is that a good price for that route', 'gooddeal', { route: '/gooddeal' }],
      ['put it in the calendar for the 1st', 'addevent', { route: '/calendar/event' }],
    ] },

  { n: 'Flight day', why: 'the day it actually happens',
    steps: [
      ['track VN782', 'flight', { route: '/flight' }],
      ['what is the weather in hanoi', 'weather', { route: '/weather' }],
      ["we've just landed", 'arrival', { route: '/arrival', mem: true }],
    ] },

  { n: 'Airport to hotel', why: 'the first chance to get ripped off',
    steps: [
      ['get me a ride to the old quarter', 'ride'],
      ['is 400000 dong fair from the airport', 'scamcheck', { route: '/scamcheck' }],
      ['remember where the hotel is', 'rememberspot'],
    ] },

  { n: 'Finding a bed', why: 'accommodation from scratch',
    steps: [
      ['find somewhere to stay in hanoi', 'findstay', { vendor: 'stay', q: { where: 'Hanoi', people: 2 } }],
      ['what about places near the lake', 'stay', { route: '/stay' }],
      ['book a table for dinner there', 'booktable'],
    ] },

  { n: 'Overland to Sapa', why: 'no flights, so it is bus or train',
    steps: [
      ['how do we get from hanoi to sapa', 'getthere', { vendor: 'getthere', q: { from: 'Hanoi', where: 'Sapa' } }],
      ['what will that cost the two of us', 'tripbudget', { route: '/tripbudget' }],
      ['will the weather be alright up there', 'weather', { route: '/weather' }],
    ] },

  { n: 'Getting around town', why: 'the everyday movement',
    steps: [
      ['take me to the water puppet theatre', 'navigate', { route: '/directions' }],
      ['is there a bus that goes there', 'transit'],
      ['what is around here worth seeing', 'nearby', { route: '/places' }],
    ] },

  { n: 'Lost in the old quarter', why: 'the one that actually matters',
    steps: [
      ['I have no idea where I am', 'whereis'],
      ['get me back to the hotel', 'unlost', { route: '/unlost' }],
      ['take me back to where we parked', 'backto'],
    ] },

  { n: 'Splitting from Jess', why: 'two people, one plan',
    steps: [
      ['share my location with jess', 'livelocation'],
      ['where should we meet', 'meetmiddle', { route: '/meetmiddle' }],
      ['tell her I am ten minutes away', 'onmyway', { route: '/room' }],
    ] },

  { n: 'Money on the move', why: 'transport is most of the spend',
    steps: [
      ['what is 500000 dong in aussie', 'currency', { route: '/currency' }],
      ['log 200000 for the taxi', 'logspend'],
      ['what have we spent on transport', 'couplespend', { route: '/spend' }],
    ] },

  { n: 'The internal flight', why: 'Hanoi to Da Nang mid-trip',
    steps: [
      ['flights hanoi to da nang next tuesday', 'flightsearch', { vendor: 'fly', q: { where: 'Da Nang', from: 'Hanoi', when: 'next Tuesday' } }],
      ['are we free that day', 'amifree', { route: '/calendar/free' }],
      ['what is in my bookings already', 'bookings'],
    ] },

  { n: 'Rain changes the plan', why: 'weather forcing a rethink',
    steps: [
      ['is it going to rain today', 'weather', { route: '/weather' }],
      ['plan us an indoor day then', 'planday', { route: '/planday' }],
      ['what is on today', 'myday', { route: '/calendar/day' }],
    ] },

  { n: 'A day trip out', why: 'day-scale logistics',
    steps: [
      ['things to do around halong bay', 'thingstobook', { vendor: 'doing', q: { where: 'Halong Bay' } }],
      ['how do we get there and back in a day', 'getthere', { vendor: 'getthere', q: { from: 'Hanoi', where: 'Halong Bay' } }],
      ['what should we take', 'packlist', { route: '/packlist' }],
    ] },

  { n: 'Crossing to Thailand', why: 'a second country mid-trip',
    steps: [
      ['flights hanoi to bangkok', 'flightsearch', { vendor: 'fly', q: { where: 'Bangkok', from: 'Hanoi' } }],
      ['do I need anything for thailand', 'esim', { route: '/esim' }],
      ['is my passport still alright', 'expiry', { route: '/expiry' }],
    ] },

  { n: 'Bangkok arrival', why: 'a whole new set of local norms',
    steps: [
      ['we have landed in bangkok', 'arrival', { route: '/arrival', mem: true }],
      ['is 300 baht fair for a tuk tuk', 'scamcheck', { route: '/scamcheck' }],
      ['how do I politely turn one down', 'etiquette', { route: '/etiquette' }],
    ] },

  { n: 'Booking the last leg', why: 'getting home',
    steps: [
      ['flights bangkok to brisbane on the 14th', 'flightsearch', { vendor: 'fly', q: { where: 'Brisbane', from: 'Bangkok', when: '14 August' } }],
      ['somewhere near the airport for the last night', 'findstay', { vendor: 'stay', q: { where: 'Bangkok airport', people: 2 } }],
      ['add the flight to the calendar', 'addevent', { route: '/calendar/event' }],
    ] },

  { n: 'Something goes wrong', why: 'the failure path people forget to test',
    steps: [
      ['my flight is delayed', 'flight', { route: '/flight' }],
      ['is it safe around here', 'safety'],
      ['what do I do if I lose my phone', 'survival', { route: '/survival' }],
    ] },

  { n: 'Keeping a record', why: 'so the trip is recallable afterwards',
    steps: [
      ['capture this', 'capture', { route: '/moment', mem: true }],
      ['how was today', 'debrief', { route: '/day', mem: true }],
      ['what did we do on tuesday', 'dayview'],
    ] },

  { n: 'Working while away', why: 'the Geeks2U job in the middle of it all',
    steps: [
      ['what is on today', 'myday', { route: '/calendar/day' }],
      ['job report for 1295115', 'jobreport', { route: '/job/report', mem: true }],
      ['what did I do for that job', 'jobrecall', { route: '/job/recall' }],
    ] },

  { n: 'Watching for changes', why: 'standing instructions, not questions',
    steps: [
      ['let me know if the fare drops', 'watcher', { route: '/watchers' }],
      ['read me my texts', 'readtexts'],
      ['any update on my order', 'orderupdate'],
    ] },

  { n: 'The whole trip in one go', why: 'the agentic case — several skills, one request',
    steps: [
      ['plan our two weeks across vietnam and thailand', 'tripplan', { route: '/tripplan' }],
      ['what is the plan for day 4', 'tripday'],
      ['what will the whole thing cost', 'tripbudget', { route: '/tripbudget' }],
    ] },
];

/* --- run ----------------------------------------------------------------- */
let stepsRun = 0, stepsOK = 0;
const scenarioResults = [];

for (const sc of SCENARIOS) {
  const results = sc.steps.map(([say, skill, opts]) => step(say, skill, opts));
  const broken = results.filter(r => r.issues.length);
  stepsRun += results.length;
  stepsOK += results.length - broken.length;
  scenarioResults.push({ ...sc, results, broken });
}

console.log('');
console.log('  50 TRANSPORT & LOGISTICS SIMULATIONS — 20 SCENARIOS');
console.log('  ' + '='.repeat(72));

for (const sc of scenarioResults) {
  const ok = sc.broken.length === 0;
  console.log('');
  console.log(`  ${ok ? '✓' : '✗'} ${sc.n}`);
  console.log(`      ${sc.why}`);
  for (const r of sc.results) {
    const mark = r.issues.length ? '✗' : '·';
    console.log(`      ${mark} "${r.say}"`.padEnd(58) + `-> ${r.skill}`);
    for (const i of r.issues) console.log(`          ⚠ ${i}`);
  }
}

/* --- part 2: awkward real place names ------------------------------------
 * Place names in this region carry spaces, accents, apostrophes and slashes.
 * A builder that forgets to encode one produces a link that opens the vendor
 * to a blank search — which looks like the vendor's fault, not ours.
 */
console.log('');
console.log('  AWKWARD PLACE NAMES — do the links survive real spelling?');
console.log('  ' + '-'.repeat(72));
const AWKWARD = [
  ['a city with a space',   'fly',      { where: 'Ho Chi Minh City', from: 'Brisbane' }],
  ['Vietnamese accents',    'getthere', { from: 'Hanoi', where: 'Đà Nẵng' }],
  ['an apostrophe',         'stay',     { where: "Nha Trang's beach" }],
  ['an ampersand',          'stay',     { where: 'Bed & Breakfast Hanoi' }],
  ['an absurdly long name', 'getthere', { from: 'Hanoi', where: 'x'.repeat(200) }],
  ['digits only',           'fly',      { where: '12345', from: '999' }],
  ['a slash',               'stay',     { where: 'Hanoi/Old Quarter' }],
];
let encodeFails = 0;
for (const [label, kind, q] of AWKWARD) {
  const safe = {};
  for (const k of ['where', 'from', 'to', 'when', 'what', 'people', 'from8', 'fromCode', 'toCode']) {
    safe[k] = (q[k] != null && String(q[k]).trim()) ? q[k] : '';
  }
  const bad = [];
  for (const v of (V.VENDORS[kind] || [])) {
    let u; try { u = v.url(safe); } catch (e) { bad.push(`${v.id} threw`); continue; }
    if (!u.startsWith('http') || u.includes('undefined') || /\s/.test(u)) bad.push(v.id);
  }
  if (bad.length) encodeFails++;
  stepsRun++; if (!bad.length) stepsOK++;
  console.log(`  ${bad.length ? '✗' : '·'} ${label.padEnd(24)} ${(V.VENDORS[kind] || []).length} vendors${bad.length ? '  ⚠ ' + bad.join(', ') : ''}`);
}

console.log('');
console.log('  ' + '='.repeat(72));
console.log('  REPORT');
console.log('  ' + '-'.repeat(72));
const cleanScenarios = scenarioResults.filter(s => !s.broken.length).length;
console.log(`  scenarios holding together end to end : ${cleanScenarios}/${SCENARIOS.length}`);
console.log(`  individual requests passing           : ${stepsOK}/${stepsRun}`);
console.log('');
if (cleanScenarios < SCENARIOS.length) {
  console.log('  scenarios with a weak link:');
  for (const s of scenarioResults.filter(x => x.broken.length)) {
    console.log(`    ✗ ${s.n}`);
    for (const b of s.broken) console.log(`        "${b.say}" — ${b.issues.join('; ')}`);
  }
  console.log('');
}
process.exit(stepsOK === stepsRun ? 0 : 1);
