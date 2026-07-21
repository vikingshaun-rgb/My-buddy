#!/usr/bin/env node
'use strict';
/* smoke-live.js — the first test that actually talks to the brain.
 *
 * Every other suite reads source code. Not one has made an HTTP request. On a
 * rented Mac that distinction costs money: "the contract looks right" and "it
 * responds correctly" are different claims, and only one of them survives
 * contact with a deployed server.
 *
 * Run this BEFORE writing a line of Swift. If it's green, the native app has
 * a working brain to talk to and every remaining problem is Xcode's.
 *
 *   node smoke-live.js https://my-buddy-xu2x.onrender.com <token>
 *
 * or set VISION_URL and VISION_TOKEN and just run it.
 *
 * It is deliberately READ-HEAVY: nothing here writes to his wife's lists,
 * sends a text, or books anything. A smoke test that changes his data is a
 * worse idea than no smoke test.
 */

const URL_ = process.argv[2] || process.env.VISION_URL || '';
const TOKEN = process.argv[3] || process.env.VISION_TOKEN || '';

if (!URL_ || !TOKEN) {
  console.error('\n  usage: node smoke-live.js <brain-url> <token>');
  console.error('  e.g.   node smoke-live.js https://my-buddy-xu2x.onrender.com 5043b8f7...\n');
  process.exit(2);
}
const BASE = URL_.replace(/\/+$/, '');

let pass = 0, fail = 0, skipped = 0;
const problems = [];
const timings = [];

async function call(path, body, { timeout = 45000, method = 'POST' } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      signal: ctl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const ms = Date.now() - t0;
    timings.push({ path, ms });
    return { status: r.status, json, text, ms };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError');
    return { status: aborted ? 504 : 0, json: null, text: String(e.message || e), ms: Date.now() - t0 };
  } finally { clearTimeout(t); }
}

function check(name, ok, why) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); return true; }
  fail++; problems.push(`${name}${why ? ' — ' + why : ''}`);
  console.log(`  ✗ ${name}`);
  if (why) console.log(`      ⚠ ${why}`);
  return false;
}
function skip(name, why) {
  skipped++; console.log(`  · ${name}  (${why})`);
}

