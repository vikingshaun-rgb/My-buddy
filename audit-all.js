#!/usr/bin/env node
'use strict';
/* audit-all.js — "full audit" in one command.
 *
 * Eighteen suites accumulated over one long night, each written because it
 * caught something real. Running them one at a time is how one gets forgotten,
 * so this runs the lot and prints a single verdict.
 *
 *   node audit-all.js
 *
 * Optionally also hits the deployed brain over real HTTP, which is the only
 * check here that proves anything works rather than merely agreeing with
 * itself:
 *
 *   node audit-all.js --live https://my-buddy-xu2x.onrender.com <token>
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);
const liveIdx = args.indexOf('--live');
const LIVE = liveIdx > -1 ? { url: args[liveIdx + 1], token: args[liveIdx + 2] } : null;

/* Grouped the way the system is actually built, not alphabetically — so a
 * failure tells you WHERE, not just WHAT. */
const GROUPS = [
  {
    name: 'The brain',
    why: 'what it knows, how it decides, and whether it can be trusted to answer',
    suites: [
      ['audit-144.js',      'contracts: dead tiles, unguarded routes, theme collisions'],
      ['test-prompts.js',   'no endpoint invents a price he would act on'],
      ['sim-advisor.js',    'it notices what matters and stays quiet otherwise'],
      ['sim-attention.js',  'it knows when to speak, and when he is busy'],
    ],
  },
  {
    name: 'Memory and durability',
    why: 'everything it knows about him lives in one file',
    suites: [
      ['sim-storage.js',    'a crash mid-write cannot erase him'],
      ['sim-recovery.js',   'a new phone gets all of it back'],
      ['test-caldav.js',    'a tick lands on the right item of her list'],
    ],
  },
  {
    name: 'Doing things in the world',
    why: 'the parts that reach outside the server',
    suites: [
      ['sim-navigation.js', 'directions with a map and a voice'],
      ['sim-transport.js',  'a journey that holds together across legs'],
      ['sim-watchers.js',   'a finding that fires actually reaches him'],
      ['sim-flows.js',      '"not yet" does not quietly become "never"'],
    ],
  },
  {
    name: 'Travelling with Jess',
    why: 'where a bug affects someone who is not holding the phone',
    suites: [
      ['sim-rooms.js',      'a guessed code cannot expose where he is'],
      ['sim-couple.js',     'her position is never read as fresher than it is'],
      ['sim-couple-trip.js','what it learned on day one reaches day nine'],
    ],
  },
  {
    name: 'End to end',
    why: 'whole requests, not parts',
    suites: [
      ['sim-workflows.js',  '15 requests through every layer'],
      ['sim-nightout.js',   '10 long chains including a night out in Da Nang'],
      ['sim-sweep.js',      'a fix in one place quietly breaking another'],
      ['sim-wiring.js',     'a module built, tested, and connected to nothing'],
    ],
  },
  {
    name: 'The investigator',
    why: 'fault-finding that narrows without ever naming a cause',
    suites: [
      ['sim-investigator.js', '35 workflows, and 18 rules against guessing'],
    ],
  },
  {
    name: 'Ready for the Mac',
    why: 'the contract the native build depends on',
    suites: [
      ['sim-native.js',     'the brain makes no browser assumptions'],
      ['sim-contract.js',   'the Swift client and the brain stay in step'],
    ],
  },
];

/* --- run ----------------------------------------------------------------- */
const results = [];
let totalChecks = 0;

function run(file) {
  const t0 = Date.now();
  try {
    const out = execFileSync('node', [file], { encoding: 'utf8', timeout: 60000 });
    return { ok: true, out, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), ms: Date.now() - t0 };
  }
}

// Four suites report their totals differently — "210/210 checks passed",
// "67/67", "27 checks passed", and the audit which just says ALL CONTRACTS MET.
// A total that silently undercounts is worse than no total.
function countOf(out) {
  let m;
  if ((m = out.match(/(\d+)\/\d+\s+checks passed/))) return Number(m[1]);
  if ((m = out.match(/passing\s*:\s*(\d+)\/\d+/))) return Number(m[1]);
  if ((m = out.match(/(\d+)\s+checks passed/))) return Number(m[1]);
  if ((m = out.match(/(\d+)\s+passed/))) return Number(m[1]);
  // The contract audit counts assertions rather than printing a number.
  if (/ALL CONTRACTS MET/.test(out)) {
    const n = (out.match(/✓/g) || []).length;
    return n || 1;
  }
  return 0;
}

