/**
 * Every setting a user can change, with its bounds and its explanation in one place.
 *
 * The panel renders from this schema, so adding an entry here is all it takes for it to appear
 * in Discord with correct validation and help text. That is deliberate: in the other bot the
 * help text and the bounds drifted apart more than once, and a setting whose description
 * contradicts its behaviour is worse than one with no description.
 *
 * Bounds are enforced HERE, not in the panel. The panel is one caller; a bad value reaching the
 * order path is a money bug, so the guard belongs at the store.
 */

const TYPE = { MONEY: 'money', CENTS: 'cents', INT: 'int', BOOL: 'bool', SECONDS: 'seconds' };

const SCHEMA = {
  // ── the four Bento asked for ──
  shares: {
    group: 'sizing', label: 'Shares per trade', type: TYPE.INT, def: 30, min: 1, max: 5000,
    help: 'How many contracts to buy on every entry.\n\n' +
      'A count, not an amount, because a count is what you actually receive: 30 shares pays ' +
      '$30 if the call is right. What varies is the cost — 30 at 71c is $21.30, 30 at 45c is ' +
      '$13.50.\n\n' +
      'Fixed size is also the one thing that cannot be talked into over-betting. Formula ' +
      'sizing multiplies a confidence error; this does not.'
  },
  cashoutAt: {
    group: 'exits', label: 'Cash out at', type: TYPE.CENTS, def: null, nullable: true,
    min: 0.50, max: 0.99,
    help: 'Sell once the position can be sold at this price. Blank = **hold to settlement**.\n\n' +
      'Holding is usually better and it is worth knowing why: settlement is FEE-FREE, a cashout ' +
      'pays a second fee. So selling at 97c gives up 3c *and* pays for the privilege. On the ' +
      'other bot, measured over 589 positions, holding made +368u against +246u for a 91c ' +
      'target.\n\n' +
      'The case FOR a target is variance, not profit: it books wins before a round can turn.'
  },
  dailyStopLoss: {
    group: 'risk', label: 'Daily stop loss', type: TYPE.MONEY, def: null, nullable: true,
    min: 1, max: 100000,
    help: 'Stop opening new positions once today has lost this much. Blank = no limit.\n\n' +
      'Counted on REALISED loss in the exchange\'s day (ET), so a position still open does not ' +
      'trip it and a loss carried from yesterday does not either.\n\n' +
      'It never sells anything. Anything already open stays managed — abandoning a live ' +
      'position is a worse thing than declining another one.'
  },
  fillGrace: {
    group: 'execution', label: 'Fill grace', type: TYPE.SECONDS, def: 3, min: 1, max: 30,
    help: 'How long to wait for an order to fill before reading what actually happened.\n\n' +
      'Too short and a fill that is on its way reads as a miss, which is how a position gets ' +
      'opened twice. Too long and the clock eats the entry window. 3 seconds suits an ' +
      'immediate-or-cancel order on a liquid 15-minute market.'
  },

  // ── real money, and the two switches that gate it ──
  live: {
    group: 'money', label: 'Live mode', type: TYPE.BOOL, def: false,
    help: 'Off = paper: every decision is recorded and priced, no order is sent.\n\n' +
      'On is not enough by itself — you must also **arm**. Two switches because they answer ' +
      'different questions: this one is "I intend to trade real money", arming is "I am ' +
      'watching right now".'
  },
  armed: {
    group: 'money', label: 'Armed', type: TYPE.BOOL, def: false,
    help: 'The live trigger. **Always off after a restart**, whatever it was before.\n\n' +
      'That is the point: a crash loop, a redeploy or an unattended reboot all come back in ' +
      'paper, so real money can only be trading because somebody armed it since the process ' +
      'started.'
  },
  maxOrderCost: {
    group: 'risk', label: 'Max cost per order', type: TYPE.MONEY, def: null, nullable: true,
    min: 0.05, max: 100000,
    help: 'Refuse any single order costing more than this. Blank = no cap.\n\n' +
      'A backstop on the size arithmetic rather than a strategy choice: it is the thing that ' +
      'holds when a price or a share count is wrong.'
  },
  slippageCents: {
    group: 'execution', label: 'Slippage allowance', type: TYPE.INT, def: 2, min: 0, max: 15,
    help: 'How many cents above the quote the limit price may go, so a moving book still fills.\n\n' +
      'Every cent chased comes off the edge. 0 means the limit sits exactly at the quote and a ' +
      'ticking market simply misses.'
  }
};

