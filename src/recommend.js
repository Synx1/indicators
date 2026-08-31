/**
 * What each setting SHOULD be for a given bankroll, and the arithmetic behind it.
 *
 * ── why this is separate from advice.js ──
 *
 * advice.js answers "is anything wrong right now" — it stays silent when the account is healthy, and
 * that silence is the point. This answers a different question: "what should I set these to before I
 * start." Every row is present every time, whether it needs changing or not, because the value of a
 * setup sheet is seeing the whole list settled rather than being told only about the one that is
 * currently misconfigured.
 *
 * ── why the recommendations are arithmetic, not taste ──
 *
 * Each number below is derived from a measurement, and the derivation is in the comment beside it.
 * Two of them are the reason this file exists at all:
 *
 *   - `shares` DEFAULTS TO 30, which costs about $18 a position. On a $30 bankroll that affords ONE
 *     trade, and after a single loss the balance cannot afford the next one — the account stalls
 *     rather than recovers. That is not a preference, it is a bankroll the default cannot run.
 *   - `riskPerTrade` DEFAULTS TO 0.25, which is roughly three-quarters of the Kelly-optimal fraction
 *     at the win rate the LIVE book is actually showing. Over-betting a real edge still loses.
 *
 * PURE: a snapshot in, rows out. No clock, no network, no users module — which is what makes every
 * threshold below assertable in test/recommend.test.js.
 *
 * ── the shape of a row ──
 *
 *   { key, label, current, recommended, ok, severity, why, note }
 *
 * `why` is the arithmetic. `note` is the caveat, when there is one. `ok` is whether the current value
 * already satisfies the recommendation, so the page can be read by scanning one column.
 */

/**
 * PURE on purpose: this module requires nothing from the bot. src/trader.js pulls in axios, the
 * Kalshi client and the whole market layer at require time, so importing it to read one number would
 * make this file untestable in the same harnesses that stub the trader out. advice.js carries the
 * band the same way for the same reason.
 *
 * MUST be kept in step with src/trader.js MAX_PRICE, which is the source of truth for the entry band.
 * Affordability is measured at the CEILING, not the typical fill: a position that fits at 59¢ but not
 * at 65¢ is one that gets refused exactly when the signal is strongest.
 */
const BAND_HI = 0.65;
/** The typical fill, from the measured corpus rather than either extreme of the band. */
const TYPICAL_ENTRY = 0.588;
/** The two win-rate estimates that actually exist, and disagree. */
const WR_BACKTEST = 0.839;
const WR_LIVE = 0.73;
/** Kelly is divided by this. Quarter-Kelly is the standard hedge against a mis-estimated edge. */
const KELLY_DIVISOR = 4;
/** A daily stop should absorb this many typical losses before it trips. */
const STOP_LOSSES = 2;
/** ...but never be a bigger share of the bankroll than this, or it can't protect anything. */
const STOP_MAX_SHARE = 0.5;
const STOP_MIN_SHARE = 0.25;
/** A per-order cap is a backstop against a sizing bug, not a strategy dial. */
const ORDER_CAP_SHARE = 0.4;

const money = n => `$${(Number(n) || 0).toFixed(2)}`;
const cents = n => `${Math.round(Number(n) || 0)}¢`;
const pctStr = n => `${(Number(n) * 100).toFixed(0)}%`;

/** Two-sided Kalshi fee for one side, matching decide.fee exactly. */
function fee(price, shares) {
  return Math.ceil(+(0.07 * shares * price * (1 - price) * 100).toFixed(6)) / 100;
}

/**
 * The Kelly-optimal fraction of bankroll to stake, for a binary bought at `price`.
 *
 * On a binary, winning pays (1-price) per unit staked and losing costs the whole stake, so the odds
 * received are b = (1-price)/price and Kelly is (p·b − (1−p))/b. Returns 0 when the bet has no edge
 * rather than a negative number, because a negative Kelly is not a smaller bet — it is the other side,
 * which this bot cannot take.
 */
function kellyFraction(winRate, price = TYPICAL_ENTRY) {
  if (!(price > 0) || !(price < 1) || !Number.isFinite(winRate)) return 0;
  const b = (1 - price) / price;
  const f = (winRate * b - (1 - winRate)) / b;
  return f > 0 ? f : 0;
}

