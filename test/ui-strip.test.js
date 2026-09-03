/**
 * The live strip: that it exists, that it is driven by a clock rather than a fetch, and that the DOM write
 * guard is actually wired to every renderer.
 *
 * ── the two things worth pinning ──
 *
 * The strip's whole job is to show that the loop is TURNING. That property lives in the 100ms painter and
 * in `windowNow` deriving the settlement window from the wall clock rather than from a server field — if a
 * later edit makes the playhead depend on a poll, it will freeze during exactly the outage a person opened
 * the page to diagnose, and it will look fine in every screenshot.
 *
 * The choppiness fix is a guard that only writes to the DOM when the HTML changed. It is easy to reintroduce
 * a raw `.innerHTML =` in one renderer and never notice, because the page still works — it just twitches
 * again. So the assertion is that no body renderer writes innerHTML directly.
 *
 * Run: node test/ui-strip.test.js
 */
const assert = require('assert');
const page = require('../src/sitepage');
const html = page();
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// ── the strip is in the markup ──
for (const id of ['scan', 'win', 'wingate', 'winhead', 'watch', 'scant', 'scanend', 'winopen', 'winclose']) {
  ok(new RegExp('id=' + id + '\\b').test(html), 'the strip needs #' + id);
}
ok(/id=hero\b/.test(html) && /id=heromin\b/.test(html),
  'the money row is split into headline and quiet halves');

// ── it is painted on a clock, not on a fetch ──
ok(/setInterval\(\(\) => paintStrip\(Date\.now\(\)\), 100\)/.test(html),
  'the playhead is painted every 100ms');
ok(/setInterval\(pollState, 1500\)/.test(html), 'the heartbeat is fetched every 1.5s');
ok(/setInterval\(pollTab, 5000\)/.test(html), 'the heavy tab payloads keep their slower cadence');
ok(/function windowNow\(/.test(html) && /Math\.ceil\(at \/ WIN_MS\)/.test(html),
  'the settlement window is derived from the wall clock, so the playhead keeps moving through an outage');
ok(/paintStrip\(Date\.now\(\)\);\s*$/m.test(html) || html.indexOf('paintStrip(Date.now());') > 0,
  'the strip is painted once immediately so it is never briefly blank on load');

// ── the heartbeat beats on real work ──
ok(/sc\.passes > \(prev\.scanner \? prev\.scanner\.passes : 0\)/.test(html),
  'the dot pulses off the pass COUNTER, not a timer — a timed blink looks alive after the loop stops');

// ── the write guard is wired everywhere ──
ok(/function writeIf\(id, html\)/.test(html), 'the DOM write guard exists');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const raw = script.match(/\$\('(decbody|trabody|coinbody|hrsbody|setbody|accbody|gatbody|watch)'\)\.innerHTML\s*=/g);
ok(!raw, 'no body renderer writes innerHTML directly — that is what made the page twitch every poll: ' +
  JSON.stringify(raw));

// ── the bar must agree with the number beside it ──
ok(/const fill = Math\.min\(100, Math\.max\(1\.5, r\.pricePct\)\)/.test(script),
  'the price bar is scaled over the whole 0-100c line; scaling it to the band made 73c look nearly in-band');

// ── quality floor ──
ok(/prefers-reduced-motion/.test(html), 'motion is opt-out');
ok(/focus-visible/.test(html), 'keyboard focus is visible');
ok(/min-height:220px/.test(html),
  'tab bodies reserve height, so a table that shrinks between polls does not jump the page');

// The page must still parse. A template literal that renders is not the same as a script that runs.
const vm = require('vm');
new vm.Script(script);
checks++;

console.log(`PASS ui-strip — ${checks} checks`);
