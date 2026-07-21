'use strict';
/* sim-attention.js — does it know when to shut up?
 *
 * 104 skills, eight advisors, watchers and a weather feed. Every one has
 * something it could say. Without judgement about WHEN, more capability makes
 * Vision worse: an assistant that speaks every time gets muted, and then the
 * one thing that mattered goes past unheard.
 *
 * Google killed Assistant's proactive cards for exactly this. Siri and Alexa
 * volunteer almost nothing on purpose.
 *
 * So the interesting tests here are all NEGATIVE — the ones where the correct
 * behaviour is silence. Anyone can build something that talks.
 *
 * Run: node sim-attention.js
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
function line(ok, text, extra) { console.log(`  ${ok ? '✓' : '✗'} ${text}${extra ? '  ' + extra : ''}`); }

/* --- stand the gate up over a fake store -------------------------------- */
const STORE = {};
const UID = 'sim';
function reset() {
  STORE.convoLive = { [UID]: null };
  STORE.calToday = { [UID]: { jobs: [] } };
  STORE.scenes = { [UID]: {} };
  STORE.dismissed = { [UID]: {} };
  // Deliberately Australia: the container runs UTC, and the night check now
  // reads HIS timezone. Without a country the check correctly does nothing,
  // but then the daytime cases would never be exercised at all.
  STORE.profiles = { [UID]: { country: 'Australia' } };
}

const start = server.indexOf('const ATTENTION = {');
const end = server.indexOf('app.post("/attention/digest"');
fs.writeFileSync('/tmp/_att.js',
  'let STORE;\nmodule.exports.setStore = s => { STORE = s; };\n' +
  'function profileOf(uid){ return (STORE.profiles||{})[uid] || {}; }\n' +
  'function saveStore(){}\nfunction dlog(){}\n' +
  'let _advise = () => [];\nmodule.exports.setAdvise = f => { _advise = f; };\n' +
  'function advise(uid, o){ return _advise(uid, o); }\n' +
  server.slice(start, end) +
  '\nmodule.exports = Object.assign(module.exports, {attention, situation, tierOf, dismiss, isDismissed, attentionBrief, ATTENTION});');
const A = require('/tmp/_att.js');
A.setStore(STORE);

const MIN = 60000, HOUR = 3600000;
const note = (kind, text, weight) => ({ kind, note: text, weight: weight || 50 });

console.log('');
console.log('  THE ATTENTION LAYER — DOES IT KNOW WHEN TO SHUT UP?');
console.log('  ' + '='.repeat(68));

/* --- 1. what counts as urgent ------------------------------------------- */
console.log('');
console.log('  ONLY A REAL DEADLINE INTERRUPTS');
console.log('  ' + '-'.repeat(68));
{
  const cases = [
    ['a job while he is 3h behind',      note('timezone', 'Chermside is 4:30 AEST — 1:30 your time', 95), 'now'],
    ['a storm about to hit',             note('storm', 'Heavy rain in 15 minutes', 90), 'now'],
    ['a booking inside the hour',        note('booking', 'Hotel check-in is inside an hour', 85), 'now'],
    ['a booking tomorrow',               note('booking', 'Hotel tomorrow at 2', 70), 'later'],
    ['weather against an outdoor plan',  note('weather', 'Halong Bay cruise is outdoors', 55), 'offer'],
    ['a tight gap between plans',        note('tight', 'Only 20 minutes between those', 80), 'offer'],
    ['newly arrived, unbriefed',         note('arrival', 'Two days in Vietnam', 50), 'offer'],
    ['spending above his usual',         note('spend', 'Today is 60% above your usual', 60), 'later'],
    ['a job with no report written',     note('job', 'Job 1295115 has no service description', 90), 'later'],
    ['an unfinished flow',               note('pending', 'You started booking the Sapa train', 65), 'later'],
  ];
  for (const [label, item, want] of cases) {
    const got = A.tierOf(item);
    const ok = check(`"${label}" is ${want}`, got === want, `got ${got}`);
    line(ok, label.padEnd(36), `→ ${got}`);
  }
}

