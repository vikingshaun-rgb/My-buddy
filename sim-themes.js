'use strict';
/* sim-themes.js — the look and the sound, checked together.
 *
 * The theme system has bitten twice already, both times invisibly:
 *
 *   Batch 120 — two independent systems both wrote data-theme, so picking a
 *               colour was wiped on every refresh and picking a background
 *               reverted the palette.
 *   Batch 145 — backgrounds moved to their own attribute and STILL never
 *               appeared, because a later body rule painted an opaque
 *               background over the artwork. The setting saved correctly the
 *               whole time; it simply could not be seen.
 *
 * Neither was findable by reading CSS for correctness — both were about paint
 * ORDER and which rule wins. So this checks the things that actually broke:
 * that nothing covers the artwork, that every world is complete across
 * palette, background, orb and sound, and that the audio cues keep their
 * meaning whichever world is on.
 *
 * Run: node sim-themes.js
 */

const fs = require('fs');
const app = fs.readFileSync('app.html', 'utf8');

let pass = 0, fail = 0;
const problems = [];
function check(name, ok, why) {
  if (ok) { pass++; return true; }
  fail++; problems.push(`${name}${why ? ' — ' + why : ''}`);
  return false;
}
function line(ok, text, extra) { console.log(`  ${ok ? '✓' : '✗'} ${text}${extra ? '  ' + extra : ''}`); }

const BGS  = [...new Set([...app.matchAll(/html\[data-bg="([a-z-]+)"\]/g)].map(m => m[1]))];
const ORBS = [...new Set([...app.matchAll(/\[data-orb="([a-z-]+)"\]/g)].map(m => m[1]))];
const PALETTES = [...new Set([...app.matchAll(/html\[data-theme="([a-z-]+)"\]/g)].map(m => m[1]))];
const WORLDS = (() => {
  const i = app.indexOf('const SOUND_WORLDS = {');
  const j = app.indexOf('\n  };', i);
  return [...new Set([...app.slice(i, j).matchAll(/^\s{4}([a-z]+):\s*\{/gm)].map(m => m[1]))];
})();

console.log('');
console.log('  THEMES — THE LOOK AND THE SOUND');
console.log('  ' + '='.repeat(68));
console.log(`  ${PALETTES.length} palettes · ${BGS.length} backgrounds · ${ORBS.length} orbs · ${WORLDS.length} sound worlds`);

/* --- 1. the bug that hid every background ------------------------------- */
console.log('');
console.log('  NOTHING MAY PAINT OVER THE ARTWORK');
console.log('  ' + '-'.repeat(68));
{
  // The artwork lives on html::before at z-index 0. If body has ANY opaque
  // background, it covers it — and that is exactly what happened.
  // Strip comments first. This check has now twice matched the very comment
  // explaining the fix it was verifying — prose is not code.
  const css = app.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodyRules = [...css.matchAll(/(?:^|[\s,}])body\s*\{[^}]*background[^}]*\}/gm)].map(m => m[0]);
  const opaque = bodyRules.filter(r => {
    const bg = (r.match(/background\s*:\s*([^;}]+)/) || [])[1] || '';
    return !/transparent/.test(bg);
  });
  let ok = check('body never paints an opaque background', opaque.length === 0,
    `${opaque.length} rule(s) would hide every background artwork`);
  line(ok, `${bodyRules.length} body background rules`, `${opaque.length} opaque`);

  // The ambient glow is worth keeping — it just has to sit on its own layer.
  ok = check('the ambient glow is on its own layer', /body::before\s*\{[^}]*z-index:0/.test(app),
    'either the glow was lost, or it is back on body covering the artwork');
  line(ok, 'glow moved to body::before at z-index 0');

  ok = check('the artwork sits below the content', /html\[data-bg\]::before\{[^}]*z-index:0/.test(app));
  line(ok, 'artwork at z-index 0');

  ok = check('content sits above it', /body>\*\{[^}]*z-index:1/.test(app),
    'the artwork would cover the app');
  line(ok, 'content at z-index 1');
}