console.log('');
console.log('  ╭' + '─'.repeat(70) + '╮');
console.log('  │  VISION — FULL AUDIT' + ' '.repeat(50) + '│');
console.log('  ╰' + '─'.repeat(70) + '╯');

// Syntax first: if the source doesn't parse, everything below is noise.
console.log('');
console.log('  SYNTAX');
console.log('  ' + '─'.repeat(70));
for (const f of ['server.js', 'caldav.js', 'smoke-live.js']) {
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe' });
    console.log(`  ✓ ${f}`);
  } catch (e) {
    console.log(`  ✗ ${f} — does not parse`);
    console.log('\n  Nothing else is worth running until this is fixed.\n');
    process.exit(1);
  }
}

for (const g of GROUPS) {
  console.log('');
  console.log(`  ${g.name.toUpperCase()}`);
  console.log(`  ${g.why}`);
  console.log('  ' + '─'.repeat(70));
  for (const [file, what] of g.suites) {
    if (!fs.existsSync(file)) {
      console.log(`  · ${file.padEnd(22)} not present, skipped`);
      continue;
    }
    const r = run(file);
    const n = countOf(r.out);
    totalChecks += n;
    results.push({ file, ok: r.ok, n, out: r.out, group: g.name });
    const count = r.ok ? `${n}`.padStart(4) : ' fail';
    console.log(`  ${r.ok ? '✓' : '✗'} ${file.replace(/\.js$/, '').padEnd(20)} ${count}  ${what}`);
    if (!r.ok) {
      // Show only the failures — the full output of a failing suite is long
      // and the interesting part is always the ✗ lines.
      for (const l of r.out.split('\n').filter(x => /✗/.test(x)).slice(0, 6)) {
        console.log(`        ${l.trim()}`);
      }
    }
  }
}

/* --- optional: the only test that proves anything works ------------------ */
if (LIVE && LIVE.url && LIVE.token) {
  console.log('');
  console.log('  AGAINST THE LIVE BRAIN');
  console.log('  the only check here that proves it works rather than agrees with itself');
  console.log('  ' + '─'.repeat(70));
  try {
    const out = execFileSync('node', ['smoke-live.js', LIVE.url, LIVE.token],
      { encoding: 'utf8', timeout: 180000 });
    console.log(out.split('\n').filter(l => /[✓✗·]/.test(l)).map(l => '  ' + l.trim()).join('\n'));
    results.push({ file: 'smoke-live.js', ok: true, n: countOf(out), group: 'live' });
    totalChecks += countOf(out);
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    console.log(out.split('\n').filter(l => /[✓✗]/.test(l)).map(l => '  ' + l.trim()).join('\n'));
    results.push({ file: 'smoke-live.js', ok: false, n: 0, group: 'live' });
  }
} else {
  console.log('');
  console.log('  AGAINST THE LIVE BRAIN');
  console.log('  ' + '─'.repeat(70));
  console.log('  · not run. Everything above reads source code — none of it has');
  console.log('    made a single HTTP request. To actually prove it works:');
  console.log('');
  console.log('      node audit-all.js --live <brain-url> <token>');
}

/* --- verdict ------------------------------------------------------------- */
const failed = results.filter(r => !r.ok);
console.log('');
console.log('  ╭' + '─'.repeat(70) + '╮');
if (!failed.length) {
  console.log(`  │  ${String(results.length).padStart(2)} suites · ${String(totalChecks).padStart(4)} checks · all green`
    + ' '.repeat(70 - 38) + '│');
} else {
  console.log(`  │  ${failed.length} of ${results.length} suites failing`
    + ' '.repeat(70 - 26 - String(failed.length).length) + '│');
}
console.log('  ╰' + '─'.repeat(70) + '╯');

if (failed.length) {
  console.log('');
  console.log('  Failing:');
  for (const f of failed) console.log(`    ✗ ${f.file}  (${f.group})`);
  console.log('');
  console.log('  Re-run one on its own for the full output:  node ' + failed[0].file);
}
console.log('');
process.exit(failed.length ? 1 : 0);
