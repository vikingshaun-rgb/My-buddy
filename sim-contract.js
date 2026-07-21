'use strict';
/* sim-contract.js — the Swift client and the brain must not drift apart.
 *
 * VisionBrain.swift makes promises about the server: that these endpoints
 * exist, that every reply carries a spoken line, that the handshake names which
 * skills need a camera. Every one of those is a thing a future batch could
 * quietly break — and the cost of finding out is a rented Mac and a confused
 * afternoon.
 *
 * So this checks the two sides against each other, in the one place where
 * being wrong is most expensive.
 *
 * Run: node sim-contract.js
 */

const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const swift = fs.readFileSync('VisionBrain.swift', 'utf8');
const smoke = fs.readFileSync('smoke-live.js', 'utf8');

let pass = 0, fail = 0;
const problems = [];
function check(name, ok, why) {
  if (ok) { pass++; return true; }
  fail++; problems.push(`${name}${why ? ' — ' + why : ''}`);
  return false;
}
function line(ok, text, extra) { console.log(`  ${ok ? '✓' : '✗'} ${text}${extra ? '  ' + extra : ''}`); }

const helloBody = server.slice(server.indexOf('app.post("/native/hello"'), server.indexOf('app.post("/native/ping"'));
const routes = new Set([...server.matchAll(/app\.post\("\/([^"]+)"/g)].map(m => m[1]));

console.log('');
console.log('  NATIVE CONTRACT — SWIFT AND THE BRAIN, IN STEP');
console.log('  ' + '='.repeat(68));

/* --- 1. every endpoint Swift maps to must exist -------------------------- */
console.log('');
console.log('  EVERY ENDPOINT SWIFT CALLS MUST EXIST');
console.log('  ' + '-'.repeat(68));
{
  const mapped = [...swift.matchAll(/return "([a-z/]+)"/g)].map(m => m[1]);
  const missing = mapped.filter(m => !routes.has(m));
  const ok = check('the skill→endpoint map resolves', missing.length === 0,
    `${missing.join(', ')} — the app would 404 on a rented Mac`);
  line(ok, `${mapped.length} mapped endpoints, ${missing.length} missing`);

  // The four the client hits directly, not via the map.
  for (const p of ['route', 'chat', 'native/hello', 'native/ping', 'watchers']) {
    const ok2 = check(`/${p} exists`, routes.has(p));
    line(ok2, `/${p}`);
  }
}

/* --- 2. the handshake must send what Swift decodes ---------------------- */
console.log('');
console.log('  THE HANDSHAKE MUST SEND WHAT SWIFT DECODES');
console.log('  ' + '-'.repeat(68));
{
  // A Decodable struct with a missing non-optional field throws at runtime,
  // which on iOS means the app dies on launch with nothing useful logged.
  const required = ['contract', 'skills', 'have', 'limits',
                    'needsImage', 'needsLocation', 'confirmFirst',
                    'imageMaxBase64Bytes', 'imageMinEdgePx', 'imageRecommendedMaxEdgePx',
                    'callsPerMinute', 'requestTimeoutMs', 'name', 'what'];
  const absent = required.filter(f => !helloBody.includes(f));
  const ok = check('every field Swift requires is sent', absent.length === 0,
    `${absent.join(', ')} — Decodable would throw on launch`);
  line(ok, `${required.length} required fields, ${absent.length} absent`);

  const ok2 = check('the handshake is versioned', /contract: 1/.test(helloBody),
    'no way to tell an old app it needs updating');
  line(ok2, 'contract version sent');

  const ok3 = check('Swift reads the same version', /let contract: Int/.test(swift));
  line(ok3, 'Swift decodes it');
}

/* --- 3. the spoken promise ---------------------------------------------- */
console.log('');
console.log('  THE PROMISE THE WHOLE DESIGN RESTS ON');
console.log('  ' + '-'.repeat(68));
{
  // If this stops being true, the thin connector becomes a rewrite.
  const ok = check('the brain declares it always speaks', /alwaysSpeaks: true/.test(helloBody));
  line(ok, 'handshake promises a spoken line on every reply');

  const ok2 = check('Swift relies on exactly that', /var speakable/.test(swift),
    'the client would need per-endpoint field mappings');
  line(ok2, 'one `speakable` accessor, not 100 mappings');

  // And the promise must actually hold.
  const marks = [...server.matchAll(/app\.post\("(\/[^"]+)"/g)].map(m => ({ at: m.index, p: m[1] }));
  marks.push({ at: server.length, p: 'END' });
  const SILENT = new Set(['/route', '/lifelog', '/pending', '/keys', '/memory', '/profile', '/state']);
  const mute = [];
  for (let i = 0; i < marks.length - 1; i++) {
    let b = server.slice(marks[i].at, marks[i + 1].at);
    const cut = b.search(/\n(?:async function|function|const)\s/);
    if (cut > 0) b = b.slice(0, cut);
    if (/callClaude/.test(b) && !SILENT.has(marks[i].p) && !/spoken/.test(b)) mute.push(marks[i].p);
  }
  const ok3 = check('and the promise actually holds', mute.length === 0, mute.join(', '));
  line(ok3, `${mute.length} endpoints that could not be spoken`);
}

/* --- 4. the client is told what it must do itself ----------------------- */
console.log('');
console.log('  THE CLIENT MUST KNOW WHAT IS ITS JOB');
console.log('  ' + '-'.repeat(68));
{
  const ok = check('the handshake lists client responsibilities', /clientMustHandle/.test(helloBody),
    'a native build would discover these one wasted afternoon at a time');
  line(ok, 'wake word, STT, speaking, camera, push, location, confirmation');

  const ok2 = check('Swift implements speaking', /AVSpeechSynthesizer/.test(swift));
  line(ok2, 'AVSpeechSynthesizer');
  const ok3 = check('Swift implements listening', /SFSpeechRecognizer/.test(swift));
  line(ok3, 'SFSpeechRecognizer');
  const ok4 = check('Swift implements capture sizing', /maxEdge/.test(swift) && /base64EncodedString/.test(swift));
  line(ok4, 'downscale then base64');

  // The single biggest reason to go native at all.
  const ok5 = check('Swift implements barge-in', /stopSpeaking\(at: \.immediate\)/.test(swift),
    'the one thing the web app can never do');
  line(ok5, 'he can cut it off mid-sentence');
  const ok6 = check('interrupts are checked on PARTIAL results', /shouldReportPartialResults = true/.test(swift) && /Speaker\.shared\.speaking/.test(swift),
    'a stop word would only land after the sentence finished');
  line(ok6, '"stop" lands mid-word, not after');
}

/* --- 5. the client must not reimplement the brain ----------------------- */
console.log('');
console.log('  THE CLIENT MUST NOT SECOND-GUESS THE BRAIN');
console.log('  ' + '-'.repeat(68));
{
  // The whole failure mode of a fat client: logic drifting out of step with
  // the server and nobody noticing until something behaves differently.
  const ok = check('Swift always routes rather than pattern-matching', /post\("route"/.test(swift),
    'local matching drifts from the router the moment a skill changes');
  line(ok, 'every utterance goes to /route');

  const ok2 = check('Swift asks which skills need a camera', /needsImage/.test(swift),
    'it would open the camera speculatively, or fail after the fact');
  line(ok2, 'camera opens only when the skill needs it');

  const ok3 = check('Swift confirms before a shared write', /confirmFirst/.test(swift),
    "a mis-heard word would tick something off his wife's list");
  line(ok3, 'confirmFirst is honoured');

  const ok4 = check('Swift stores nothing it should not', !/UserDefaults/.test(swift.replace(/VisionConfig[\s\S]{0,900}/, '')),
    'a second memory on the phone would diverge from the brain');
  line(ok4, 'only the URL and token are kept locally');
}

/* --- 6. watchers: acknowledge only what was shown ----------------------- */
console.log('');
console.log('  THE WATCHER LESSON MUST SURVIVE INTO SWIFT');
console.log('  ' + '-'.repeat(68));
{
  // The web app lost findings by acknowledging everything on read. A native
  // client written naively would make the identical mistake.
  const ok = check('the server still does not auto-acknowledge', !/action === "latest"[\s\S]{0,300}STORE\.seen\[uid\] = Date\.now\(\)/.test(server));
  line(ok, 'reading does not mark seen');

  const ok2 = check('Swift acknowledges only what it displayed', /"action": "seen"/.test(swift) && /prefix\(3\)/.test(swift),
    'a fourth overnight finding would vanish with no trace');
  line(ok2, 'seen is sent after showing, up to the newest shown');
}

/* --- 7. the smoke test must cover the same ground ----------------------- */
console.log('');
console.log('  THE SMOKE TEST MUST CHECK WHAT SWIFT DEPENDS ON');
console.log('  ' + '-'.repeat(68));
{
  const covers = [
    ['reaches the brain at all', /native\/ping/.test(smoke)],
    ['proves the lock works', /wrong token is refused/.test(smoke)],
    ['fetches the handshake', /native\/hello/.test(smoke)],
    ['proves the model responds', /\/chat/.test(smoke)],
    ['proves routing works', /\/route/.test(smoke)],
    ['proves failure is speakable', /fail in words|fails? in words/i.test(smoke)],
    ['reports how slow it is', /average/.test(smoke)],
    ['never writes to his data', !/tick\/confirm|sms\/send|mail\/send/.test(smoke)],
  ];
  for (const [label, ok] of covers) {
    check(`smoke test ${label}`, ok);
    line(ok, label);
  }
}

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(68));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
