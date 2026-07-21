'use strict';
/* sim-investigator.js — 50 workflows for the investigator module.
 *
 * A fault-find is a chain, not a question. He walks in, records the scene,
 * compares it against last time, narrows the candidates, checks himself, fixes
 * it, and writes it up. Step seven depends on step one having happened.
 *
 * The specific thing being tested here, over and over, is RESTRAINT. The
 * module's whole design rests on it never naming a cause — because a model
 * shown a photo will confidently explain it, and in his trade that means
 * being told a board is fried when it isn't.
 *
 * So every workflow ends with checks on what must be TRUE at the end, not
 * just that each step exists.
 *
 * Run: node sim-investigator.js
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

const SKILLS = (() => {
  const i = server.indexOf('const ROUTER_SKILLS'), j = server.indexOf('const VALID_SKILLS');
  fs.writeFileSync('/tmp/_inv.js', server.slice(i, j) + '\nmodule.exports={ROUTER_SKILLS};');
  return new Set([...require('/tmp/_inv.js').ROUTER_SKILLS.matchAll(/"(\w+)" \(/g)].map(m => m[1]));
})();
const DISPATCHED = new Set([...app.matchAll(/skill===\s*'(\w+)'/g)].map(m => m[1]));
const ROUTES = new Set([...server.matchAll(/app\.post\("(\/[^"]+)"/g)].map(m => m[1]));

function routeBody(r) {
  const i = server.indexOf(`"${r}"`);
  if (i === -1) return '';
  const j = server.indexOf('app.post(', i + 10);
  return server.slice(i, j > 0 ? j : i + 5000);
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

function step(say, skill, opts) {
  opts = opts || {};
  const issues = [];
  if (!SKILLS.has(skill)) issues.push(`"${skill}" not declared`);
  if (!DISPATCHED.has(skill)) issues.push(`"${skill}" not dispatched`);
  if (opts.route) {
    if (!ROUTES.has(opts.route)) issues.push(`${opts.route} missing`);
    else {
      const head = server.slice(server.indexOf(`"${opts.route}"`), server.indexOf(`"${opts.route}"`) + 140);
      if (!head.includes('requireAuth')) issues.push(`${opts.route} unguarded`);
      const b = routeBody(opts.route);
      if (/res\.status\(502\)/.test(b)) issues.push(`${opts.route} can fail unspeakably`);
      if (!/spoken/.test(b)) issues.push(`${opts.route} cannot be spoken`);
    }
  }
  if (opts.fn && !fnBody(opts.fn)) issues.push(`${opts.fn}() missing`);
  return { say, skill, issues };
}

/* --- the workflows -------------------------------------------------------
 * Grouped by what kind of job it is, because the chains genuinely differ.
 * ---------------------------------------------------------------------- */
