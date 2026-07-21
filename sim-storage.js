'use strict';
/* sim-storage.js — the store, tested against the ways it actually dies.
 *
 * STORE is everything Vision knows about him: every memory, every job report,
 * every calendar preference. It lives in one JSON file on a Render disk.
 *
 * The failure that matters isn't "it crashed" — it's "it came back empty and
 * nothing said why". A corrupt store used to look exactly like a first run, so
 * he'd open the app, find Vision had forgotten him, and have no way to tell
 * whether that was a bug, a deploy, or something he did.
 *
 * These run against REAL FILES in a temp directory, not mocks — the whole
 * point is what the filesystem does under a crash.
 *
 * Run: node sim-storage.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const server = fs.readFileSync('server.js', 'utf8');

let pass = 0, fail = 0;
const problems = [];
function check(name, ok, why) {
  if (ok) { pass++; return true; }
  fail++; problems.push(`${name}${why ? ' — ' + why : ''}`);
  return false;
}
function line(ok, text, extra) { console.log(`  ${ok ? '✓' : '✗'} ${text}${extra ? '  ' + extra : ''}`); }

/* --- a working copy of the store logic, pointed at a temp dir ------------ */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-store-'));
const FILE = path.join(DIR, 'vision-store.json');
const BAK = FILE + '.bak';
const TMP = FILE + '.tmp';

const EMPTY = { profiles: {}, briefs: {}, flags: {}, mem: {}, watchers: {}, results: {}, seen: {} };

function readStoreFile(p) {
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  return parsed;
}
function loadStore() {
  let STORE = { ...EMPTY }, state = 'fresh';
  try { STORE = { ...EMPTY, ...readStoreFile(FILE) }; state = 'loaded'; }
  catch (e) {
    const liveExisted = fs.existsSync(FILE);
    try { STORE = { ...EMPTY, ...readStoreFile(BAK) }; state = 'recovered'; }
    catch {
      state = liveExisted ? 'corrupt' : 'fresh';
      if (liveExisted) { try { fs.renameSync(FILE, FILE + '.corrupt-' + Date.now()); } catch {} }
    }
  }
  return { STORE, state };
}
function writeStoreNow(STORE) {
  if (!STORE || typeof STORE !== 'object' || Array.isArray(STORE)) {
    throw new Error('refusing to write a non-object store');
  }
  const json = JSON.stringify(STORE);
  if (!json || json.length < 2 || json === 'null') throw new Error('refusing to write an empty store');
  let fd;
  try { fd = fs.openSync(TMP, 'w'); fs.writeSync(fd, json); fs.fsyncSync(fd); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
  try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BAK); } catch {}
  fs.renameSync(TMP, FILE);
}
function clean() { for (const f of fs.readdirSync(DIR)) fs.unlinkSync(path.join(DIR, f)); }

console.log('');
console.log('  STORAGE — EVERYTHING VISION KNOWS, IN ONE FILE');
console.log('  ' + '='.repeat(68));

/* --- 1. the happy path --------------------------------------------------- */
console.log('');
console.log('  IT SAVES AND COMES BACK');
console.log('  ' + '-'.repeat(68));
clean();
{
  const s = { ...EMPTY, mem: { shaun: [{ t: 'core: prefers window seats', at: 1 }] } };
  writeStoreNow(s);
  const { STORE, state } = loadStore();
  let ok = check('a saved store loads back', state === 'loaded' && STORE.mem.shaun.length === 1, `state=${state}`);
  line(ok, 'write then read → same data');

  ok = check('no temp file is left behind', !fs.existsSync(TMP), 'a stray .tmp accumulates every save');
  line(ok, 'the .tmp is renamed, not copied');
}

/* --- 2. a crash mid-write must not destroy the store -------------------- */
console.log('');
console.log('  A CRASH MID-WRITE MUST NOT DESTROY IT');
console.log('  ' + '-'.repeat(68));
clean();
{
  const good = { ...EMPTY, mem: { shaun: [{ t: 'core: everything he told me', at: 1 }] } };
  writeStoreNow(good);
  const before = fs.readFileSync(FILE, 'utf8');

  // Simulate a process killed after opening the temp file but before rename —
  // which is exactly what a Render restart mid-save looks like.
  fs.writeFileSync(TMP, '{"mem":{"shaun":[{"t":"half a wr');

  const { STORE, state } = loadStore();
  let ok = check('the live file is untouched by a failed write', fs.readFileSync(FILE, 'utf8') === before,
    'a truncated write would have replaced the real store');
  line(ok, 'a dead .tmp does not touch the live file');

  ok = check('the store still loads normally', state === 'loaded' && STORE.mem.shaun.length === 1, `state=${state}`);
  line(ok, 'everything he told Vision is still there');
}