/**
 * The whole setup sheet for one account.
 *
 * `a` is a snapshot: { who, bankroll, live, shares, autoShares, riskPerTrade, dailyStopLoss,
 * maxOpen, maxPerDir, maxOrderCost, slippageCents, fillGrace, cashoutAt, downWarn }.
 * The caller extracts it, so this file has no opinion about where a setting lives.
 */
function forAccount(a) {
  const rows = [];
  const bank = Number(a.bankroll) > 0 ? Number(a.bankroll) : null;
  const add = r => rows.push({ ok: false, severity: 'note', note: null, ...r });

  // ── sizing, which is the only one that can make the bankroll unrunnable ──
  const risk = Number(a.riskPerTrade) || 0.25;
  const autoOn = a.autoShares === true;
  const autoShares = bank ? Math.floor((bank * risk) / BAND_HI) : null;
  const fixedShares = Number(a.shares) || 0;
  const fixedCost = fixedShares * TYPICAL_ENTRY + fee(TYPICAL_ENTRY, fixedShares);
  // The largest fixed count a bankroll can carry: it must fit inside the risk share at the ceiling.
  const maxFixed = bank ? Math.floor((bank * risk) / BAND_HI) : null;

  add({
    key: 'autoShares', label: 'Auto size',
    current: autoOn ? 'on' : 'off', recommended: 'on',
    ok: autoOn, severity: autoOn ? 'note' : 'high',
    why: bank
      ? `A fixed ${fixedShares} contracts costs ${money(fixedCost)} at a typical ${cents(TYPICAL_ENTRY * 100)} fill. ` +
        `On ${money(bank)} that leaves ${money(bank - fixedCost)} after one loss` +
        (fixedCost > 0 && bank - fixedCost < fixedCost
          ? ' — which cannot afford the NEXT position, so the account stalls rather than recovers.'
          : '.') +
        ` Auto size would use ${autoShares} contracts and shrink as the balance does.`
      : 'Auto size scales the position with the balance, so a drawdown reduces the bet instead of ' +
        'ending the account. Set a bankroll to see the arithmetic.',
    note: 'It only ever sizes DOWN from what the balance can carry.'
  });

  if (!autoOn) {
    add({
      key: 'shares', label: 'Shares per trade',
      current: String(fixedShares || '—'),
      recommended: maxFixed == null ? '—' : `${Math.max(1, maxFixed)} or fewer`,
      ok: maxFixed != null && fixedShares >= 1 && fixedShares <= maxFixed,
      severity: maxFixed != null && fixedShares > maxFixed ? 'high' : 'note',
      why: bank
        ? `${money(bank)} at ${pctStr(risk)} risk buys ${maxFixed} contracts at the ${cents(BAND_HI * 100)} ceiling. ` +
          `Above that, a ceiling-priced signal is refused for insufficient funds.`
        : 'Set a bankroll and this becomes arithmetic rather than a guess.',
      note: 'Only read while Auto size is off.'
    });
  }

  // ── Kelly sizing: size by the EDGE rather than by a flat share ──
  //
  // Reconstructed from the BETSSSSS $100→$457 challenge and backtested with a real fee model
  // (research-challenge-config.js): 3.1x on $30 at the live gate, 2.6x once 2¢ of slippage is charged,
  // $11 peak drawdown — against roughly 1.8x for flat sizing on the SAME 54 trades. It is also more
  // conservative per trade than the flat default, because maxFraction caps it at 7%.
  const kellyOn = a.kellySizing === true;
  add({
    key: 'kellySizing', label: 'Kelly sizing',
    current: kellyOn ? 'on' : 'off', recommended: 'on',
    ok: kellyOn, severity: kellyOn ? 'note' : 'warn',
    why: 'Flat sizing bets the same share of the balance on a 25-point edge and a 2-point one. Kelly ' +
      'bets in proportion to the edge. Backtested over 1806 markets: 3.1x on ' +
      (bank ? money(bank) : 'a small bankroll') + ' at the live gate (2.6x with 2¢ of slippage), ' +
      'against about 1.8x flat on the SAME 54 trades — and it is MORE conservative per trade, since ' +
      'Max per trade caps it at ' + pctStr(0.07) + '.',
    note: autoOn ? null : 'Needs Auto size on; it is a sizing mode, not a separate switch.'
  });

  // ── risk per trade: quarter-Kelly at the LIVE win rate, not the backtest's ──
  //
  // Kelly at the backtest's 83.9% is ~61% of bankroll; at the live book's 73% it is ~34%. The default
  // 0.25 is therefore about 0.41 Kelly on the optimistic estimate and 0.73 Kelly on the pessimistic
  // one. Since the two estimates disagree and only one of them is out-of-sample, the recommendation is
  // quarter-Kelly at the PESSIMISTIC rate — the choice that survives being wrong about which is true.
  const kLive = kellyFraction(WR_LIVE);
  const kBack = kellyFraction(WR_BACKTEST);
  const recRisk = Math.max(0.05, Math.round((kLive / KELLY_DIVISOR) * 100) / 100);
  add({
    key: 'riskPerTrade', label: 'Risk per trade',
    current: pctStr(risk), recommended: pctStr(recRisk),
    ok: risk <= recRisk * 1.5,
    severity: risk > kLive ? 'high' : (risk > recRisk * 1.5 ? 'warn' : 'note'),
    why: `Kelly-optimal is ${pctStr(kBack)} at the backtest's ${pctStr(WR_BACKTEST)} win rate but only ` +
      `${pctStr(kLive)} at the live book's ${pctStr(WR_LIVE)}. ${pctStr(recRisk)} is quarter-Kelly against ` +
      `the pessimistic one, which is the setting that survives being wrong about which rate is real.`,
    note: kellyOn
      ? 'Not read while Kelly sizing is on — Kelly fraction and Max per trade decide the size instead.'
      : (risk > kLive
        ? `${pctStr(risk)} is ABOVE full Kelly at the live win rate — over-betting a real edge still loses money.`
        : 'Raise it only once live trades, not the backtest, support the higher rate.')
  });

  // ── the daily stop, which is the only setting that ends a bad night ──
  // Sized from the count ACTUALLY in use: autoOn, not the computed autoShares. Keyed off the number
  // this read `autoShares ? ...`, which is truthy whenever a bankroll is set — so an account with a
  // fixed 30 contracts had its stop sized against the 11 auto WOULD have used, understating the loss
  // it has to absorb by nearly 3x. A stop is only as good as the position size it was measured from.
  const inUse = autoOn ? autoShares : fixedShares;
  const typicalLoss = inUse > 0 ? inUse * TYPICAL_ENTRY + fee(TYPICAL_ENTRY, inUse) : null;
  let recStop = null;
  if (bank && typicalLoss) {
    recStop = Math.min(bank * STOP_MAX_SHARE, Math.max(bank * STOP_MIN_SHARE, typicalLoss * STOP_LOSSES));
    recStop = Math.max(1, Math.round(recStop));
  }
  const curStop = a.dailyStopLoss == null || a.dailyStopLoss === '' ? null : Number(a.dailyStopLoss);
  add({
    key: 'dailyStopLoss', label: 'Daily stop loss',
    current: curStop == null ? 'off' : money(curStop),
    recommended: recStop == null ? '—' : money(recStop),
    ok: curStop != null && recStop != null && curStop <= bank * STOP_MAX_SHARE,
    severity: curStop == null ? 'high' : (curStop > bank * STOP_MAX_SHARE ? 'warn' : 'note'),
    why: recStop == null
      ? 'Blank means a bad night runs until the balance does. Set a bankroll to size it.'
      : `A typical loss is ${money(typicalLoss)}, so ${money(recStop)} absorbs about ${STOP_LOSSES} of them ` +
        `and then stops opening. A stop above ${money(bank * STOP_MAX_SHARE)} cannot trip before the ` +
        `account is gone anyway.`,
    note: 'It never sells. Anything already open stays managed — abandoning a live position is worse.'
  });

  // ── concurrency: the cap only means something if the bankroll can fund it ──
  const maxOpen = Number(a.maxOpen) || 3;
  // Same correction as the stop: the cost of a position the account will actually open, priced at the
  // ceiling so a dear fill still fits.
  const posCost = inUse > 0 ? inUse * BAND_HI + fee(BAND_HI, inUse) : 0;
  const affordable = bank && posCost > 0 ? Math.max(1, Math.floor(bank / posCost)) : null;
  add({
    key: 'maxOpen', label: 'Max positions open',
    current: String(maxOpen),
    recommended: affordable == null ? '3' : String(Math.min(3, affordable)),
    ok: affordable == null || maxOpen <= affordable,
    severity: affordable != null && maxOpen > affordable ? 'warn' : 'note',
    why: affordable == null
      ? '3 is the backstop on total exposure, carried over from the single-bankroll bot.'
      : `At ${money(posCost)} a position, ${money(bank)} funds ${affordable} at once. Setting it higher ` +
        `than that does not buy more trades — the free-cash check refuses them anyway.`
  });

  // ── directional concentration: the one row that is genuinely a preference ──
  const curDir = a.maxPerDir == null || a.maxPerDir === '' ? null : Number(a.maxPerDir);
  add({
    key: 'maxPerDir', label: 'Max same-direction open',
    current: curDir == null ? 'off' : String(curDir),
    recommended: a.downWarn ? '2' : 'off',
    ok: a.downWarn ? curDir != null && curDir <= 2 : true,
    severity: a.downWarn && curDir == null ? 'warn' : 'note',
    why: a.downWarn
      ? 'The DOWN book is currently under its warn threshold, which is what a one-sided book looks ' +
        'like when a trend turns against it. Capping same-direction exposure at 2 bounds that.'
      : 'Backtested: a cap of 1 raises the win rate 80.9% to 83.6% but CUTS net ($417 to $381), because ' +
        'the trades it declines still won 69%. Off is the higher-expectancy setting.',
    note: 'A real trade of hit rate against dollars. Turn it on if you would rather win more often than earn more.'
  });

  // ── exits: measured, and the answer was "do not" ──
  const curCash = a.cashoutAt == null || a.cashoutAt === '' ? null : Number(a.cashoutAt);
  add({
    key: 'cashoutAt', label: 'Cash out at',
    current: curCash == null ? 'off (hold to settlement)' : cents(curCash * 100),
    recommended: 'off', ok: curCash == null,
    severity: curCash == null ? 'note' : 'warn',
    why: 'Every take-profit variant tested LOST on both return and Sharpe — selling at 85/90/95¢ capped ' +
      'about 50 winners to rescue about 1. This bot enters late on confirmation, so a position that ' +
      'climbs to 90¢ was going to settle at $1 anyway.',
    note: 'The competitor\'s early exit helps IT because it enters cheap at onset, where reversal risk is real.'
  });

  // ── execution: slippage is priced against the EDGE, which is what makes it answerable ──
  //
  // The measured margin is win% − avgEntry ≈ 25pp at this gate. Every cent chased moves the entry up
  // one cent, so it costs 1pp of that 25pp — about 4% of the edge per cent. Two cents is ~8%, which is
  // worth paying to fill at all; five would be a fifth of the edge. Zero is not free either: the limit
  // sits exactly at the quote and a ticking market simply misses.
  const slip = a.slippageCents == null ? 2 : Number(a.slippageCents);
  const MARGIN_PP = 25;
  add({
    key: 'slippageCents', label: 'Slippage allowance',
    current: `${slip}¢`, recommended: '2¢',
    ok: slip >= 1 && slip <= 3,
    severity: slip > 4 ? 'warn' : 'note',
    why: `The measured edge is about ${MARGIN_PP}pp of margin over breakeven. Each cent chased spends 1pp ` +
      `of it — roughly ${(100 / MARGIN_PP).toFixed(0)}% of the edge per cent — so 2¢ costs about ` +
      `${(2 * 100 / MARGIN_PP).toFixed(0)}% and still fills a moving book. At 0¢ the limit sits on the ` +
      `quote and a ticking market misses outright.`,
    note: 'It does not protect against a real jump: two logged misses read "wanted 56¢, now 82¢".'
  });

  const grace = a.fillGrace == null ? 3 : Number(a.fillGrace);
  add({
    key: 'fillGrace', label: 'Fill grace',
    current: `${grace}s`, recommended: '3s',
    ok: grace >= 2 && grace <= 6,
    severity: grace > 10 ? 'warn' : 'note',
    why: 'How long live waits before READING whether the order filled — not how long the order rests. ' +
      'An order arrives in a few hundred milliseconds, so 3s is a comfortable margin. Longer only ' +
      'delays the loop; much shorter risks reading the book before the fill lands and calling it a miss.'
  });

  // ── a backstop that is not a strategy dial ──
  const curCap = a.maxOrderCost == null || a.maxOrderCost === '' ? null : Number(a.maxOrderCost);
  const recCap = bank ? Math.max(1, Math.round(bank * ORDER_CAP_SHARE)) : null;
  add({
    key: 'maxOrderCost', label: 'Max cost per order',
    current: curCap == null ? 'off' : money(curCap),
    recommended: recCap == null ? '—' : money(recCap),
    ok: curCap != null && recCap != null && curCap <= bank * STOP_MAX_SHARE,
    severity: 'note',
    why: recCap == null
      ? 'A cap catches a wrong price or share count before the exchange does.'
      : `${money(recCap)} is ${pctStr(ORDER_CAP_SHARE)} of the bankroll — above any position the sizing ` +
        `should ever produce, so it only fires when the arithmetic is wrong.`,
    note: 'A guard against a bug, not a way to tune size. Leave the sizing to Risk per trade.'
  });

  return rows;
}