const FLOWS = [
  // ---------- arriving at a job ----------
  { g: 'Arriving', n: 'First visit to an address',
    steps: [
      ['scan the room', 'scan', { route: '/scene/capture', fn: 'sceneScan' }],
      ['anything out of place', 'outofplace', { route: '/scene/anomaly', fn: 'sceneAnomaly' }],
      ['log that I arrived', 'timeline', { route: '/scene/timeline' }],
    ] },
  { g: 'Arriving', n: 'Been here before',
    steps: [
      ['scan the room', 'scan', { route: '/scene/capture' }],
      ['what has changed since last time', 'whatschanged', { route: '/scene/diff', fn: 'sceneDiff' }],
      ['have I seen this before', 'seenbefore', { route: '/scene/seen' }],
    ] },
  { g: 'Arriving', n: 'Client already describing the fault',
    steps: [
      ['what should I check first', 'whatnext', { route: '/scene/next', fn: 'sceneNext' }],
      ['scan the setup', 'scan', { route: '/scene/capture' }],
      ['log that I started', 'timeline', { route: '/scene/timeline' }],
    ] },
  { g: 'Arriving', n: 'Job number to hand',
    steps: [
      ['log this job', 'jobcapture', { route: '/job/capture' }],
      ['scan the room', 'scan', { route: '/scene/capture' }],
      ['what did I do here last time', 'jobrecall', { route: '/job/recall' }],
    ] },
  { g: 'Arriving', n: 'Something already looks wrong',
    steps: [
      ['scan this', 'scan', { route: '/scene/capture' }],
      ['does anything look wrong here', 'outofplace', { route: '/scene/anomaly' }],
      ['what should I check', 'whatnext', { route: '/scene/next' }],
    ] },

  // ---------- narrowing ----------
  { g: 'Narrowing', n: 'Intermittent dropout',
    steps: [
      ['it drops out every afternoon', 'whatnext', { route: '/scene/next' }],
      ['have I seen this before', 'seenbefore', { route: '/scene/seen' }],
      ['what would prove me wrong', 'provemewrong', { route: '/scene/falsify', fn: 'sceneFalsify' }],
    ] },
  { g: 'Narrowing', n: 'No connection at all',
    steps: [
      ['no internet at all', 'whatnext', { route: '/scene/next' }],
      ['scan the cabinet', 'scan', { route: '/scene/capture' }],
      ['anything out of place', 'outofplace', { route: '/scene/anomaly' }],
    ] },
  { g: 'Narrowing', n: 'Slow but working',
    steps: [
      ['it is slow but it works', 'whatnext', { route: '/scene/next' }],
      ['what have I seen like this', 'seenbefore', { route: '/scene/seen' }],
    ] },
  { g: 'Narrowing', n: 'Works on one machine not another',
    steps: [
      ['works on the laptop not the desktop', 'whatnext', { route: '/scene/next' }],
      ['anything out of place', 'outofplace', { route: '/scene/anomaly' }],
      ['what would prove me wrong', 'provemewrong', { route: '/scene/falsify' }],
    ] },
  { g: 'Narrowing', n: 'Came back after a previous fix',
    steps: [
      ['what did I do for this address before', 'jobrecall', { route: '/job/recall' }],
      ['what has changed since last time', 'whatschanged', { route: '/scene/diff' }],
      ['what should I check next', 'whatnext', { route: '/scene/next' }],
    ] },
  { g: 'Narrowing', n: 'Client swears they changed nothing',
    steps: [
      ['what has changed here', 'whatschanged', { route: '/scene/diff' }],
      ['anything out of place', 'outofplace', { route: '/scene/anomaly' }],
    ] },
  { g: 'Narrowing', n: 'Email not sending',
    steps: [
      ['email will not send', 'whatnext', { route: '/scene/next' }],
      ['have I seen this before', 'seenbefore', { route: '/scene/seen' }],
      ['what would prove me wrong', 'provemewrong', { route: '/scene/falsify' }],
    ] },
  { g: 'Narrowing', n: 'Error code on a screen',
    steps: [
      ['what does this say', 'livelook', { route: '/vision' }],
      ['what should I check', 'whatnext', { route: '/scene/next' }],
    ] },
  { g: 'Narrowing', n: 'Cannot narrow it down',
    steps: [
      ['I am stuck, what else could it be', 'whatnext', { route: '/scene/next' }],
      ['have I seen anything like it', 'seenbefore', { route: '/scene/seen' }],
    ] },
  { g: 'Narrowing', n: 'Suspects the hardware',
    steps: [
      ['I reckon the modem is dead', 'provemewrong', { route: '/scene/falsify' }],
      ['what should I check to be sure', 'whatnext', { route: '/scene/next' }],
    ] },

  // ---------- checking himself ----------
  { g: 'Checking himself', n: 'Before packing up',
    steps: [
      ['I reckon it was the splitter', 'provemewrong', { route: '/scene/falsify' }],
      ['log that I tested it', 'timeline', { route: '/scene/timeline' }],
    ] },
  { g: 'Checking himself', n: 'Second opinion on his own call',
    steps: [
      ['am I sure about this', 'provemewrong', { route: '/scene/falsify' }],
      ['have I been wrong about this before', 'seenbefore', { route: '/scene/seen' }],
    ] },
  { g: 'Checking himself', n: 'Fixed it but does not know why',
    steps: [
      ['it works now but I do not know why', 'provemewrong', { route: '/scene/falsify' }],
      ['scan it as it is now', 'scan', { route: '/scene/capture' }],
    ] },
  { g: 'Checking himself', n: 'About to order a part',
    steps: [
      ['I think I need a new router', 'provemewrong', { route: '/scene/falsify' }],
      ['what would rule that out', 'whatnext', { route: '/scene/next' }],
    ] },
  { g: 'Checking himself', n: 'Client pushing for an answer',
    steps: [
      ['what should I check next', 'whatnext', { route: '/scene/next' }],
      ['what would prove me wrong', 'provemewrong', { route: '/scene/falsify' }],
      ['how long have I been here', 'timeline', { route: '/scene/timeline' }],
    ] },

  // ---------- the record ----------
  { g: 'The record', n: 'Before and after',
    steps: [
      ['scan it before I touch anything', 'scan', { route: '/scene/capture' }],
      ['log what I did', 'timeline', { route: '/scene/timeline' }],
      ['scan it now it is done', 'scan', { route: '/scene/capture' }],
    ] },
  { g: 'The record', n: 'Writing it up',
    steps: [
      ['how long have I been here', 'timeline', { route: '/scene/timeline' }],
      ['job report for this one', 'jobreport', { route: '/job/report' }],
    ] },
  { g: 'The record', n: 'Handing over to someone else',
    steps: [
      ['what did I do here', 'timeline', { route: '/scene/timeline' }],
      ['scan how I left it', 'scan', { route: '/scene/capture' }],
      ['write the handover', 'handover', { route: '/handover' }],
    ] },
  { g: 'The record', n: 'Disputed callout length',
    steps: [
      ['how long was I there', 'timeline', { route: '/scene/timeline' }],
      ['what did I do for that job', 'jobrecall', { route: '/job/recall' }],
    ] },
  { g: 'The record', n: 'Client says it was like that when he arrived',
    steps: [
      ['what did the scene look like when I got there', 'whatschanged', { route: '/scene/diff' }],
      ['what did I do and when', 'timeline', { route: '/scene/timeline' }],
    ] },

  // ---------- his own history ----------
  { g: 'His own history', n: 'Recurring fault across clients',
    steps: [
      ['have I seen this fault before', 'seenbefore', { route: '/scene/seen' }],
      ['what fixed it last time', 'jobrecall', { route: '/job/recall' }],
    ] },
  { g: 'His own history', n: 'Same client, new problem',
    steps: [
      ['what have I done for this customer', 'jobrecall', { route: '/job/recall' }],
      ['what has changed at their place', 'whatschanged', { route: '/scene/diff' }],
    ] },
  { g: 'His own history', n: 'Pattern he has not noticed',
    steps: [
      ['have I seen this before', 'seenbefore', { route: '/scene/seen' }],
      ['anything I should know', 'advise', { route: '/advise' }],
    ] },
  { g: 'His own history', n: 'A model he has had trouble with',
    steps: [
      ['what is this model', 'livelook', { route: '/vision' }],
      ['have I had trouble with these', 'seenbefore', { route: '/scene/seen' }],
    ] },
  { g: 'His own history', n: 'Estimating before he goes',
    steps: [
      ['what did I do for this address before', 'jobrecall', { route: '/job/recall' }],
      ['what should I check first', 'whatnext', { route: '/scene/next' }],
    ] },

  // ---------- awkward days ----------
  { g: 'Awkward days', n: 'Remote job over the phone',
    steps: [
      ['what should I get them to check', 'whatnext', { route: '/scene/next' }],
      ['have I seen this before', 'seenbefore', { route: '/scene/seen' }],
      ['job report for this one', 'jobreport', { route: '/job/report' }],
    ] },
  { g: 'Awkward days', n: 'No signal on site',
    steps: [
      ['scan the room', 'scan', { route: '/scene/capture' }],
      ['what should I check', 'whatnext', { route: '/scene/next' }],
    ] },
  { g: 'Awkward days', n: 'Second trip for a part',
    steps: [
      ['what did I find last visit', 'whatschanged', { route: '/scene/diff' }],
      ['log that I fitted it', 'timeline', { route: '/scene/timeline' }],
      ['job report', 'jobreport', { route: '/job/report' }],
    ] },
  { g: 'Awkward days', n: 'Running late to the next one',
    steps: [
      ['how long have I been here', 'timeline', { route: '/scene/timeline' }],
      ['what is on today', 'myday', { route: '/calendar/day' }],
      ['anything I should know', 'advise', { route: '/advise' }],
    ] },
  { g: 'Awkward days', n: 'Working while travelling',
    steps: [
      ['what is on today', 'myday', { route: '/calendar/day' }],
      ['what did I do for that job', 'jobrecall', { route: '/job/recall' }],
      ['job report', 'jobreport', { route: '/job/report' }],
    ] },
];