/* --- 2. the collision that wiped the palette ---------------------------- */
console.log('');
console.log('  THE TWO SYSTEMS MUST STAY SEPARATE');
console.log('  ' + '-'.repeat(68));
{
  const clash = PALETTES.filter(t => BGS.includes(t));
  let ok = check('palettes and backgrounds use different attributes', clash.length === 0,
    `both claim: ${clash.join(', ')}`);
  line(ok, `${PALETTES.length} palettes on data-theme`, `${BGS.length} backgrounds on data-bg`);

  const looks = app.slice(app.indexOf('function applyLooks'), app.indexOf('function applyLooks') + 900);
  ok = check('applyLooks never touches data-theme', !/setAttribute\(['"]data-theme/.test(looks),
    'picking a background would wipe the colour theme again');
  line(ok, 'background setter stays off data-theme');

  const theme = app.slice(app.indexOf('function applyTheme'), app.indexOf('function applyTheme') + 900);
  ok = check('applyTheme never touches data-bg', !/setAttribute\(['"]data-bg/.test(theme),
    'picking a colour would wipe the background');
  line(ok, 'palette setter stays off data-bg');

  // The block sits in the first inline <script>, immediately after </head> —
  // which still runs before the browser paints anything. What matters is that
  // it runs before the app boots, not that it lives inside <head>.
  // Comments strip first — this check matched `applyLooks()` inside the very
  // comment describing why the early block exists. Fourth time tonight.
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const firstScript = code.indexOf('<script>');
  const bootAt = code.indexOf('applyLooks()');
  const earlyAt = code.indexOf("localStorage.getItem('buddy_bg')");
  ok = check('both are applied before first paint',
    earlyAt > firstScript && earlyAt < bootAt,
    'the theme would be applied late and every load would flash the default');
  line(ok, 'palette and background set in the first inline script');

  ok = check('the early block sets data-bg, not just the palette',
    /setAttribute\('data-bg'/.test(code.slice(firstScript, firstScript + 1200)),
    'the colour would be right on load but the artwork would flash in late');
  line(ok, 'both attributes set before boot');
}

/* --- 3. every world is complete ----------------------------------------- */
console.log('');
console.log('  EVERY WORLD IS COMPLETE');
console.log('  ' + '-'.repeat(68));
{
  // A background with no orb, or an orb with no sound, is a half-built world —
  // he picks it and something about it stays generic.
  const noOrb = BGS.filter(b => !ORBS.includes(b));
  let ok = check('every background has a matching orb', noOrb.length === 0, noOrb.join(', '));
  line(ok, `${BGS.length} backgrounds`, noOrb.length ? `missing orb: ${noOrb.join(', ')}` : 'all matched');

  const noSound = BGS.filter(b => !WORLDS.includes(b));
  ok = check('every background has a sound world', noSound.length === 0, noSound.join(', '));
  line(ok, `${WORLDS.length} sound worlds`, noSound.length ? `missing sound: ${noSound.join(', ')}` : 'all matched');

  ok = check('there is a default sound world', WORLDS.includes('aurora'),
    'an unknown theme would have no voice at all');
  line(ok, 'aurora is the fallback');
}

/* --- 4. the cues must keep their meaning -------------------------------- */
console.log('');
console.log('  THE CUES MEAN THE SAME THING IN EVERY WORLD');
console.log('  ' + '-'.repeat(68));
{
  // On glasses he can't see the button. A rising pair means the mic opened and
  // a falling pair means it closed — if that flipped by theme, the one cue
  // that makes eyes-free use possible would become a liability.
  const i = app.indexOf('const SOUND_WORLDS = {');
  const j = app.indexOf('\n  };', i);
  const block = app.slice(i, j);
  const roots = [...block.matchAll(/root:\s*(\d+)/g)].map(m => Number(m[1]));
  const steps = [...block.matchAll(/step:\s*(\d+)/g)].map(m => Number(m[1]));

  let ok = check('every world defines a root note', roots.length === WORLDS.length,
    `${roots.length} roots for ${WORLDS.length} worlds`);
  line(ok, `${roots.length} root notes`);

  // chimeListen rises (0.8 → 1.06) and chimeStop falls (1.06 → 0.73) as a
  // proportion of root, so the direction holds for every value of root.
  ok = check('listening always rises', /chimeListen\(\)\{[^}]*w\.root\*0\.8[^}]*w\.root\*1\.06/.test(app),
    'the mic-open cue could fall in some theme');
  line(ok, 'mic open → rising pair, every world');

  ok = check('stopped always falls', /chimeStop\(\)\{[^}]*w\.root\*1\.06[^}]*w\.root\*0\.73/.test(app),
    'the mic-closed cue could rise in some theme');
  line(ok, 'mic closed → falling pair, every world');

  ok = check('armed always rises', /chimeArm\(\)\{[^}]*w\.root,[^}]*w\.root\+w\.step/.test(app));
  line(ok, 'armed → rising pair, every world');

  // Volume: these fire while he's riding or mid-conversation.
  const gains = [...block.matchAll(/gain:\s*([\d.]+)/g)].map(m => Number(m[1]));
  const loud = gains.filter(g => g > 1.0);
  ok = check('no world is louder than the default', loud.length === 0,
    `${loud.length} world(s) above 1.0 — a cue that startles gets turned off`);
  line(ok, `gains ${Math.min(...gains)}–${Math.max(...gains)}`);
}

/* --- 5. the sound follows the look -------------------------------------- */
console.log('');
console.log('  THE SOUND FOLLOWS WHAT HE PICKED');
console.log('  ' + '-'.repeat(68));
{
  let ok = check('the sound world derives from the background', /localStorage\.buddy_bg/.test(
    app.slice(app.indexOf('function soundTheme'), app.indexOf('function soundTheme') + 400)),
    'he would pick Heaven and still hear the default');
  line(ok, 'follows buddy_bg');

  ok = check('an unknown theme falls back rather than going silent',
    /SOUND_WORLDS\[t\] \? t : 'aurora'/.test(app),
    'a theme with no sound entry would throw or go mute');
  line(ok, 'unknown → aurora');

  ok = check('"auto" resolves to a real world', /t === 'auto'/.test(app),
    'the auto background would have no voice');
  line(ok, 'auto handled');

  ok = check('he can override the sound independently', /buddy_soundworld/.test(app),
    'no way to keep a look he likes with a voice he prefers');
  line(ok, 'buddy_soundworld overrides');
}

/* --- 6. the heaven orb -------------------------------------------------- */
console.log('');
console.log('  THE HEAVEN ORB');
console.log('  ' + '-'.repeat(68));
{
  let ok = check('the orb has a wings element', /<i class="wings"/.test(app),
    'both pseudo-elements are already used by the halo and the rays');
  line(ok, 'wings are a real element, not a third pseudo');

  ok = check('wings only show for Heaven', /#orb \.wings\{display:none\}/.test(app),
    'every other orb would sprout wings');
  line(ok, 'hidden unless data-orb="heaven"');

  ok = check('the orb lets them overflow', /body\[data-orb="heaven"\] #orb\{overflow:visible\}/.test(app),
    'the wings would be clipped to the orb circle');
  line(ok, 'overflow visible so they can splay');

  ok = check('wings sit behind the orb', /\.wings\{[^}]*z-index:-1/.test(app),
    'they would paint over the light itself');
  line(ok, 'z-index -1');

  ok = check('the two sides are not in lockstep', /animation-delay:-3\.1s/.test(app),
    'a symmetric pulse reads as a graphic, not something alive');
  line(ok, 'one side half a beat behind');

  ok = check('reduced motion is respected', /prefers-reduced-motion[\s\S]{0,200}\.wings/.test(app),
    'a constant pulse for someone who asked for stillness');
  line(ok, 'animation off, wings still visible');
}

/* --- 7. the three winged worlds ----------------------------------------
 * Heaven, Diablo and Lilith all reuse the same .wings element, which is the
 * only sensible approach — but it means one careless selector gives every orb
 * wings, and a missing overflow clips them to a circle.
 */
console.log('');
console.log('  THE WINGED WORLDS');
console.log('  ' + '-'.repeat(68));
{
  for (const world of ['heaven', 'hell', 'lilith']) {
    const has = new RegExp(`body\\[data-orb="${world}"\\] #orb \\.wings`).test(app);
    const overflow = new RegExp(`body\\[data-orb="${world}"\\] #orb\\{overflow:visible\\}`).test(app);
    const ok = check(`${world} wings are complete`, has && overflow,
      !has ? 'no wings rule' : 'wings would be clipped to the orb circle');
    line(ok, world.padEnd(10), has && overflow ? 'wings + overflow visible' : 'incomplete');
  }

  // The three must not look like each other. Different geometry is the point:
  // Heaven splays back and down, Diablo sweeps up and out, Lilith frames.
  const angles = ['heaven', 'hell', 'lilith'].map(w => {
    // The rotate() lives in the standalone ::before rule, which comes after the
    // shared ::before,::after block — so search from the LAST occurrence.
    const i = app.lastIndexOf(`body[data-orb="${w}"] #orb .wings::before{`);
    const seg = app.slice(i, i + 200);
    return (seg.match(/rotate\((-?[\d.]+)deg\)/) || [])[1];
  });
  let ok = check('each winged world has its own geometry', new Set(angles).size === 3,
    `angles ${angles.join(', ')} — two worlds would look identical`);
  line(ok, `rotations: ${angles.join('° / ')}°`);

  // Every orb has a .wings element in the markup; only three should show it.
  ok = check('other orbs do not sprout wings', /#orb \.wings\{display:none\}/.test(app),
    'every orb would grow wings');
  line(ok, 'hidden by default, opted into by three');

  ok = check('the wings element exists in the markup', /<i class="wings"/.test(app),
    'the CSS would have nothing to style');
  line(ok, 'one element, three very different treatments');
}

/* --- 8. lightning ------------------------------------------------------
 * A flash every couple of seconds is a strobe, not weather — and it's the
 * kind of thing that looks great in a demo and gets switched off within a day.
 */
console.log('');
console.log('  LIGHTNING');
console.log('  ' + '-'.repeat(68));
{
  const STRIKES = [['hell', 'strikeHell'], ['lilith', 'strikeLilith'], ['jarvis', 'strikeJarvis']];
  for (const [world, kf] of STRIKES) {
    const has = new RegExp(`html\\[data-bg="${world}"\\]::after`).test(app);
    const ok = check(`${world} has a strike layer`, has);
    line(ok, world.padEnd(10), has ? 'html::after' : 'missing');
  }

  // The duty cycle is the whole thing. Anything above ~8% lit reads as a strobe.
  for (const [world, kf] of STRIKES) {
    const i = app.indexOf(`@keyframes ${kf}{`);
    if (i === -1) { check(`${kf} exists`, false); continue; }
    const block = app.slice(i, app.indexOf('}}', i) + 2);
    // `0%,100%{opacity:0}` is the wrap-around DARK stop, not a lit one — the
    // lit window is the last stop that still has opacity above zero.
    const stops = [...block.matchAll(/([\d.]+)%\{opacity:([\d.]+)\}/g)]
      .map(m => ({ at: Number(m[1]), o: Number(m[2]) }))
      .filter(s => s.o > 0 && s.at < 100);
    const lit = stops.length ? Math.max(...stops.map(s => s.at)) : 100;
    const cycleM = app.match(new RegExp(`animation:${kf} ([\\d.]+)s`));
    const cycle = cycleM ? Number(cycleM[1]) : 0;
    const ok = check(`${world} strikes briefly, not constantly`, lit <= 8 && cycle >= 6,
      lit > 8 ? `lit for ${lit}% of the cycle — that is a strobe`
              : `a ${cycle}s cycle is too frequent — long gaps are what make it read as weather`);
    line(ok, `${world} duty cycle`.padEnd(22), `${lit}% of ${cycle}s`);
  }

  let ok = check('a strike double-taps like real lightning',
    /1\.2%\{opacity:\.9\} 1\.9%\{opacity:\.1\}/.test(app),
    'a single fade reads as a light being switched on');
  line(ok, 'bright, gone, fainter echo, dark');

  ok = check('the strike sits below the content', /html\[data-bg="hell"\]::after,[\s\S]{0,300}z-index:0/.test(app),
    'it would flash over the text');
  line(ok, 'z-index 0, above the artwork');

  ok = check('reduced motion turns strikes off entirely',
    /prefers-reduced-motion[\s\S]{0,300}data-bg="hell"\]::after/.test(app),
    'a flashing screen for someone who asked for stillness');
  line(ok, 'no flashing under reduced motion');

  // Counting rules over-counts: the shared positioning rule groups all three,
  // then each has its own. Count distinct WORLDS instead.
  const strikeWorlds = new Set([...app.matchAll(/html\[data-bg="([a-z]+)"\]::after/g)].map(m => m[1]));
  ok = check('only worlds where it means something get it', strikeWorlds.size <= 4,
    `${[...strikeWorlds].join(', ')} — lightning everywhere is decoration`);
  line(ok, `${strikeWorlds.size} worlds, not 17`);
}

/* --- 9. motion and battery ---------------------------------------------
 * 39 animations run continuously. On a phone in his pocket that is real
 * battery, and on glasses it is real distraction.
 */
console.log('');
console.log('  MOTION');
console.log('  ' + '-'.repeat(68));
{
  const inf = [...app.matchAll(/animation:\s*([\w-]+)\s+([\d.]+)s[^;}]*infinite/g)]
    .map(m => ({ n: m[1], s: Number(m[2]) }));
  const byName = {};
  for (const x of inf) byName[x.n] = x.s;
  const names = Object.keys(byName);

  let ok = check('nothing loops faster than one second', names.every(n => byName[n] >= 1),
    names.filter(n => byName[n] < 1).join(', '));
  line(ok, `${names.length} looping animations`, `fastest ${Math.min(...Object.values(byName))}s`);

  // The orb is on screen constantly; a fast spin there is what drains a battery.
  ok = check('the orb does not spin fast', (byName.orbSpin || 99) >= 2,
    `orbSpin at ${byName.orbSpin}s`);
  line(ok, `orbSpin ${byName.orbSpin}s`);

  ok = check('reduced motion is honoured somewhere', /prefers-reduced-motion/.test(app));
  const rm = (app.match(/prefers-reduced-motion/g) || []).length;
  line(ok, `${rm} reduced-motion blocks`);

  // Every wing and strike must be covered, since those are the largest movers.
  for (const sel of ['\\.wings', 'data-bg="hell"\\]::after']) {
    const covered = new RegExp(`prefers-reduced-motion[\\s\\S]{0,400}${sel}`).test(app);
    const okk = check(`reduced motion covers ${sel.replace(/\\\\/g, '')}`, covered);
    line(okk, `covered: ${sel.replace(/\\\\/g, '').slice(0, 28)}`);
  }
}

