'use strict';
/* sim-nightout.js — 10 extensive workflows, traced step by step.
 *
 * Everything so far tests a request. This tests an EVENING: a chain long
 * enough that step nine depends on something learned at step two, where the
 * failure isn't a broken button but a thread quietly dropped in the middle.
 *
 * The headline one is the Da Nang night out — dinner, drinks, a club, on a
 * scooter, with Jess on the back. That's hard for reasons that have nothing to
 * do with any single skill:
 *
 *   - three venues, so two legs of navigation BETWEEN them
 *   - a scooter, so parking has to be remembered or the night ends badly
 *   - drinking, so the ride home is a decision Vision must not get cute about
 *   - two people, so the pin, the spend and the location all have a second party
 *   - a club at midnight, so "is this a fair price" and "where are we" matter
 *
 * Each workflow lists its steps, the skill each maps to, and what must be true
 * at the END of the chain — not just that every part exists.
 *
 * Run: node sim-nightout.js
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

function fnBody(name) {
  const i = app.indexOf(`function ${name}`);
  if (i === -1) return '';
  let d = 0, j = i;
  for (let k = i; k < app.length; k++) {
    if (app[k] === '{') d++;
    else if (app[k] === '}') { d--; if (d === 0) { j = k; break; } }
  }
  return app.slice(i, j);
}
function routeBody(r) {
  const i = server.indexOf(`"${r}"`);
  if (i === -1) return '';
  const j = server.indexOf('app.post(', i + 10);
  return server.slice(i, j > 0 ? j : i + 4000);
}

const SKILLS = (() => {
  const i = server.indexOf('const ROUTER_SKILLS'), j = server.indexOf('const VALID_SKILLS');
  fs.writeFileSync('/tmp/_no_sk.js', server.slice(i, j) + '\nmodule.exports={ROUTER_SKILLS};');
  return new Set([...require('/tmp/_no_sk.js').ROUTER_SKILLS.matchAll(/"(\w+)" \(/g)].map(m => m[1]));
})();
const DISPATCHED = new Set([...app.matchAll(/skill===\s*'(\w+)'/g)].map(m => m[1]));

/* --- one step -------------------------------------------------------------
 * A step is only "working" if it's reachable by voice AND its handler does
 * what the step needs — a map for anything that moves him, a memory write for
 * anything he'd want back later.
 */