const RANK = { high: 0, warn: 1, note: 2 };

/** Rows for one account, unsorted (declaration order IS the setup order — sizing before exits). */
function review(snapshot) {
  return forAccount(snapshot || {});
}

/** How many rows need attention, so a tab can carry a count without re-deriving it. */
function needsAttention(rows) {
  return rows.filter(r => !r.ok).sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/**
 * What the recommended settings actually MEAN in dollars, at both win-rate estimates.
 *
 * Without this the sheet is a list of safer-sounding numbers with no visible cost. Quarter-Kelly at
 * the pessimistic rate is genuinely conservative — on a small bankroll it can mean single-digit
 * contracts — and the honest way to present that is to show the per-night arithmetic beside it rather
 * than let "recommended" imply "free". `nightly` is expectation only; a median night differs from an
 * average one, and neither is a promise.
 */
function summary(snapshot, { tradesPerNight = 6.3 } = {}) {
  const bank = Number((snapshot || {}).bankroll) > 0 ? Number(snapshot.bankroll) : null;
  if (!bank) return null;
  const recRisk = Math.max(0.05, Math.round((kellyFraction(WR_LIVE) / KELLY_DIVISOR) * 100) / 100);
  const shares = Math.floor((bank * recRisk) / BAND_HI);
  if (shares < 1) {
    return {
      bankroll: bank, risk: recRisk, shares: 0, tooSmall: true,
      note: `At ${pctStr(recRisk)} risk, ${money(bank)} does not fund one contract at the ` +
        `${cents(BAND_HI * 100)} ceiling. The bankroll is below what this gate can trade safely.`
    };
  }
  const f = fee(TYPICAL_ENTRY, shares);
  const win = +(shares * (1 - TYPICAL_ENTRY) - f).toFixed(2);
  const loss = +(-(shares * TYPICAL_ENTRY) - f).toFixed(2);
  const ev = wr => +((wr * win + (1 - wr) * loss) * tradesPerNight).toFixed(2);
  return {
    bankroll: bank, risk: recRisk, shares, tooSmall: false,
    cost: +(shares * TYPICAL_ENTRY + f).toFixed(2),
    win, loss, tradesPerNight,
    nightly: { backtest: ev(WR_BACKTEST), live: ev(WR_LIVE), breakeven: ev(TYPICAL_ENTRY) },
    note: `Expectation, not a median, and it assumes trades are independent — 93% of entries are NO, ` +
      `so a rally takes several at once and the real downside is worse than these figures.`
  };
}

module.exports = {
  review, forAccount, needsAttention, summary, kellyFraction, fee,
  TYPICAL_ENTRY, WR_BACKTEST, WR_LIVE, KELLY_DIVISOR,
  STOP_LOSSES, STOP_MIN_SHARE, STOP_MAX_SHARE, ORDER_CAP_SHARE
};