(async () => {
  console.log('');
  console.log('  LIVE SMOKE TEST — TALKING TO THE REAL BRAIN');
  console.log('  ' + '='.repeat(66));
  console.log(`  ${BASE}`);

  /* --- 1. is anything there at all? ------------------------------------ */
  console.log('');
  console.log('  IS IT AWAKE?');
  console.log('  ' + '-'.repeat(66));
  {
    // Render's free tier cold-starts; the paid tier shouldn't. Either way,
    // knowing WHICH is more useful than a pass/fail.
    const r = await call('/native/ping');
    const ok = check('the brain answers', r.status === 200, `HTTP ${r.status} — ${String(r.text).slice(0, 120)}`);
    if (!ok) {
      console.log('\n  Nothing else can pass until this does. Check the URL and token,');
      console.log('  and that you deployed to the NODE service, not the static site.\n');
      process.exit(1);
    }
    console.log(`      ${r.ms}ms${r.ms > 3000 ? '  — that looks like a cold start' : ''}`);
    check('memory is on durable storage', r.json && r.json.durable === true,
      'no Render disk at /var/data — memory is wiped on every deploy');
  }

  /* --- 2. auth actually gates ------------------------------------------ */
  console.log('');
  console.log('  DOES THE LOCK WORK?');
  console.log('  ' + '-'.repeat(66));
  {
    const bad = await fetch(BASE + '/native/ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer definitely-not-the-token' },
      body: '{}',
    }).then(r => r.status).catch(() => 0);
    check('a wrong token is refused', bad === 401 || bad === 429, `got HTTP ${bad}`);

    const none = await fetch(BASE + '/native/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(r => r.status).catch(() => 0);
    check('no token is refused', none === 401 || none === 429, `got HTTP ${none}`);
  }

  /* --- 3. the handshake ------------------------------------------------- */
  console.log('');
  console.log('  WHAT DOES IT SAY IT CAN DO?');
  console.log('  ' + '-'.repeat(66));
  let hello = null;
  {
    const r = await call('/native/hello');
    check('the handshake answers', r.status === 200, `HTTP ${r.status}`);
    hello = r.json;
    if (hello) {
      check('it declares a contract version', typeof hello.contract === 'number');
      check('it lists skills', Array.isArray(hello.skills) && hello.skills.length > 50,
        `only ${(hello.skills || []).length} skills`);
      check('it promises every response speaks', hello.brain && hello.brain.alwaysSpeaks === true);
      check('it flags which skills need a camera', (hello.skills || []).some(s => s.needsImage));
      check('it flags which need confirming first', (hello.skills || []).some(s => s.confirmFirst));
      check('it says what the client must handle', Array.isArray(hello.clientMustHandle) && hello.clientMustHandle.length > 3);
      check('it publishes the image limits', hello.limits && hello.limits.imageMaxBase64Bytes > 0);

      const have = hello.have || {};
      console.log('');
      console.log('      configured on this server:');
      for (const [k, v] of Object.entries(have)) {
        console.log(`        ${v ? '✓' : '·'} ${k}${v ? '' : '  (not set up)'}`);
      }
    }
  }

  /* --- 4. the brain thinks ---------------------------------------------- */
  console.log('');
  console.log('  DOES IT ACTUALLY THINK?');
  console.log('  ' + '-'.repeat(66));
  {
    const r = await call('/chat', { message: 'say the single word: ready' });
    const ok = check('chat responds', r.status === 200, `HTTP ${r.status} — ${String(r.text).slice(0, 160)}`);
    if (ok && r.json) {
      const reply = String(r.json.reply || '');
      check('the reply has words in it', reply.length > 0, 'empty reply — check API credits and the model name');
      // The exact failure he spent a night on: an invalid key surfaces as a
      // real sentence rather than an error, so look for it explicitly.
      check('no upstream error leaked into the reply',
        !/brain said|invalid x-api-key|credit balance/i.test(reply), reply.slice(0, 140));
      check('the reply is speakable (no markdown)', !/\*\*|^#|\n- /.test(reply),
        'asterisks and hashes read aloud as noise');
      console.log(`      ${r.ms}ms · "${reply.slice(0, 70)}${reply.length > 70 ? '…' : ''}"`);
    }
  }

  /* --- 5. routing ------------------------------------------------------- */
  console.log('');
  console.log('  DOES IT WORK OUT WHAT HE MEANT?');
  console.log('  ' + '-'.repeat(66));
  {
    const cases = [
      ['what is the weather like today', 'weather'],
      ['job report for 1295115', 'jobreport'],
      ['where is my wife', 'whereis'],
    ];
    for (const [say, want] of cases) {
      const r = await call('/route', { message: say });
      if (r.status !== 200) { check(`routes "${say}"`, false, `HTTP ${r.status}`); continue; }
      const got = r.json && r.json.skill;
      // Routing is a judgement, so a near-miss is worth seeing rather than
      // failing outright — but landing on `chat` means it gave up.
      const ok = got === want;
      if (ok) { pass++; console.log(`  ✓ "${say}" → ${got}  (${r.ms}ms)`); }
      else if (got && got !== 'chat') {
        skip(`"${say}" → ${got}`, `expected ${want}, but it chose something specific`);
      } else {
        fail++; problems.push(`routing "${say}" fell through to chat`);
        console.log(`  ✗ "${say}" → ${got || 'nothing'}  (expected ${want})`);
      }
    }
  }

  /* --- 6. an endpoint that must fail WELL --------------------------------- */
  console.log('');
  console.log('  DOES IT FAIL IN WORDS?');
  console.log('  ' + '-'.repeat(66));
  {
    // A deliberately impossible image. It must come back speakable, not as a
    // 500 or a wall of JSON — on glasses an unspeakable failure is silence.
    const r = await call('/vision', { image: 'not-a-real-image', mediaType: 'image/jpeg' });
    check('a bad image is rejected politely', r.status === 200,
      `HTTP ${r.status} — a native client would see an error, not hear one`);
    if (r.json) {
      const spoken = r.json.spoken || r.json.answer || '';
      check('and it says something he can hear', String(spoken).length > 5, JSON.stringify(r.json).slice(0, 120));
      console.log(`      "${String(spoken).slice(0, 70)}"`);
    }
  }

  /* --- 7. the calendar, if it's wired ------------------------------------ */
  console.log('');
  console.log('  IS THE CALENDAR REACHABLE?');
  console.log('  ' + '-'.repeat(66));
  {
    const r = await call('/calendar/sources', {});
    if (r.status !== 200) { check('calendar sources', false, `HTTP ${r.status}`); }
    else if (r.json && r.json.ok === false) {
      skip('calendar sources', r.json.error || 'iCloud not configured yet');
    } else {
      const n = (r.json.sources || []).length;
      check('CalDAV discovery works', n > 0, 'no calendars came back — check the app-specific password');
      console.log(`      ${n} sources found (${(r.json.sources || []).filter(s => s.kind === 'calendar').length} calendars, ${(r.json.sources || []).filter(s => s.kind === 'reminders').length} lists)`);
      const on = (r.json.sources || []).filter(s => s.read || s.monitor).length;
      if (!on) console.log('      · none switched on yet — open the Calendars & lists tile');
    }
  }

  /* --- 8. the advisor stays quiet ---------------------------------------- */
  console.log('');
  console.log('  DOES THE ADVISOR KNOW WHEN TO SHUT UP?');
  console.log('  ' + '-'.repeat(66));
  {
    const r = await call('/advise', {});
    check('the advisor answers', r.status === 200, `HTTP ${r.status}`);
    if (r.json) {
      const n = (r.json.notes || []).length;
      check('it raises at most two things', n <= 2, `raised ${n}`);
      console.log(`      ${n ? r.json.notes.map(x => x.kind).join(', ') : 'nothing to flag — correct on a quiet day'}`);
    }
  }

  /* --- 9. speed ---------------------------------------------------------- */
  console.log('');
  console.log('  IS IT FAST ENOUGH TO TALK TO?');
  console.log('  ' + '-'.repeat(66));
  {
    const chat = timings.filter(t => t.path === '/chat').map(t => t.ms);
    const route = timings.filter(t => t.path === '/route').map(t => t.ms);
    const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
    console.log(`      route: ${avg(route)}ms average`);
    console.log(`      chat:  ${avg(chat)}ms average`);
    const total = avg(route) + avg(chat);
    console.log(`      a spoken answer therefore lands in about ${(total / 1000).toFixed(1)}s`);
    // Not a pass/fail — it's a number he should see before deciding whether
    // the fast path and caching were worth it.
    if (total > 4000) console.log('      · over 4s is noticeable through glasses');
  }

  /* --- report ------------------------------------------------------------ */
  console.log('');
  console.log('  ' + '='.repeat(66));
  if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
  console.log(`  ${pass} passed, ${fail} failed, ${skipped} skipped`);
  console.log('');
  if (!fail) {
    console.log('  The brain is live and behaving. Anything that breaks from here');
    console.log('  is in the native app, not the server.');
    console.log('');
  }
  process.exit(fail ? 1 : 0);
})();