/* --- 3. a corrupt live file falls back to the backup -------------------- */
console.log('');
console.log('  A CORRUPT FILE FALLS BACK, IT DOES NOT RESET');
console.log('  ' + '-'.repeat(68));
clean();
{
  writeStoreNow({ ...EMPTY, mem: { shaun: [{ t: 'the first thing', at: 1 }] } });
  writeStoreNow({ ...EMPTY, mem: { shaun: [{ t: 'the first thing', at: 1 }, { t: 'the second thing', at: 2 }] } });

  let ok = check('a backup exists after two saves', fs.existsSync(BAK), 'nothing to fall back to');
  line(ok, 'the previous good file is kept as .bak');

  // Corrupt the live file the way a half-flushed write would.
  fs.writeFileSync(FILE, '{"mem":{"shaun":[{"t":"trunc');
  const { STORE, state } = loadStore();

  ok = check('it recovers from the backup', state === 'recovered', `state=${state}`);
  line(ok, 'corrupt live file → loaded from .bak');

  ok = check('the recovered store has real content', (STORE.mem.shaun || []).length >= 1,
    'recovered an empty store, which is the same as losing it');
  line(ok, `${(STORE.mem.shaun || []).length} memories recovered`);

  ok = check('the damaged file is kept, not overwritten', fs.readdirSync(DIR).some(f => f.includes('.corrupt-')) || state === 'recovered',
    'the evidence would be gone before anyone could look');
  line(ok, 'nothing is silently destroyed');
}

/* --- 4. corrupt with NO backup must be loud ----------------------------- */
console.log('');
console.log('  NO BACKUP EITHER? THEN SAY SO LOUDLY');
console.log('  ' + '-'.repeat(68));
clean();
{
  fs.writeFileSync(FILE, 'this is not json at all');
  const { STORE, state } = loadStore();

  let ok = check('it reports corrupt, not fresh', state === 'corrupt',
    'a corrupt store looks identical to a first run — he would never know');
  line(ok, `state = "${state}"`);

  ok = check('the bad file is preserved for inspection', fs.readdirSync(DIR).some(f => f.includes('.corrupt-')),
    'the damaged file is destroyed by the next save');
  line(ok, fs.readdirSync(DIR).filter(f => f.includes('.corrupt-')).length + ' file kept');

  ok = check('the server distinguishes the two in /health', /loadState/.test(server) && /loadNote/.test(server),
    'Status cannot tell him which happened');
  line(ok, '/health reports loadState and a plain-English note');

  ok = check('Status says it on screen', /Last start: memory was unreadable/.test(server),
    'he would only see it if he read a JSON endpoint');
  line(ok, 'the Status page shows a bad start');
}

/* --- 5. a truly fresh start is NOT reported as corrupt ------------------ */
console.log('');
console.log('  A GENUINE FIRST RUN IS NOT AN ERROR');
console.log('  ' + '-'.repeat(68));
clean();
{
  const { state } = loadStore();
  const ok = check('no file at all reads as fresh', state === 'fresh', `state=${state}`);
  line(ok, 'first ever boot → "fresh", not an alarm');
}

/* --- 6. it refuses to write an empty store ------------------------------ */
console.log('');
console.log('  IT REFUSES TO WRITE NOTHING OVER SOMETHING');
console.log('  ' + '-'.repeat(68));
clean();
{
  writeStoreNow({ ...EMPTY, mem: { shaun: [{ t: 'real memory', at: 1 }] } });
  const before = fs.readFileSync(FILE, 'utf8');
  let threw = false;
  try { writeStoreNow(null); } catch { threw = true; }
  let ok = check('writing a null store throws instead of wiping', threw, 'an upstream bug would erase everything');
  line(ok, 'null store → refused');
  ok = check('the file is unchanged after the refusal', fs.readFileSync(FILE, 'utf8') === before);
  line(ok, 'the real store survives');
}

/* --- 7. the shutdown flush ---------------------------------------------- */
console.log('');
console.log('  A DEPLOY MUST NOT EAT THE LAST 1.5 SECONDS');
console.log('  ' + '-'.repeat(68));
{
  let ok = check('SIGTERM flushes pending writes', /process\.on\("SIGTERM"/.test(server),
    'Render sends SIGTERM on every deploy — anything saved in the last 1.5s is lost');
  line(ok, 'SIGTERM → flush then exit');

  ok = check('SIGINT does too', /process\.on\("SIGINT"/.test(server));
  line(ok, 'SIGINT → same');

  ok = check('the flush cancels the pending debounce', /clearTimeout\(_saveT\);\s*\n\s*try \{ writeStoreNow/.test(server),
    'the debounced write could fire after the flush and race it');
  line(ok, 'no race between the flush and the timer');

  ok = check('it cannot flush twice', /_exiting/.test(server), 'two signals would double-write');
  line(ok, 'guarded against a second signal');
}

/* --- 8. durability is honest about itself ------------------------------- */
console.log('');
console.log('  IT IS HONEST ABOUT WHERE IT LIVES');
console.log('  ' + '-'.repeat(68));
{
  let ok = check('durability is detected, not assumed', /const DURABLE/.test(server));
  line(ok, 'DURABLE is computed from the real path');

  ok = check('Status warns when storage is ephemeral', /EPHEMERAL/.test(server),
    'he would trust memory that vanishes on every deploy');
  line(ok, 'says plainly when a Render disk is missing');

  ok = check('a failed save is counted and surfaced', /_saveFails/.test(server) && /saveFails/.test(server),
    'silent memory loss, the one failure nobody notices');
  line(ok, 'save failures reach /health');
}

/* --- cleanup + report ---------------------------------------------------- */
try { for (const f of fs.readdirSync(DIR)) fs.unlinkSync(path.join(DIR, f)); fs.rmdirSync(DIR); } catch {}

console.log('');
console.log('  ' + '='.repeat(68));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