const GROUPS = {
  money: 'Real money',
  sizing: 'Size',
  exits: 'Exits',
  risk: 'Risk limits',
  execution: 'Execution'
};

/** Schema keys in a group, in declaration order. */
function keysIn(group) {
  return Object.keys(SCHEMA).filter(k => SCHEMA[k].group === group);
}

/**
 * Validate and normalise one value for one key.
 *
 * Returns the value to STORE, which is not always the value typed: cents are entered as 97 and
 * stored as 0.97, and a blank clears a nullable setting rather than storing zero. Storing 0
 * where null was meant is how "off" becomes "refuse everything".
 */
function coerce(key, raw) {
  const spec = SCHEMA[key];
  if (!spec) return { ok: false, why: `no such setting: ${key}` };

  const s = String(raw == null ? '' : raw).trim();

  if (spec.nullable && (s === '' || /^(off|none|blank|null|hold)$/i.test(s))) {
    return { ok: true, value: null };
  }
  if (spec.type === TYPE.BOOL) {
    if (/^(1|true|on|yes|y)$/i.test(s)) return { ok: true, value: true };
    if (/^(0|false|off|no|n)$/i.test(s)) return { ok: true, value: false };
    return { ok: false, why: 'expected on or off' };
  }

  const n = Number(s.replace(/[$,%\s]/g, ''));
  if (!Number.isFinite(n)) return { ok: false, why: `"${s}" is not a number` };

  // Cents are typed the way they are read — 97 means 97c — and stored as a fraction, because
  // that is what the price arithmetic uses. Accepting 0.97 too, since somebody will type it.
  let v = n;
  if (spec.type === TYPE.CENTS) v = n > 1 ? n / 100 : n;
  if (spec.type === TYPE.INT || spec.type === TYPE.SECONDS) {
    if (!Number.isInteger(n)) return { ok: false, why: 'must be a whole number' };
  }
  if (spec.min != null && v < spec.min) {
    return { ok: false, why: `must be at least ${fmtBound(spec, spec.min)}` };
  }
  if (spec.max != null && v > spec.max) {
    return { ok: false, why: `must be at most ${fmtBound(spec, spec.max)}` };
  }
  return { ok: true, value: spec.type === TYPE.CENTS ? +v.toFixed(4) : v };
}

function fmtBound(spec, v) {
  if (spec.type === TYPE.CENTS) return `${Math.round(v * 100)}c`;
  if (spec.type === TYPE.MONEY) return `$${v}`;
  if (spec.type === TYPE.SECONDS) return `${v}s`;
  return String(v);
}

/** How a stored value is shown. Null reads as what null MEANS, never as "null". */
function format(key, value) {
  const spec = SCHEMA[key];
  if (!spec) return String(value);
  if (value == null) return key === 'cashoutAt' ? 'hold to settlement' : 'off';
  switch (spec.type) {
    case TYPE.CENTS: return `${Math.round(Number(value) * 100)}c`;
    case TYPE.MONEY: return `$${Number(value).toFixed(2)}`;
    case TYPE.SECONDS: return `${Number(value)}s`;
    case TYPE.BOOL: return value ? 'on' : 'off';
    default: return String(value);
  }
}

/** Defaults for a fresh user. */
function defaults() {
  const out = {};
  for (const [k, spec] of Object.entries(SCHEMA)) out[k] = spec.def;
  return out;
}

module.exports = { TYPE, SCHEMA, GROUPS, keysIn, coerce, format, defaults };
