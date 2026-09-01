/**
 * Discord DM notifications.
 *
 * ── why formatting gets its own module ──
 *
 * These are the only messages a user reliably reads — nobody watches a log — so they carry the
 * whole burden of explaining what the bot did and why. A notification that says "no fill" teaches
 * nothing; one that says the order was placed at your price and the book moved before anyone sold
 * into it tells you which setting to change. Every message here is written to answer the next
 * question rather than to announce an event.
 *
 * ── never posts to a channel ──
 *
 * This module is handed a DM function and nothing else. It has no way to address a channel, which
 * is what makes "a user's position can never be posted publicly" a structural fact rather than a
 * convention somebody has to keep remembering.
 */

const { EmbedBuilder } = require('discord.js');

const NAME = 'Indicators';
const VERSION = 'v0.1';

// These render straight into a user's DM, so a missing value must degrade to a dash rather than
// "NaN¢" or a confident "$0.00". Number(null) is 0 and Number(undefined) is NaN, so both need catching
// before the coercion — a price that failed to record is not a price of zero.
const cents = n => {
  if (n == null || n === '') return '—';
  const v = Number(n);
  return Number.isFinite(v) ? `${Math.round(v * 100)}¢` : '—';
};
const money = n => {
  if (n == null || n === '') return '—';
  const v = Number(n);
  return Number.isFinite(v) ? `$${Math.abs(v).toFixed(2)}` : '—';
};
const signed = n => `${Number(n) < 0 ? '-' : '+'}$${Math.abs(Number(n) || 0).toFixed(2)}`;
const arrow = dir => (dir === 'UP' ? '▲ UP' : '▼ DOWN');
/**
 * What the BOOK thinks, taken straight from what we paid. A contract bought at 66c is the market
 * saying 66%, and printing it beside the model's own number shows what this bot is actually betting:
 * not "85% likely" but "the model disagrees with the price by 19 points".
 *
 * ── which number to trust, measured properly ──
 *
 * An earlier version of this comment said the model runs ~19 points hot. That came from 44 entries on a
 * four-day corpus and it was wrong as a general claim. Over 386,958 out-of-sample rows across 68 days
 * the model is if anything COLD — it says 54.7% where 61.3% happens, and at its own 80% gate it is right
 * 91.9% of the time.
 *
 * The problem is not the model's calibration, it is which trades are affordable. On 24,542 priced rows
 * the book scores AUC 0.8806 to the model's 0.8376, and in the one band this bot can pay for
 * (confidence >=80 with an ask of 35-65c) the book's Brier is 0.249 against the model's 0.336 — the
 * market says coin flip and is right, while the model says 85% and is wrong. The trades the model IS
 * right about get priced at 90-98c, where they cannot pay.
 *
 * So both numbers are printed and the BOOK is the one to read. See research/corpus2/REBUILD.md.
 */
const bookPct = price => {
  // Guard before Number(): Number(null) is 0, so a missing fill would print "book 0%" — a confident
  // claim that the market thinks this is impossible, which is worse than printing nothing.
  if (price == null || price === '') return '—';
  const n = Number(price);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—';
};
/** The two entry styles, in the words a person would use. */
const readOf = style => (style === 'DIP' ? 'bought a dip' : 'chased a move');

let dm = async () => false;
let log = () => {};
/**
 * The minimum gap between two DMs, and the depth beyond which they are dropped.
 *
 * One account filling on seven markets is seven DMs; twenty accounts is a hundred and forty, all
 * inside one scan pass. Discord answers a burst like that with 429s, and discord.js handles those
 * by WAITING — which would land the delay inside the trading loop that is awaiting the send. So
 * the sends are spaced here instead, where a delay costs nothing.
 */
let gapMs = 250;
const MAX_QUEUED = 200;
let chain = Promise.resolve();
let queued = 0;

function init(opts = {}) {
  dm = opts.dm || dm;
  log = opts.log || log;
  if (opts.gapMs != null) gapMs = Number(opts.gapMs);
  return true;
}

const gap = () => new Promise(r => setTimeout(r, gapMs));

/** The actual delivery, which never throws — see send(). */
async function deliver(userId, payload) {
  try { return await dm(userId, payload); }
  catch (e) { log(`  dm to ${userId} failed: ${e.message}`); return false; }
}

