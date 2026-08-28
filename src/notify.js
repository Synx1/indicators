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

const cents = n => `${Math.round(Number(n) * 100)}¢`;
const money = n => `$${Math.abs(Number(n) || 0).toFixed(2)}`;
const signed = n => `${Number(n) < 0 ? '-' : '+'}$${Math.abs(Number(n) || 0).toFixed(2)}`;
const arrow = dir => (dir === 'UP' ? '▲ UP' : '▼ DOWN');
/** The two entry styles, in the words a person would use. */
const readOf = style => (style === 'DIP' ? 'bought a dip' : 'chased a move');

let dm = async () => false;
let log = () => {};
function init(opts = {}) {
  dm = opts.dm || dm;
  log = opts.log || log;
  return true;
}

/**
 * Send, and never let a delivery problem reach the caller.
 *
 * A user with DMs closed reports 50007, which is permanent rather than transient, so it is not
 * retried. Losing a notification must never cost a trade or a settlement: this is the last thing
 * in every path for exactly that reason.
 */
async function send(userId, payload) {
  try { return await dm(userId, payload); }
  catch (e) { log(`  dm to ${userId} failed: ${e.message}`); return false; }
}

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
    `**${p.sym} ${arrow(p.direction)}**   ·   ${p.confidence}% · ${p.confirm}/4`);
  e.addFields({
    name: '​',
    value: [
      `**${p.contracts} shares @ ${cents(p.price)}**`,
      `cost ${money(p.cost)}   ·   fee ${money(p.entryFee)}   ·   total ${money(p.total)}`,
      `📖 Read: ${readOf(p.style)}`
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
      'A larger **Slippage allowance** catches more of these — every cent chased comes off the ' +
      'edge, so it is a trade rather than a free fix.'
    ].join('\n'),
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
      `📖 Read: ${readOf(p.style)}   ·   ${p.confidence}% · ${p.confirm}/4`
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

module.exports = { init, entry, missedFill, cashout, settled, awaitingSettlement, readOf };
