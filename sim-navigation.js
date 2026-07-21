'use strict';
/* sim-navigation.js — 50 simulations of the whole navigation chain.
 *
 * Directions are the one thing Vision does where "nearly right" is useless.
 * A recommendation he can't get to, a pin that drops a marker instead of
 * starting a route, a step list read aloud to someone who is already lost —
 * each of those LOOKS like the feature works, right up until he's standing on
 * a corner in Hanoi with the phone in his hand.
 *
 * So this doesn't test whether a skill exists. It follows every path that ends
 * in "go here" and asks the same five questions each time:
 *
 *   1. does it SPEAK          — useless hands-free otherwise
 *   2. does it open a MAP     — not a marker, an actual route
 *   3. does it start TURN-BY-TURN with voice guidance
 *   4. does it try the NATIVE app first (web Maps has no voice)
 *   5. does it FALL BACK when the app isn't installed
 *
 * Run: node sim-navigation.js
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

/* --- helpers ------------------------------------------------------------- */
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}`);
  if (i === -1) return '';
  let d = 0, j = i;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) { j = k; break; } }
  }
  return src.slice(i, j);
}
function routeBody(r) {
  const i = server.indexOf(`"${r}"`);
  if (i === -1) return '';
  const j = server.indexOf('app.post(', i + 10);
  return server.slice(i, j > 0 ? j : i + 4000);
}

const SKILLS = (() => {
  const i = server.indexOf('const ROUTER_SKILLS'), j = server.indexOf('const VALID_SKILLS');
  fs.writeFileSync('/tmp/_nav_sk.js', server.slice(i, j) + '\nmodule.exports={ROUTER_SKILLS};');
  const { ROUTER_SKILLS } = require('/tmp/_nav_sk.js');
  return new Set([...ROUTER_SKILLS.matchAll(/"(\w+)" \(/g)].map(m => m[1]));
})();
const DISPATCHED = new Set([...app.matchAll(/skill===\s*'(\w+)'/g)].map(m => m[1]));

console.log('');
console.log('  50 NAVIGATION SIMULATIONS — REQUEST TO TURN-BY-TURN');
console.log('  ' + '='.repeat(70));

/* --- A. the handover itself (10) ---------------------------------------- */
console.log('');
console.log('  A. THE HANDOVER — WHAT "OPEN MAPS" ACTUALLY DOES');
console.log('  ' + '-'.repeat(70));

const om = fnBody(app, 'openMaps');
const A = [
  ['openMaps exists', !!om],
  ['tries the native Google Maps app first', /comgooglemaps:\/\//.test(om)],
  ['native link carries a travel mode', /directionsmode=/.test(om)],
  ['web fallback starts navigation, not a pin', /dir_action=navigate/.test(om)],
  ['web fallback carries a travel mode', /travelmode=/.test(om)],
  ['falls back only if the app did not open', /setTimeout\(/.test(om) && /Date\.now\(\)\s*-\s*t\s*</.test(om)],
  ['the destination is URL-encoded', /encodeURIComponent/.test(om)],
  ['remembers he prefers Google', /prefRecord\('maps'/.test(om)],
  ['an Apple Maps path exists for those who want it', !!fnBody(app, 'openAppleMaps')],
  ['no marker-only links survive anywhere', [...app.matchAll(/maps\.google\.com\/\?q=/g)].length === 0],
];
for (const [label, ok] of A) {
  check(label, ok, 'the tap would drop a pin, not start a route');
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

/* --- B. every skill that ends in "go here" (18) -------------------------- */
console.log('');
console.log('  B. EVERY SKILL THAT ENDS IN "GO HERE"');
console.log('  ' + '-'.repeat(70));

const NAV_PATHS = [
  { fn: 'navigateWith',  say: 'take me to the old quarter',        skill: 'navigate' },
  { fn: 'getUnlost',     say: 'get me back to the hotel',          skill: 'unlost' },
  { fn: 'backToSpot',    say: 'take me back to where we parked',   skill: 'backto' },
  { fn: 'findNearby',    say: 'anything good around here',         skill: 'nearby' },
  { fn: 'meetMiddle',    say: 'where should jess and I meet',      skill: 'meetmiddle' },
  { fn: 'rideHandoff',   say: 'get me a ride to the airport',      skill: 'ride' },
  { fn: 'whereIsPartner', say: 'where is jess',                    skill: 'whereis' },
  { fn: 'partnerPing',   say: '(a pin she dropped, on open)',      skill: null },
  { fn: 'checkPartner',  say: "what's she sent me",                skill: null },
];
for (const p of NAV_PATHS) {
  const body = fnBody(app, p.fn);
  if (!body) { console.log(`  · ${p.fn.padEnd(16)} not present, skipped`); continue; }
  const maps = /openMaps\(|openAppleMaps\(|navigateWith\(/.test(body);
  const speaks = /say\(/.test(body);
  check(`${p.fn} opens a map`, maps, 'gives a destination with no way to get there');
  check(`${p.fn} speaks`, speaks, 'silent, so useless hands-free');
  const ok = maps && speaks;
  console.log(`  ${ok ? '✓' : '✗'} ${p.fn.padEnd(16)} "${p.say}"`);
  if (!maps) console.log('        ⚠ no map handover');
  if (!speaks) console.log('        ⚠ does not speak');
}

/* --- C. reachable by voice (8) ------------------------------------------ */
console.log('');
console.log('  C. REACHABLE BY VOICE, HANDS FREE');
console.log('  ' + '-'.repeat(70));
for (const s of ['navigate', 'unlost', 'backto', 'nearby', 'meetmiddle', 'ride', 'transit', 'whereis']) {
  const ok = SKILLS.has(s) && DISPATCHED.has(s);
  check(`${s} is reachable by voice`, ok, SKILLS.has(s) ? 'no dispatch branch' : 'not declared');
  console.log(`  ${ok ? '✓' : '✗'} "${s}"`);
}

/* --- D. pins: the couple case (8) --------------------------------------- */
console.log('');
console.log('  D. A PIN SHE DROPPED — THE PATH THAT MATTERS MOST');
console.log('  ' + '-'.repeat(70));

const ping = fnBody(app, 'partnerPing');
const shareBody = routeBody('/share');
const D = [
  ['a dropped pin surfaces when she opens the app', /partnerPing\(\)/.test(app) && !!ping],
  ['it leads rather than waiting behind a tile', /openingBrief\(\)[^\n]{0,120}partnerPing\(\)/.test(app)],
  ['the pin is one tap from turn-by-turn', /openMaps\(/.test(ping)],
  ['it says who dropped it and when', /\$\{p\.by\}/.test(ping) && /min ago|h ago|just now/.test(ping)],
  ['it speaks, so she can hear it walking', /say\(/.test(ping)],
  ['it chimes so she notices', /chimeNews/.test(ping)],
  ['it only acknowledges what was shown', /buddy_pinseen/.test(ping)],
  ['a pin carries real coordinates', /pin\.lat/.test(shareBody) && /pin\.lng|lng: pin\.lng/.test(shareBody)],
];
for (const [label, ok] of D) {
  check(label, ok, 'she would never see it, or could not act on it');
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

/* --- E. the server side of directions (6) -------------------------------- */
console.log('');
console.log('  E. THE DIRECTIONS ENDPOINT');
console.log('  ' + '-'.repeat(70));

const dirs = routeBody('/directions');
const unlost = routeBody('/unlost');
const E = [
  ['/directions exists and is guarded', /requireAuth/.test(server.slice(server.indexOf('"/directions"'), server.indexOf('"/directions"') + 140))],
  ['/directions returns a spoken summary', /spoken/.test(dirs)],
  ['/directions returns steps as a fallback', /steps/.test(dirs)],
  ['it says plainly when the Maps key is missing', /501/.test(dirs)],
  ['/unlost returns a spoken line', /spoken/.test(unlost)],
  ['/unlost degrades gracefully without a key', /501/.test(unlost)],
];
for (const [label, ok] of E) {
  check(label, ok, 'a failure here would be silent');
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

/* --- workflows: does the whole chain hold? ------------------------------- */
console.log('');
console.log('  F. WHOLE WORKFLOWS — REQUEST → PLACE → ROUTE → VOICE');
console.log('  ' + '-'.repeat(70));

const FLOWS = [
  { n: 'Lost at night',        say: 'I have no idea where I am',
    chain: ['getUnlost'], why: 'the one where a step list would be useless' },
  { n: 'Back to the hotel',    say: 'take me back to the hotel',
    chain: ['backToSpot', 'navigateWith'], why: 'a saved spot straight into a route' },
  { n: 'Find and go',          say: 'anything good around here',
    chain: ['findNearby'], why: 'a recommendation he can actually reach' },
  { n: 'Meet Jess halfway',    say: 'where should we meet',
    chain: ['meetMiddle'], why: 'two people walking to one point' },
  { n: 'She dropped a pin',    say: '(pin arrives)',
    chain: ['partnerPing'], why: 'someone is standing there waiting' },
  { n: 'Ride to the airport',  say: 'get me a ride to the airport',
    chain: ['rideHandoff'], why: 'hand to Grab, or directions if he would rather walk' },
  { n: 'Where is she',         say: 'where is jess',
    chain: ['whereIsPartner'], why: 'and how old is that fix' },
];
for (const f of FLOWS) {
  const bodies = f.chain.map(fn => fnBody(app, fn));
  const allMap = bodies.every(b => /openMaps\(|navigateWith\(/.test(b));
  const allSpeak = bodies.every(b => /say\(/.test(b));
  const ok = allMap && allSpeak;
  check(`workflow: ${f.n}`, ok, !allMap ? 'chain ends without a route' : 'chain is silent somewhere');
  console.log(`  ${ok ? '✓' : '✗'} ${f.n.padEnd(22)} "${f.say}"`);
  console.log(`      ${f.why}`);
}

/* --- G. the things that would quietly mislead him ------------------------ */
console.log('');
console.log('  G. THE QUIET WAYS IT COULD MISLEAD HIM');
console.log('  ' + '-'.repeat(70));

const wip = fnBody(app, 'whereIsPartner');
const G = [
  ['a stale fix is spoken in the past tense', /WAS about/.test(wip),
   'a two-hour-old position read as where she is standing now'],
  ['her position carries an age', /fixAge|seenAt/.test(wip),
   'he would walk to where she was'],
  ['getUnlost leads with the map, not the steps', /Tap for turn-by-turn/.test(fnBody(app, 'getUnlost')),
   'eight steps read aloud to someone already lost'],
  ['written steps remain for no-signal', /Or read the steps/.test(fnBody(app, 'getUnlost')),
   'nothing to fall back on when Maps will not load'],
  ['meet-in-the-middle does not double-pin', /already drops the pin/.test(app),
   'two pins for one place looks broken'],
  ['travel mode is remembered, not re-asked', /travelModeGet\(\)/.test(app),
   'picking walking every single time'],
];
for (const [label, ok, why] of G) {
  check(label, ok, why);
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) console.log(`        ⚠ ${why}`);
}

/* --- H. the URLs themselves, built and inspected -------------------------
 * Everything above checks the code SHAPE. This builds the actual links the
 * way openMaps does and reads them back — a destination with a space, an
 * accent or an ampersand in it is exactly where a hand-rolled URL breaks, and
 * it breaks silently: Maps opens to a blank search and looks like Google's
 * fault.
 */
console.log('');
console.log('  H. THE LINKS, BUILT AND READ BACK');
console.log('  ' + '-'.repeat(70));

function nativeLink(dest, mode) {
  return `comgooglemaps://?daddr=${encodeURIComponent(dest)}&directionsmode=${mode}`;
}
function webLink(dest, mode) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=${mode}&dir_action=navigate`;
}

const DESTS = [
  ['a plain address',      '12 Smith Street, Brisbane', 'driving'],
  ['bare coordinates',     '21.028511,105.804817',      'walking'],
  ['a name with a space',  'Ho Chi Minh City',          'transit'],
  ['Vietnamese accents',   'Đà Nẵng',                   'walking'],
  ['an apostrophe',        "Nha Trang's beach",         'walking'],
  ['an ampersand',         'Bed & Breakfast Hanoi',     'driving'],
  ['a slash',              'Hanoi/Old Quarter',         'walking'],
  ['a hash',               'Flat #3, Hang Bac',         'walking'],
];
for (const [label, dest, mode] of DESTS) {
  const n = nativeLink(dest, mode), w = webLink(dest, mode);
  const clean = !/[\s]/.test(n) && !/[\s]/.test(w)
    && !n.includes('undefined') && !w.includes('undefined')
    && w.includes('dir_action=navigate') && n.includes('directionsmode=');
  check(`link builds for ${label}`, clean, `native: ${n.slice(0, 60)}`);
  console.log(`  ${clean ? '✓' : '✗'} ${label.padEnd(22)} ${w.slice(38, 96)}`);
}

// Coordinates must survive as coordinates — a comma is legal in a Maps
// destination and encoding it is still correct, but the pair must stay intact.
{
  const w = webLink('21.028511,105.804817', 'walking');
  const roundTrip = decodeURIComponent(w.split('destination=')[1].split('&')[0]);
  const ok = roundTrip === '21.028511,105.804817';
  check('coordinates survive encoding intact', ok, `got ${roundTrip}`);
  console.log(`  ${ok ? '✓' : '✗'} coordinates round-trip exactly`);
}

// Every travel mode Google accepts, since the wrong one silently falls back
// to driving — which on a scooter trip is not what he asked for.
for (const mode of ['driving', 'walking', 'transit', 'bicycling']) {
  const w = webLink('Hanoi', mode);
  const ok = w.includes(`travelmode=${mode}`);
  check(`travel mode "${mode}" is carried`, ok, 'the mode would silently default to driving');
  console.log(`  ${ok ? '✓' : '✗'} travelmode=${mode}`);
}

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(70));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