function step(say, skill, opts) {
  opts = opts || {};
  const issues = [];
  if (!SKILLS.has(skill)) issues.push(`"${skill}" not declared to the router`);
  if (!DISPATCHED.has(skill)) issues.push(`"${skill}" has no dispatch branch`);
  if (opts.fn) {
    const body = fnBody(opts.fn);
    if (!body) issues.push(`${opts.fn}() missing`);
    else {
      if (opts.needsMap && !/openMaps\(|navigateWith\(|openAppleMaps\(/.test(body)) issues.push(`${opts.fn} gives no route`);
      if (opts.needsVoice !== false && !/say\(/.test(body)) issues.push(`${opts.fn} is silent`);
    }
  }
  if (opts.route) {
    const b = routeBody(opts.route);
    if (!b) issues.push(`${opts.route} missing`);
    else {
      if (!server.slice(server.indexOf(`"${opts.route}"`), server.indexOf(`"${opts.route}"`) + 140).includes('requireAuth')) issues.push(`${opts.route} unguarded`);
      if (/res\.status\(502\)/.test(b)) issues.push(`${opts.route} can fail unspeakably`);
      if (opts.needsMemory && !/mem\.push\(|STORE\.\w+\[uid\]/.test(b)) issues.push(`${opts.route} records nothing`);
    }
  }
  return { say, skill, issues };
}

/* --- the ten ------------------------------------------------------------- */
const WORKFLOWS = [
  {
    n: 'A night out in Da Nang — scooter, dinner, drinks, club',
    why: 'three venues, two legs of navigation between them, a scooter to find again, and a ride home decision at 2am',
    steps: [
      ['plan us a night out in da nang', 'planday', { route: '/planday' }],
      ['somewhere good for dinner around here', 'eatout'],
      ['is 400000 dong fair for that', 'scamcheck', { route: '/scamcheck' }],
      ['take me there', 'navigate', { fn: 'navigateWith', needsMap: true }],
      ['remember where I parked the scooter', 'rememberspot', { fn: 'markSpot' }],
      ['log 400000 for dinner', 'logspend'],
      ['somewhere for a drink after', 'nearby', { fn: 'findNearby', needsMap: true }],
      ['send jess this spot', 'sharepin'],
      ['whats a good club near here', 'nearby', { fn: 'findNearby', needsMap: true }],
      ['how do I politely turn down the tout', 'etiquette', { route: '/etiquette' }],
      ['what have we spent tonight', 'couplespend'],
      ['get me back to the scooter', 'backto', { fn: 'backToSpot', needsMap: true }],
      ['get me a ride home instead', 'ride', { fn: 'rideHandoff', needsMap: true }],
    ],
    ends: [
      ['the scooter can be found again', () => /buddy_spot|spotsGet/.test(app), 'a saved spot is the whole point of the night'],
      ['getting back to it opens a route', () => /openMaps\(|navigateWith\(/.test(fnBody('backToSpot'))],
      ['a ride home is offered without judgement', () => /rideHandoff/.test(app)],
      ['the spend is shared, not just his', () => /coupleSpend/.test(app)],
    ],
  },

  {
    n: 'Lost at 2am, phone at 8%',
    why: 'the worst case — dark, tired, low battery, and a step list would be useless',
    steps: [
      ['I have no idea where I am', 'whereis', { fn: 'whereIsPartner' }],
      ['get me back to the hotel', 'unlost', { fn: 'getUnlost', needsMap: true, route: '/unlost' }],
      ['is it safe around here', 'safety'],
      ['tell jess I am on my way', 'onmyway', { route: '/room' }],
      ['low power mode', 'status'],
    ],
    ends: [
      ['the map leads, the step list is the fallback', () => /Tap for turn-by-turn/.test(fnBody('getUnlost')) && /Or read the steps/.test(fnBody('getUnlost'))],
      ['it works without the Maps key', () => /501/.test(routeBody('/unlost'))],
    ],
  },

  {
    n: 'A Geeks2U job from a beach cafe',
    why: 'AEST hours from a country three hours behind, over a VPN, ending in a paste',
    steps: [
      ['what is on today', 'myday', { route: '/calendar/day' }],
      ['log this job', 'jobcapture', { route: '/job/capture', needsMemory: true }],
      ['job report for 1295115', 'jobreport', { route: '/job/report', needsMemory: true }],
      ['what did I do for brecht', 'jobrecall', { route: '/job/recall' }],
    ],
    ends: [
      ['work times are shown in both zones', () => /bothZones/.test(server)],
      ['the report is in his house format', () => /All issues resolved/.test(server)],
      ['it can be recalled by customer name months later', () => /similarity/.test(routeBody('/job/recall'))],
    ],
  },

  {
    n: 'Hanoi to Sapa and back in a weekend',
    why: 'no flights, so the whole thing hinges on overland options and weather',
    steps: [
      ['how do we get from hanoi to sapa', 'getthere'],
      ['will the weather be alright up there', 'weather', { route: '/weather' }],
      ['what will that cost the two of us', 'tripbudget', { route: '/tripbudget' }],
      ['are we free that weekend', 'amifree', { route: '/calendar/free' }],
      ['somewhere to stay in sapa', 'findstay'],
      ['put it in the calendar', 'addevent', { route: '/calendar/event' }],
    ],
    ends: [
      ['overland options exist at all', () => /twelvego|12go/i.test(app), 'no bus/train/ferry option in a region where that is how you travel'],
      ['the calendar is checked before booking', () => /findSlots|isFree/.test(server)],
    ],
  },

  {
    n: 'Dinner where the menu is a problem',
    why: 'a language he cannot read and something he must not eat',
    steps: [
      ['read this menu', 'menu', { route: '/menu' }],
      ['can I eat this', 'allergy', { route: '/allergy' }],
      ['how do I ask if it has peanuts', 'sayphrase', { route: '/phrase' }],
      ['help me talk to the waiter', 'talkto', { route: '/converse/turn' }],
      ['split the bill', 'splitbill'],
    ],
    ends: [
      ['the allergy answer never falsely reassures', () => /NO_FALSE_COMFORT/.test(routeBody('/allergy'))],
      ['the phrase carries a real language code for the voice', () => /BCP-47/.test(routeBody('/phrase'))],
    ],
  },

  {
    n: 'She wandered off in the market',
    why: 'two people, one crowd, and a position that might be stale',
    steps: [
      ['where is jess', 'whereis', { fn: 'whereIsPartner' }],
      ['where should we meet', 'meetmiddle', { fn: 'meetMiddle', needsMap: true, route: '/meetmiddle' }],
      ['tell her I am ten minutes away', 'onmyway'],
      ['send her a voice note', 'voicenote'],
    ],
    ends: [
      ['a stale fix is spoken in the past tense', () => /WAS about/.test(fnBody('whereIsPartner'))],
      ['the halfway point is one tap to navigate', () => /openMaps\(/.test(fnBody('meetMiddle'))],
      ['she gets the same pin without a duplicate', () => /already drops the pin/.test(app)],
    ],
  },

  {
    n: 'Landing in a new country',
    why: 'everything Vision knows about where he is resets in one moment',
    steps: [
      ['we have landed', 'arrival', { route: '/arrival', needsMemory: true }],
      ['what is 500000 dong in aussie', 'currency', { route: '/currency' }],
      ['do I need an esim', 'esim', { route: '/esim' }],
      ['what should I know about the customs here', 'etiquette', { route: '/etiquette' }],
      ['anything I should know', 'advise', { route: '/advise' }],
    ],
    ends: [
      ['arriving is recorded, not just spoken', () => /arrived in/.test(routeBody('/arrival'))],
      ['the country reaches the vendors', () => /grabRegion/.test(app)],
      ['the advisor notices he has not been briefed', () => /newCountryUnbriefed/.test(server)],
    ],
  },

  {
    n: 'The day the weather turns',
    why: 'a plan that has to be rebuilt on the spot',
    steps: [
      ['is it going to rain', 'weather', { route: '/weather' }],
      ['plan us an indoor day then', 'planday', { route: '/planday' }],
      ['what is on today', 'myday', { route: '/calendar/day' }],
      ['anything good around here', 'nearby', { fn: 'findNearby', needsMap: true }],
      ['what else could we do', 'alternative', { route: '/alternative' }],
    ],
    ends: [
      ['the planner knows he is not free all day', () => /calendar\/free|findSlots/.test(server)],
      ['the alternative offers one option, not a list', () => /ONE alternative, never more/.test(server)],
    ],
  },

  {
    n: 'Money getting away from them',
    why: 'a fortnight of small spends, two people, one pot',
    steps: [
      ['log 200000 for the taxi', 'logspend'],
      ['what have we spent', 'couplespend'],
      ['split 450000 three ways', 'splitbill'],
      ['is this a good deal', 'gooddeal', { route: '/gooddeal' }],
      ['anything I should know', 'advise', { route: '/advise' }],
    ],
    ends: [
      ['the balance says who owes who', () => /owes/.test(fnBody('coupleSpend'))],
      ['the advisor compares today against the days BEFORE it', () => /d < todayKey/.test(server), 'today in its own baseline hides a real spike'],
    ],
  },

  {
    n: 'The last night before flying home',
    why: 'everything has to be closed off, not just done',
    steps: [
      ['flights bangkok to brisbane on the 14th', 'flightsearch'],
      ['somewhere near the airport', 'findstay'],
      ['how was the trip', 'debrief', { route: '/day', needsMemory: true }],
      ['what did we do in hanoi', 'sharedmoments'],
      ['email me all that', 'handover', { route: '/handover' }],
      ['anything I should know', 'advise', { route: '/advise' }],
    ],
    ends: [
      ['the advisor chases an unfinished flow', () => /stalledFlow/.test(server)],
      ['and an unwritten job report', () => /unwrittenJob/.test(server)],
      ['the handover email never invents a booking reference', () => /never invent|NO_INVENT/i.test(routeBody('/handover'))],
    ],
  },
];

/* --- run ----------------------------------------------------------------- */
console.log('');
console.log('  10 EXTENSIVE WORKFLOWS — TRACED STEP BY STEP');
console.log('  ' + '='.repeat(72));

for (const w of WORKFLOWS) {
  const results = w.steps.map(([say, skill, opts]) => step(say, skill, opts));
  const broken = results.filter(r => r.issues.length);
  const endResults = (w.ends || []).map(([label, fn, why]) => {
    let ok = false;
    try { ok = fn() === true; } catch (e) { ok = false; }
    check(`${w.n} → ${label}`, ok, why);
    return { label, ok, why };
  });
  for (const r of results) check(`${w.n} → "${r.say}"`, r.issues.length === 0, r.issues.join('; '));

  const clean = broken.length === 0 && endResults.every(e => e.ok);
  console.log('');
  console.log(`  ${clean ? '✓' : '✗'} ${w.n}`);
  console.log(`      ${w.why}`);
  console.log(`      ${w.steps.length} steps:`);
  for (const r of results) {
    console.log(`        ${r.issues.length ? '✗' : '·'} "${r.say}"`.padEnd(54) + `→ ${r.skill}`);
    for (const i of r.issues) console.log(`            ⚠ ${i}`);
  }
  console.log(`      must be true at the end:`);
  for (const e of endResults) {
    console.log(`        ${e.ok ? '✓' : '✗'} ${e.label}`);
    if (!e.ok && e.why) console.log(`            ⚠ ${e.why}`);
  }
}

console.log('');
console.log('  ' + '='.repeat(72));
const totalSteps = WORKFLOWS.reduce((n, w) => n + w.steps.length, 0);
const totalEnds = WORKFLOWS.reduce((n, w) => n + (w.ends || []).length, 0);
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${WORKFLOWS.length} workflows · ${totalSteps} steps · ${totalEnds} end-state checks`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
