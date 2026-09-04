/**
 * A named gate that cannot fill must never be accepted silently.
 *
 * The bot once ran for hours taking zero trades because STRATEGY named `favourite` while
 * FAV_FORWARD_READY was false: accountBlock refused every entry, and nothing in the logs, the
 * dashboard or the Discord panel said the active gate was incapable of filling. Changing the DEFAULT
 * away from favourite did not fix it, because an environment variable outranks a default.
 *
 * Run: node test/strategy-resolution.test.js
 */
const assert = require('assert');
const path = require('path');

let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const ok = (v, m) => { checks++; assert.ok(v, m); };

const CONFIG = path.join(__dirname, '..', 'src', 'config.js');
const FAVOURITE = path.join(__dirname, '..', 'src', 'favourite.js');
const CALIBRATION = path.join(__dirname, '..', 'src', 'calibration.js');

/** Resolve STRATEGY in a clean module registry, capturing anything written to stderr. */
function resolve(value) {
  for (const m of [CONFIG, FAVOURITE, CALIBRATION]) delete require.cache[require.resolve(m)];
  if (value === undefined) delete process.env.STRATEGY; else process.env.STRATEGY = value;
  const realWrite = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = chunk => { warned += String(chunk); return true; };
  try { return { strategy: require(CONFIG).STRATEGY, warned }; }
  finally { process.stderr.write = realWrite; }
}

const fav = require(FAVOURITE);
const cal = require(CALIBRATION);

// The premise: favourite really is suspended and calibration really is paper-enabled.
eq(fav.FAV_FORWARD_READY, false, 'favourite is suspended, which is what makes this guard necessary');
eq(cal.CAL_FORWARD_READY, true, 'calibration can fill on paper, so it is a valid fallback');

// An unset variable takes the paper-capable default.
eq(resolve(undefined).strategy, 'calibration', 'the default is a gate that can actually fill');

// A gate that can fill is honoured exactly, with no warning.
{
  const r = resolve('calibration');
  eq(r.strategy, 'calibration');
  eq(r.warned, '', 'a healthy gate must not print a warning');
}
{
  const r = resolve('model');
  eq(r.strategy, 'model', 'model has no readiness flag and is never rewritten');
  eq(r.warned, '', 'model must not warn');
}

// The whole point: a SUSPENDED gate is refused, replaced, and announced.
{
  const r = resolve('favourite');
  eq(r.strategy, 'calibration', 'a suspended gate falls back to one that can fill');
  ok(/SUSPENDED/.test(r.warned), 'the fallback is announced, not silent');
  ok(/zero trades/.test(r.warned), 'the warning states the consequence it prevented');
  ok(/favourite/.test(r.warned) && /calibration/.test(r.warned),
    'the warning names both the refused gate and the replacement');
}

// Case and whitespace must not smuggle a suspended gate past the check.
{
  const r = resolve('FAVOURITE');
  eq(r.strategy, 'calibration', 'the check is case-insensitive');
  ok(/SUSPENDED/.test(r.warned));
}

// An unknown value has no readiness flag, so it passes through untouched rather than being rewritten
// into something the operator never asked for.
{
  const r = resolve('nonsense');
  eq(r.strategy, 'nonsense', 'an unrecognised value is not silently replaced');
  eq(r.warned, '');
}

delete process.env.STRATEGY;
console.log(`PASS strategy resolution — ${checks} checks`);