/* --- 10. the GUI holds together ----------------------------------------
 * The theme system can be perfect and the app still unusable if a palette
 * leaves text unreadable or a tile has no handler.
 */
console.log('');
console.log('  THE GUI ITSELF');
console.log('  ' + '-'.repeat(68));
{
  const tiles = [...new Set([...app.matchAll(/class="tile"[^>]*onclick="(\w+)\(/g)].map(m => m[1]))];
  const dead = tiles.filter(fn =>
    !new RegExp(`(async\\s+)?function\\s+${fn}\\s*\\(|(const|let|var)\\s+${fn}\\s*=`).test(app));
  let ok = check('every tile has a live handler', dead.length === 0, dead.join(', '));
  line(ok, `${tiles.length} tile handlers`);

  const totalTiles = (app.match(/class="tile"/g) || []).length;
  const withClick = (app.match(/class="tile"[^>]*onclick=/g) || []).length;
  ok = check('every tile is tappable', totalTiles === withClick,
    `${totalTiles - withClick} tile(s) do nothing when tapped`);
  line(ok, `${totalTiles} tiles`, `${withClick} with handlers`);

  // Every palette must define the variables the whole UI reads, or text
  // silently falls back and can end up on a background it cannot be read on.
  const palettes = [...new Set([...app.matchAll(/html\[data-theme="([a-z-]+)"\]/g)].map(m => m[1]))];
  const incomplete = palettes.filter(p =>
    !new RegExp(`html\\[data-theme="${p}"\\]\\{[^}]*--midnight`).test(app) ||
    !new RegExp(`html\\[data-theme="${p}"\\]\\{[^}]*--paper`).test(app));
  ok = check('every palette defines its core variables', incomplete.length === 0, incomplete.join(', '));
  line(ok, `${palettes.length} palettes`, 'each sets --midnight and --paper');

  // The artwork sits at 30% opacity precisely so text stays readable over it.
  ok = check('background artwork is held back behind the content',
    /html\[data-bg\]::before\{[^}]*opacity:\.3/.test(app),
    'a full-strength artwork would make text unreadable');
  line(ok, 'artwork at 30% opacity');

  ok = check('the app still has a visible masthead', /class="ribbon"/.test(app));
  line(ok, 'ribbon present');
}

/* --- report -------------------------------------------------------------- */
console.log('');
console.log('  ' + '='.repeat(68));
if (problems.length) { console.log(''); for (const p of problems) console.log('  ✗ ' + p); console.log(''); }
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');
process.exit(fail ? 1 : 0);