/* --- 2. when he is busy, it holds --------------------------------------- */
console.log('');
console.log('  WHEN HE IS BUSY, IT HOLDS');
console.log('  ' + '-'.repeat(68));
{
  const items = [note('weather', 'Rain later', 55), note('spend', 'Spending is up', 60)];

  reset();
  STORE.convoLive[UID] = { at: Date.now(), turns: [{ text: 'hello' }] };
  let a = A.attention(UID, items);
  let ok = check('silent mid-conversation', a.offer.length === 0 && a.now.length === 0,
    'it would talk over him while he is talking to a person');
  line(ok, 'mid-conversation with someone'.padEnd(36), `held ${a.held.length}`);

  reset();
  STORE.calToday[UID] = { jobs: [{ title: 'Geeks2U 1295115', startMs: Date.now() - 20 * MIN }] };
  a = A.attention(UID, items);
  ok = check('silent during a job', a.offer.length === 0, 'spending advice mid-job');
  line(ok, 'on a job right now'.padEnd(36), `held ${a.held.length}`);

  reset();
  STORE.scenes[UID] = { chermside: [{ at: Date.now() - 5 * MIN }] };
  a = A.attention(UID, items);
  ok = check('silent just after a scene capture', a.offer.length === 0, 'he is elbows-deep in something');
  line(ok, 'just captured a scene'.padEnd(36), `held ${a.held.length}`);

  // But a real deadline still gets through — that is the whole point of tiers.
  reset();
  STORE.convoLive[UID] = { at: Date.now(), turns: [{ text: 'hi' }] };
  a = A.attention(UID, [note('storm', 'Storm in 10 minutes', 90)]);
  ok = check('a storm still gets through', a.now.length === 1,
    'the one thing worth interrupting for would be held');
  line(ok, 'storm during a conversation'.padEnd(36), `spoken now`);
}

/* --- 3. when he is free ------------------------------------------------- */
console.log('');
console.log('  WHEN HE IS FREE, IT OFFERS — ONCE');
console.log('  ' + '-'.repeat(68));
{
  reset();
  const a = A.attention(UID, [
    note('weather', 'Beach day is outdoors', 55),
    note('arrival', 'Two days in Vietnam', 50),
    note('tight', 'Only 20 min between those', 80),
  ]);
  let ok = check('at most one offer at a time', a.offer.length <= 1, `${a.offer.length} offers`);
  line(ok, 'three offerable things'.padEnd(36), `${a.offer.length} offered, ${a.held.length} held`);

  ok = check('the rest are held, not dropped', a.held.length >= 2, 'they would be lost entirely');
  line(ok, 'the others wait for the digest');
}

/* --- 4. dismissal has to mean something --------------------------------- */
console.log('');
console.log('  "NOT NOW" HAS TO STICK');
console.log('  ' + '-'.repeat(68));
{
  reset();
  const item = note('spend', 'Today is 60% above your usual', 60);
  A.dismiss(UID, 'spend', item.note, 'once');

  let a = A.attention(UID, [item]);
  let ok = check('a dismissed item stays dismissed', a.offer.length === 0 && a.now.length === 0,
    'the single most annoying failure — it comes back an hour later');
  line(ok, 'brushed off, then offered again?'.padEnd(36), 'no');

  ok = check('and it says WHY it is holding it', a.held[0] && /brushed/.test(a.held[0].why));
  line(ok, 'held with a reason');

  // Different scopes must actually differ, or "stop telling me this" is a lie.
  reset();
  A.dismiss(UID, 'spend', 'x', 'once');
  const onceUntil = STORE.dismissed[UID]['spend:x'].until;
  reset();
  A.dismiss(UID, 'spend', 'x', 'trip');
  const tripUntil = STORE.dismissed[UID]['spend:x'].until;
  ok = check('"whole trip" lasts much longer than "not now"', tripUntil > onceUntil + 20 * 24 * HOUR,
    'the scopes are cosmetic');
  line(ok, 'once vs trip'.padEnd(36),
    `${Math.round((onceUntil - Date.now()) / HOUR)}h vs ${Math.round((tripUntil - Date.now()) / 24 / HOUR)}d`);

  // A dismissal must expire, or one "not now" silences it forever.
  reset();
  STORE.dismissed[UID] = { 'spend:old': { until: Date.now() - HOUR } };
  ok = check('an expired dismissal stops applying', !A.isDismissed(UID, 'spend', 'old'),
    'one "not now" would silence it permanently');
  line(ok, 'expired dismissal'.padEnd(36), 'no longer suppresses');
}

