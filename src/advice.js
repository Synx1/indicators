/**
 * What is worth telling the owner about the accounts.
 *
 * ── why this is a module and not a paragraph in the panel ──
 *
 * Every rule below is a mistake this bot has already made or allowed: a size that was 96% of the
 * account, an arm on a balance that could not pay for the order, a daily stop larger than the
 * money it was protecting, a key file that stopped decrypting, live left on with nothing armed so
 * every signal quietly filled paper. Each was noticed by a person reading numbers and doing
 * arithmetic in their head, hours late. Arithmetic is what a computer is for.
 *
 * It is PURE — account snapshots in, findings out. No Discord, no network, no clock: the trading
 * day is passed in. That is what makes each rule assertable, and the half worth asserting is not
 * that a rule fires but that it stays quiet, because an advice panel that cries wolf buries its
 * one real finding in a list nobody reads.
 *
 * ── the shape of a finding ──
 *
 *   { severity: 'high' | 'warn' | 'note', code, who, text, fix }
 *
 * `text` says what is true, `fix` says what to do about it, and they are separate because the
 * first is a fact and the second is a suggestion the owner may reasonably ignore.
 */

/** The cheapest and dearest this bot will pay, which bound every affordability sum here. */
const BAND_LO = 0.25;
// Kept in step with src/trader.js MAX_PRICE, which is the source of truth for the entry band.
const BAND_HI = 0.65;
/** One trade over half the account is the line: two losses in a row at that size is the account. */
const CONCENTRATION = 0.5;
/** A stop this close to the whole balance cannot trip before the account is gone anyway. */
const STOP_SHARE = 0.8;
/** Below this many closed trades a market's P&L is noise, not a verdict. */
const MARKET_MIN_N = 5;
/** A rejection older than this is history rather than a live problem. */
const REJECT_FRESH_MIN = 60;

const money = n => `${Number(n) < 0 ? '-' : ''}$${Math.abs(Number(n) || 0).toFixed(2)}`;
const RANK = { high: 0, warn: 1, note: 2 };

/**
 * Findings for one account.
 *
 * `a` is a snapshot rather than a tenant: { who, userId, live, armed, keyed, keyFile, balance,
 * shares, dailyStop, todayRealised, paperOpen, liveOpen, atRiskLive }. The caller does the
 * extraction, so this file has no opinion about where a book lives.
 */