/**
 * Queue a DM, and never let a delivery problem reach the caller.
 *
 * A user with DMs closed reports 50007, which is permanent rather than transient, so it is not
 * retried. Losing a notification must never cost a trade or a settlement: this is the last thing
 * in every path for exactly that reason.
 *
 * It does not WAIT for delivery either, and that is the same rule one step further. The trader
 * awaits this call from inside a scan pass; if the await also covered the queue's spacing, then at
 * twenty accounts a pass would be held open for seconds by messages nobody is reading yet — and a
 * pass that runs long is a pass whose spot price has gone stale, which is the one failure this bot
 * cannot afford. So the send is enqueued, ordered, and reported here rather than there.
 */
function send(userId, payload) {
  if (queued >= MAX_QUEUED) {
    log(`  !! dm queue is ${queued} deep — dropped a notification for ${userId}`);
    return false;
  }
  queued++;
  chain = chain
    .then(() => deliver(userId, payload))
    .then(() => { queued--; return gap(); }, () => { queued--; return gap(); });
  return true;
}

/** How many DMs are waiting. Exposed so the panel can say so rather than appearing to have stalled. */
function pending() { return queued; }

/** Resolves once every queued DM has been attempted. For tests and for a clean shutdown. */
function drain() { return chain; }

function base(colour, title, sub) {
  const e = new EmbedBuilder().setColor(colour).setTitle(title);
  if (sub) e.setDescription(sub);
  e.setFooter({ text: `${NAME} ${VERSION}` });
  return e;
}

// ── entries ─────────────────────────────────────────────────────

/**
 * A fill. Says what was bought, what it cost all-in, and what the bot read in the market.
 *
 * `total` is spelled out beside cost and fee because the fee is the part people forget, and on a
 * small position it is a real share of the trade — 3¢ on $4.50 is 0.7% before the market moves.
 */
async function entry(t, p, { live }) {
  const e = base(live ? 0xf87171 : 0x5b9dff,
    `🟢 Trade Taken   ·   ${live ? '🔴 Live' : '📝 Paper'}`,
    `**${p.sym} ${arrow(p.direction)}**   ·   model ${p.confidence}% · book ${bookPct(p.price)} · ${p.confirm}/4`);
  e.addFields({
    name: '​',
    value: [
      `**${p.contracts} shares @ ${cents(p.price)}**`,
      `cost ${money(p.cost)}   ·   fee ${money(p.entryFee)}   ·   total ${money(p.total)}`,
      `📖 Read: ${readOf(p.style)}`,
      `_The model says ${p.confidence}%; the price says ${bookPct(p.price)}. The gap IS the bet. Measured over ` +
        `68 days the price is the better forecast where the two disagree — read the book number as the honest one._`
    ].join('\n'),
    inline: false
  });
  return send(t.userId, { embeds: [e] });
}

/**
 * An order that did not fill.
 *
 * The important part is that this is NOT a rejection and not a bug — the order was placed
 * correctly and nobody sold into it. So the message says that in plain words and names the one
 * setting that changes the outcome, because otherwise the natural reading is "the bot is broken".
 */
async function missedFill(t, d, { limitCents, nowCents = null }) {
  const e = base(0xfbbf24, '⚠️ Missed the fill',
    `**${d.sym} ${arrow(d.direction)}** — the bot placed your order at your price, but the ` +
    'market moved before anyone sold into it (thin book).');
  e.addFields({
    name: '​',
    value: [
      `wanted **${cents(d.price)}**   ·   limit **${limitCents}¢**` +
        (nowCents != null ? `   ·   now **${nowCents}¢**` : ''),
      (nowCents != null && nowCents > limitCents
        ? `➡️ price jumped to **${nowCents}¢** — **${nowCents - limitCents}¢ past** your ${limitCents}¢ limit, so no one sold to you.`
        : ''),
      'A larger **Slippage allowance** catches more of these — every cent chased comes off the ' +
      'edge, so it is a trade rather than a free fix.'
    ].filter(Boolean).join('\n'),
    inline: false
  });
  return send(t.userId, { embeds: [e] });
}

/**
 * An order Kalshi REFUSED. Not the same event as a missed fill, and it must not be silent.
 *
 * A missed fill means the bot did everything right and nobody sold. A rejection means the order
 * never entered the book, so the reason is on our side or the exchange's — and it will repeat on
 * every signal until somebody changes something. Left in the log, it is experienced as "I armed it
 * and it takes no trades", which is exactly how it was reported on 2026-08-28.
 */
async function orderRejected(t, d, why) {
  const e = base(0xf87171, '⛔ Kalshi refused the order',
    `**${d.sym} ${arrow(d.direction)}** at ${cents(d.price)} — the order was never placed, so ` +
    'nothing is at risk and nothing was bought.');
  e.addFields({
    name: '​',
    value: `${why}\n\n_This will repeat on every signal until it is resolved. Paper is off while ` +
      'you are armed, so nothing is being recorded in the meantime — press **Disarm** if you would ' +
      'rather keep collecting paper results._',
    inline: false
  });
  return send(t.userId, { embeds: [e] });
}