/* --- 5. asking overrides everything ------------------------------------- */
console.log('');
console.log('  IF HE ASKS, HE GETS IT');
console.log('  ' + '-'.repeat(68));
{
  reset();
  STORE.calToday[UID] = { jobs: [{ title: 'job', startMs: Date.now() - 10 * MIN }] };
  const items = [note('spend', 'Spending up', 60), note('job', 'No report yet', 90)];
  const a = A.attention(UID, items, { asked: true });
  const ok = check('a direct question bypasses the gate', a.now.length === items.length,
    'the gate is about UNPROMPTED speech, not about refusing him');
  line(ok, 'asked while busy'.padEnd(36), `${a.now.length} returned`);
}

/* --- 6. the brief tells the model what it may say ----------------------- */
console.log('');
console.log('  THE BRIEF MUST GRANT PERMISSION, NOT JUST SUPPLY FACTS');
console.log('  ' + '-'.repeat(68));
{
  reset();
  A.setAdvise(() => [note('storm', 'Storm in 10 minutes', 90)]);
  let brief = A.attentionBrief(UID);
  let ok = check('an urgent thing is marked to say first', /SAY THIS FIRST/.test(brief));
  line(ok, 'urgent → "say this first"');

  A.setAdvise(() => [note('weather', 'Beach day is outdoors', 55)]);
  brief = A.attentionBrief(UID);
  ok = check('an offer is framed as ignorable', /one short line he can ignore/.test(brief),
    'it would announce instead of offering');
  line(ok, 'offer → "a line he can ignore"');

  STORE.convoLive[UID] = { at: Date.now(), turns: [{ text: 'hi' }] };
  A.setAdvise(() => [note('spend', 'Spending up', 60)]);
  brief = A.attentionBrief(UID);
  ok = check('held items are explicitly NOT to be mentioned', /Do not mention them/.test(brief),
    'the model would fill the silence with them anyway');
  line(ok, 'held → "do not mention"');

  reset();
  A.setAdvise(() => []);
  ok = check('nothing to say produces an empty brief', A.attentionBrief(UID) === '',
    'an empty section still invites the model to say something');
  line(ok, 'nothing → empty string');
}

/* --- 7. wired in properly ----------------------------------------------- */
console.log('');
console.log('  WIRED IN, NOT BOLTED ON');
console.log('  ' + '-'.repeat(68));
{
  let ok = check('the chat brief goes through the gate', /advice: attentionBrief/.test(server),
    'the raw advisor feed would bypass it entirely');
  line(ok, '/chat uses attentionBrief, not adviceBrief');

  ok = check('dismissals survive a new phone', /"dismissed"/.test(server.slice(server.indexOf('const buckets'), server.indexOf('const buckets') + 800)),
    'every "stop telling me this" forgotten on a new device');
  line(ok, 'in the recovery bucket');

  ok = check('he can ask what it is holding', /attention\/status/.test(server) && /attentionStatus/.test(app),
    'silence would be indistinguishable from being broken');
  line(ok, '"what are you sitting on?"');

  ok = check('each digest item can be dismissed on the spot', /attentionDismiss\(it\.kind/.test(app),
    'dismissing must be as easy as hearing, or he never bothers');
  line(ok, 'one tap to brush something off');

  ok = check('the night is quiet', /middle of the night/.test(server),
    'a landmark offer at 3am');
  line(ok, 'nothing but emergencies overnight');

  // The bug this suite found: the night check used the SERVER clock. Render
  // runs UTC, so it would have gone quiet at 11pm UTC — 6am in Hanoi. Silent
  // all morning, chatty at midnight. Exactly backwards.
  ok = check('night is judged in HIS timezone, not the server\'s', /COUNTRY_TZ/.test(server),
    'quiet all morning and chatty at midnight');
  line(ok, 'uses his country, not Render\'s UTC clock');

  ok = check('no country means no guess', /hour !== null/.test(server),
    'a guessed timezone silences him at the wrong hours');
  line(ok, 'unknown location → no quiet window');
}

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(68));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