function forAccount(a) {
  const out = [];
  const add = (severity, code, text, fix) => out.push({ severity, code, who: a.who, text, fix });

  const shares = Number(a.shares) || 0;
  const bal = a.balance == null ? null : Number(a.balance);

  // ── an order the exchange refused, which outranks every configuration question ──
  //
  // Armed, signals qualifying, and every order bouncing is the worst state this bot has: with paper
  // off while armed, nothing is being recorded either, so the experience is a bot that does nothing
  // and says nothing. It carries Kalshi's own words rather than "order failed", because the fix
  // depends entirely on which refusal it is.
  const rej = a.lastReject;
  if (rej && rej.why) {
    const at = new Date(rej.at).getTime();
    const now = a.now ? new Date(a.now).getTime() : Date.now();
    const mins = Number.isFinite(at) ? Math.round((now - at) / 60000) : null;
    if (mins != null && mins <= REJECT_FRESH_MIN) {
      add('high', 'order-rejected',
        `Kalshi refused the last live order${rej.sym ? ` on ${rej.sym}` : ''}` +
        `${mins <= 1 ? ' just now' : ` ${mins} minutes ago`}` +
        `${rej.status ? ` (${rej.status})` : ''}: ${rej.why}`,
        'Nothing is at risk — the order never entered the book. It will repeat on every signal ' +
        'until it is resolved; disarm if you would rather keep collecting paper results.');
    }
  }

  // ── credentials first: they invalidate everything below them ──
  if (a.armed && !a.keyed && a.keyFile) {
    add('high', 'key-unreadable',
      'A key file exists but will not decrypt, so no order can be signed. Almost always ' +
      'KALSHI_KEY_SECRET having changed since the key was saved.',
      'Set the old secret back if you know it, or re-import the key.');
  } else if (a.armed && !a.keyed) {
    add('high', 'armed-no-key',
      'Armed with no Kalshi credential at all, so every entry will be refused before it is sent.',
      'Import a key, or disarm to make the paper book honest.');
  }

  // ── size against the money that actually exists ──
  if (a.live && bal != null && shares > 0) {
    const worst = shares * BAND_HI;
    if (worst > bal * CONCENTRATION) {
      const share = Math.round((worst / bal) * 100);
      const safer = Math.max(1, Math.floor((bal * CONCENTRATION) / BAND_HI));
      add('high', 'size-vs-balance',
        `One trade is up to ${money(worst)} of a ${money(bal)} balance — ${share}% of the ` +
        'account. A binary loses the whole stake, so two in a row at this size is the account.',
        `${safer} contracts keeps one trade under half. Auto size does this sum on every fill.`);
    }
    if (a.armed && bal < shares * BAND_LO) {
      add('high', 'cannot-afford',
        `Armed, but ${money(bal)} cannot buy ${shares} contracts even at ${BAND_LO * 100}¢ ` +
        `(${money(shares * BAND_LO)}). Every order goes out and comes back refused.`,
        'Fund the account, turn auto size on, or lower the size.');
    }
  }

  // ── collateral on the wrong exchange shard ──
  //
  // Kalshi holds cash per exchange shard and the matching engine checks an order against the shard
  // its market lives on: crypto is shard 2. An account with $24.88 on shard 0 and 2c on shard 2 has
  // a healthy-looking balance and cannot buy a single contract — it produces a bare
  // "400 insufficient balance" on every signal, which reads as a bot fault rather than a funding
  // one. This is the finding that would have saved an evening.
  if (a.live && a.balanceShards && a.cryptoShard != null) {
    const here = Number(a.balanceShards[String(a.cryptoShard)]) || 0;
    const total = Object.values(a.balanceShards).reduce((x, v) => x + (Number(v) || 0), 0);
    const elsewhere = +(total - here).toFixed(2);
    // Math.max(shares, 1): with auto size resolving to 0 on a starved shard the multiplication
    // would be 0 and the rule would go quiet in exactly the case it exists for.
    if (elsewhere > 1 && here < Math.max(shares, 1) * BAND_LO) {
      add('high', 'wrong-shard',
        `${money(here)} of a ${money(total)} balance is on exchange shard ${a.cryptoShard}, which ` +
        'is where the 15-minute crypto markets trade. Kalshi checks each order against that ' +
        `shard's cash, so ${money(elsewhere)} sitting elsewhere cannot back a single contract.`,
        `Transfer ${money(elsewhere)} to shard ${a.cryptoShard} — POST ` +
        '/portfolio/intra_exchange_instance_transfer, or the exchange-indexes page in the Kalshi ' +
        'app. A target balance allocation makes Kalshi rebalance it automatically.');
    }
  }

  // ── the daily stop ──
  const stop = a.dailyStop == null ? null : Math.abs(Number(a.dailyStop));
  if (stop != null && bal != null && stop >= bal * STOP_SHARE) {
    add('warn', 'stop-too-big',
      `The ${money(stop)} daily stop is ${Math.round((stop / bal) * 100)}% of a ${money(bal)} ` +
      'balance, so it cannot trip before the account is gone.',
      `Around ${money(Math.max(1, Math.round(bal * 0.3)))} would actually stop a bad day.`);
  }
  if (stop != null && Number(a.todayRealised) <= -stop) {
    add('warn', 'stop-hit',
      `Today is ${money(a.todayRealised)} against a ${money(stop)} limit, so live entries are ` +
      'being skipped. It lifts at midnight ET; nothing open was sold.',
      null);
  }

  // ── switches ──
  if (a.live && !a.armed) {
    add('note', 'live-never-armed',
      'Live is on but nothing is armed, so every signal is still filling as paper.',
      'Press Arm when you are watching. Arming never survives a restart.');
  }
  if (a.armed && Number(a.paperOpen) > 0) {
    add('note', 'paper-settling',
      `${a.paperOpen} paper position(s) from before arming are still settling. They are off the ` +
      'live panel and count only towards the paper book.',
      null);
  }

  return out;
}

/**
 * Findings across the fleet.
 *
 * Separate from forAccount() because a market being a loser is a property of the whole book, not
 * of one person's — and one account's twelve trades on SOL is not evidence about SOL.
 */
function forFleet({ markets = [] } = {}) {
  const out = [];
  const graded = markets.filter(m => Number(m.n) >= MARKET_MIN_N);
  const losers = graded.filter(m => Number(m.net) < 0).sort((a, b) => a.net - b.net);
  if (losers.length) {
    const w = losers[0];
    out.push({
      severity: 'note', code: 'worst-market', who: 'fleet',
      text: `${w.sym} is ${money(w.net)} over ${w.n} closed trades — the fleet's worst market.`,
      fix: `Turn ${w.sym} off in Markets if it stays negative; open positions still settle.`
    });
  }
  return out;
}

/**
 * Every finding, most severe first.
 *
 * Ties keep account order rather than being sorted by name, so the list is stable between renders
 * — a panel whose rows reshuffle on refresh reads as new information arriving.
 */
function review(accounts = [], opts = {}) {
  const found = [];
  for (const a of accounts) found.push(...forAccount(a));
  found.push(...forFleet(opts));
  return found.sort((x, y) => RANK[x.severity] - RANK[y.severity]);
}

module.exports = {
  review, forAccount, forFleet,
  BAND_LO, BAND_HI, CONCENTRATION, STOP_SHARE, MARKET_MIN_N, REJECT_FRESH_MIN
};