/**
 * The owner enabled this account.
 *
 * Sent because the wait is otherwise indistinguishable from a broken bot: the panel renders, the
 * balance reads, and nothing ever trades. Somebody in that state has no way to tell whether they
 * are queued or ignored.
 */
async function enabled(t) {
  const e = base(0x4ade80, '✅ You are enabled',
    'The owner has switched your account on. From the next scan, qualifying signals will be acted ' +
    'on for you.');
  e.addFields({
    name: '​',
    value: 'It starts as **paper** — real bookkeeping on real prices, no order sent. To trade real ' +
      'money you also need to import a Kalshi key, press **Go live**, and then **Arm**.\n\n' +
      'Run `/dashboard` to see it.',
    inline: false
  });
  return send(t.userId, { embeds: [e] });
}

// ── exits ───────────────────────────────────────────────────────

/** Sold early, at the user's cashout price. */
async function cashout(t, p) {
  const won = (Number(p.pnl) || 0) >= 0;
  const e = base(won ? 0x4ade80 : 0xf87171, '💰 Cashed out',
    `**${p.sym} ${arrow(p.direction)}**   ·   ${cents(p.price)} → ${cents(p.exitPrice)}`);
  e.addFields({
    name: '​',
    value: [
      `**${signed(p.pnl)}**   on ${p.contracts} shares`,
      `fees ${money((Number(p.entryFee) || 0) + (Number(p.exitFee) || 0))} both ways`,
      '_Settlement is fee-free; a cashout pays a second fee. That is the cost of booking it early._'
    ].join('\n'),
    inline: false
  });
  return send(t.userId, { embeds: [e] });
}

/** Held to the close and graded by the exchange. */
async function settled(t, p, won) {
  const e = base(won ? 0x4ade80 : 0xf87171,
    won ? '✅ Won' : '❌ Lost',
    `**${p.sym} ${arrow(p.direction)}**   ·   entered ${cents(p.price)}   ·   ` +
    `settled ${won ? '100¢' : '0¢'}`);
  e.addFields({
    name: '​',
    value: [
      `**${signed(p.pnl)}**   on ${p.contracts} shares`,
      `fee ${money(p.entryFee)} on the way in   ·   settlement is fee-free`,
      `📖 Read: ${readOf(p.style)}   ·   model ${p.confidence}% · book ${bookPct(p.price)} · ${p.confirm}/4`
    ].join('\n'),
    inline: false
  });
  return send(t.userId, { embeds: [e] });
}

/**
 * A position whose round closed but which the exchange has not graded.
 *
 * Sent once, when it is first noticed, because silence here is indistinguishable from the bot
 * having forgotten the position — which is the complaint that prompted this whole module.
 */
async function awaitingSettlement(t, p, lateMin) {
  const e = base(0x71717a, '⏳ Waiting on settlement',
    `**${p.sym} ${arrow(p.direction)}** closed ${Math.round(lateMin)} min ago and Kalshi has ` +
    'not published a result yet.');
  e.addFields({
    name: '​',
    value: 'Nothing is wrong and nothing is stuck — the exchange settles a few minutes after ' +
      'the close. It will be graded automatically and you will get the result.',
    inline: false
  });
  return send(t.userId, { embeds: [e] });
}

/**
 * Somebody was armed and a restart cleared it.
 *
 * Sent because the alternative is a user watching paper fills arrive on an account they armed and
 * concluding the bot disarms itself at random. It is deliberate, it is a safety property, and it is
 * worth one message to say so — silence here reads as a bug.
 */
async function forcedDisarm(userId) {
  const e = base(0xfbbf24, '🔓 Disarmed by a restart',
    'The bot restarted, and **arming never survives a restart** — so your account is back to paper.');
  e.addFields({
    name: '​',
    value: 'That is deliberate rather than a fault: a crash loop, a redeploy or an unattended ' +
      'reboot all come back in paper, so real money can only ever be trading because somebody ' +
      'armed it since the process started.\n\nNothing was sold and nothing else changed. Run ' +
      '`/dashboard` and press **Arm** when you are watching again.',
    inline: false
  });
  return send(userId, { embeds: [e] });
}

module.exports = {
  init, forcedDisarm, enabled, entry, missedFill, orderRejected, cashout, settled,
  awaitingSettlement, readOf,
  pending, drain
};