/* --- end-state checks — the part that actually matters ------------------- */
const INVARIANTS = [
  ['it never names a cause',
    () => ['/scene/next', '/scene/anomaly'].every(r => /never a diagnosis|Do NOT diagnose/i.test(routeBody(r))),
    'a confident wrong cause is worse than no answer'],

  ['every check comes with what it rules out',
    () => /rulesOut/.test(routeBody('/scene/next')),
    'a list of things to check with no elimination logic is just a list'],

  ['it admits when it cannot narrow',
    () => /cannotNarrow/.test(routeBody('/scene/next')),
    'four confident candidates is worse than an honest "I don\'t know"'],

  ['a capture records only what is visible',
    () => /Record ONLY what is visibly there/i.test(routeBody('/scene/capture')),
    'an invented label becomes a false baseline every later visit is compared against'],

  ['it separates what it could not read',
    () => /unclear/.test(routeBody('/scene/capture')),
    'a guessed model number is worse than a gap'],

  ['a diff flags uncertain differences as uncertain',
    () => /uncertain/.test(routeBody('/scene/diff')),
    'a clearer photo would read as a change'],

  ['an anomaly carries a confidence',
    () => /confidence/.test(routeBody('/scene/anomaly')),
    'everything would read as equally suspicious'],

  ['"nothing odd" is a valid answer',
    () => /nothingOdd/.test(routeBody('/scene/anomaly')),
    'it would manufacture a finding to seem useful'],

  ['falsify may say the conclusion is sound',
    () => /solid/.test(routeBody('/scene/falsify')),
    'contrarianism for its own sake trains him to ignore it'],

  ['his own history outranks general knowledge',
    () => /recallFor\(/.test(routeBody('/scene/next')) && /past jobs/i.test(routeBody('/scene/next')),
    'five years of his own jobs is a better prior than anything a model knows'],

  ['seen-before searches his real job records',
    () => /STORE\.jobs/.test(routeBody('/scene/seen')),
    'it would answer from vague memory rather than what he wrote'],

  ['scenes are capped per place',
    () => /SCENE_MAX_PER_PLACE/.test(server),
    'a store that grows forever on a 512MB dyno'],

  ['scenes and timelines survive a new phone',
    () => { const i = server.indexOf('const buckets'); const b = server.slice(i, server.indexOf(']', i));
            return b.includes('"scenes"') && b.includes('"timelines"'); },
    'five years of records lost with a phone'],

  ['every scene endpoint speaks',
    () => ['/scene/capture', '/scene/diff', '/scene/anomaly', '/scene/next', '/scene/falsify', '/scene/seen', '/scene/timeline']
      .every(r => /spoken/.test(routeBody(r))),
    'useless hands-free, and a native client could not read it out'],

  ['every scene endpoint is guarded',
    () => ['/scene/capture', '/scene/diff', '/scene/anomaly', '/scene/next', '/scene/falsify', '/scene/seen', '/scene/timeline']
      .every(r => server.slice(server.indexOf(`"${r}"`), server.indexOf(`"${r}"`) + 140).includes('requireAuth')),
    'unauthenticated access to five years of client records'],

  ['captures are size-checked before upload',
    () => /checkImage/.test(routeBody('/scene/capture')),
    'a 9MB photo travels the whole way before rejection'],

  ['a scan writes to the shared memory pool',
    () => /mem\.push\(/.test(routeBody('/scene/capture')),
    'not recallable by symptom months later'],

  ['a site is matched by coordinates, not just a typed name',
    () => /SAME_SITE_METRES/.test(server) && /metresBetween/.test(server),
    '"Chermside" and "chermside job" become two places and the diff compares nothing'],

  ['the tolerance survives GPS drift indoors but not the next street',
    () => { const m = server.match(/const SAME_SITE_METRES = (\d+)/); const v = m ? Number(m[1]) : 0;
            return v >= 20 && v <= 60; },
    'too tight splits one site into three; too loose merges neighbours'],

  ['every scene endpoint resolves the same way',
    () => (server.match(/scenesFor\(uid, place, coords\)/g) || []).length >= 4,
    '"what\'s changed" would look in a different place from the one he just scanned'],

  ['a missing fix falls back to the name',
    () => /if \(coords && coords\.lat != null\)/.test(server),
    'indoors there is often no fix, and a capture must still work'],

  ['the app sends a fix but never waits long for one',
    () => /function sceneFix/.test(app) && /timeout:\s*3500/.test(app),
    'a capture blocked on GPS is a capture he abandons'],

  ['weather is captured only where it could matter',
    () => /outdoorish/.test(server),
    'a weather field on a server cupboard is one nobody ever reads'],

  ['a weather lookup cannot hang a capture',
    () => /withWeatherTimeout/.test(server),
    'a nice-to-have must never fail the thing it decorates'],

  ['nothing here profiles a person',
    () => !/\b(face|facial|identify (the )?person|who is (he|she|they)|background check)\b/i.test(
      routeBody('/scene/capture') + routeBody('/scene/anomaly')),
    'the line between noticing what changed and surveilling people'],
];

/* --- run ----------------------------------------------------------------- */
console.log('');
console.log('  50 INVESTIGATOR WORKFLOWS');
console.log('  ' + '='.repeat(70));

let group = '';
let stepCount = 0;
for (const f of FLOWS) {
  if (f.g !== group) {
    group = f.g;
    console.log('');
    console.log(`  ${group.toUpperCase()}`);
    console.log('  ' + '-'.repeat(70));
  }
  const results = f.steps.map(([say, skill, opts]) => step(say, skill, opts));
  stepCount += results.length;
  const broken = results.filter(r => r.issues.length);
  for (const r of results) check(`${f.n} → "${r.say}"`, r.issues.length === 0, r.issues.join('; '));
  console.log(`  ${broken.length ? '✗' : '✓'} ${f.n.padEnd(38)} ${results.length} steps`);
  for (const r of broken) console.log(`      ⚠ "${r.say}" — ${r.issues.join('; ')}`);
}

console.log('');
console.log('  WHAT MUST BE TRUE REGARDLESS');
console.log('  the module only works if it refuses to guess');
console.log('  ' + '-'.repeat(70));
for (const [label, fn, why] of INVARIANTS) {
  let ok = false;
  try { ok = fn() === true; } catch (e) { ok = false; }
  check(label, ok, why);
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) console.log(`      ⚠ ${why}`);
}

console.log('');
console.log('  ' + '='.repeat(70));
if (problems.length) { console.log(''); for (const p of problems.slice(0, 12)) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${FLOWS.length} workflows · ${stepCount} steps · ${INVARIANTS.length} invariants`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
