/**
 * The Discord panel. One screen, and everything else one press away.
 *
 * ── the design brief, taken literally ──
 *
 * The other bot's panel is 5,000 lines across a dozen sub-views, and finding the one number you
 * wanted meant remembering which of them held it. So the default view here answers the four
 * questions somebody actually opens a trading bot to ask — is it armed, what do I hold, what did
 * today do, how much money is there — and every other control sits behind a single press.
 *
 * ── "The application did not respond" is designed out, not patched later ──
 *
 * Discord gives an interaction THREE SECONDS. Miss it and the token is dead, so nothing can be
 * said afterwards. In the other bot three separate code paths could return without acknowledging
 * — a stale button from an old deploy, a click before startup finished, an interaction type no
 * branch claimed — and each produced that message. So `handle()` is a boundary that acknowledges
 * whatever the dispatcher left unacknowledged, from the first commit rather than after the first
 * complaint.
 *
 * ── every refusal shows its arithmetic ──
 *
 * Not "cannot size" but the two numbers that made it impossible. A refusal that hides them is
 * indistinguishable from a bug, and it cost a real evening on the other bot.
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags
} = require('discord.js');

const { OWNER_ID } = require('./config');
const settings = require('./settings');
const users = require('./users');
const book = require('./book');
const gl = require('./markets');
const auth = require('./kalshiauth');
const kt = require('./kalshitrade');

const NAME = 'Indicators';
const VERSION = 'v0.1';

const ID = 'ib';                                  // customId namespace
const money = users.money;
const signed = n => `${Number(n) >= 0 ? '+' : '-'}$${Math.abs(Number(n) || 0).toFixed(2)}`;
const pct = n => (n == null ? '—' : `${(Number(n) * 100).toFixed(1)}%`);

/**
 * Aligned key/value block.
 *
 * Discord proportional text cannot be aligned — two lines of `label   value` drift apart and the
 * panel reads as ransom-note. A fenced block is monospaced, so padding actually lines up, and it
 * is the difference between a screen that looks built and one that looks pasted.
 */
function table(rows, { width } = {}) {
  const visible = rows.filter(Boolean);
  const w = width || Math.max(...visible.map(([k]) => String(k).length));
  return '```\n' + visible.map(([k, v]) => `${String(k).padEnd(w)}  ${v}`).join('\n') + '\n```';
}

/** A small bar, for a share of something. Reads faster than a percentage. */
function bar(frac, slots = 12) {
  const n = Math.max(0, Math.min(slots, Math.round((Number(frac) || 0) * slots)));
  return '█'.repeat(n) + '░'.repeat(slots - n);
}

let ctx = null;
function init(context) { ctx = context || {}; return true; }

function owns(interaction) {
  const id = interaction.customId || interaction.commandName;
  return Boolean(id && (id === 'dashboard' || String(id).startsWith(`${ID}:`)));
}
const isOwner = i => Boolean(OWNER_ID) && i.user.id === OWNER_ID;

// ── the one screen ──────────────────────────────────────────────

/**
 * Balance, cached briefly.
 *
 * Kalshi is not asked on every button press: the panel is repainted by most actions and a
 * balance that costs a round trip each time makes the whole thing feel slow. 20s is short enough
 * that a deposit shows up while you are still looking at it.
 */
const BAL_TTL_MS = 20000;
async function balanceFor(t) {
  const rec = t.rec;
  const fresh = rec.balanceAt && (Date.now() - new Date(rec.balanceAt).getTime()) < BAL_TTL_MS;
  if (fresh && rec.balance != null) return { dollars: rec.balance, cached: true };
  if (!auth.isImported(t.userId)) return { dollars: null, cached: false, why: 'no key imported' };
  try {
    const client = kt.forUser(auth.forUser(t.userId));
    const b = await client.balance();
    if (b && b.ok && b.dollars != null) {
      rec.balance = b.dollars;
      rec.balanceAt = new Date().toISOString();
      t.save();
      return { dollars: b.dollars, cached: false };
    }
    return { dollars: rec.balance, cached: true, why: (b && b.why) || 'Kalshi did not answer' };
  } catch (e) {
    return { dollars: rec.balance, cached: true, why: e.message };
  }
}

function statusLine(t) {
  const live = t.get('live');
  if (gl.isKilled()) {
    return { title: 'Halted', colour: 0xf87171,
      text: 'The kill switch is on, so nothing will open for anybody.' };
  }
  if (!live) {
    return { title: 'Paper', colour: 0x5b9dff,
      text: 'Every decision is recorded and priced. No order is sent.' };
  }
  const block = t.liveBlock();
  if (!block) {
    return { title: 'Live · armed', colour: 0x4ade80,
      text: 'The next qualifying signal buys with real money.' };
  }
  return { title: 'Live · not trading', colour: 0xfbbf24, text: block };
}

async function mainPayload(t) {
  const bal = await balanceFor(t);
  const st = statusLine(t);
  const open = book.openPositions(t.rec.book);
  const all = book.stats(t.rec.book);
  const todayBook = book.todayStats(t.rec.book);
  const keyed = auth.isImported(t.userId);
  const live = t.get('live');

  // The bankroll actually in play. Live is capped by the real balance — you cannot allocate
  // money you do not hold — and showing the number typed rather than the number used is the
  // display-versus-execution split that made the other bot's sizing screen untrustworthy.
  const asked = live ? t.get('liveBankroll') : t.get('paperBankroll');
  const ceiling = live ? (bal.dollars == null ? null : bal.dollars) : null;
  const effective = live
    ? (asked == null ? ceiling : (ceiling == null ? asked : Math.min(asked, ceiling)))
    : asked;
  const shortfall = live && asked != null && ceiling != null && ceiling < asked - 0.005;

  const atRisk = book.atRisk(t.rec.book);
  const e = new EmbedBuilder()
    .setColor(st.colour)
    .setAuthor({ name: `${NAME} ${VERSION}` })
    .setTitle(st.title)
    .setDescription(st.text);

  e.addFields({
    name: live ? 'Real money' : 'Paper',
    value: table([
      ['Bankroll', effective == null ? '—' : money(effective) +
        (shortfall ? `   (asked ${money(asked)}, you hold ${money(ceiling)})` : '')],
      live && ['Kalshi balance', bal.dollars == null ? `—  ${bal.why || ''}` : money(bal.dollars)],
      ['Today', `${signed(todayBook.net)}  on ${todayBook.n} closed`],
      ['All time', `${signed(all.net)}  on ${all.n} closed${all.hit == null ? '' : `  ·  ${pct(all.hit)} won`}`],
      atRisk > 0 && ['At risk now', money(atRisk)]
    ]),
    inline: false
  });

  e.addFields({
    name: `Open  ·  ${open.length}`,
    value: open.length
      ? table(open.slice(0, 6).map(p => [
        `${p.sym} ${p.direction}`,
        `${p.contracts}× @${p.priceCents}c   ${money(p.cost)}`
      ])) + (open.length > 6 ? `…and ${open.length - 6} more` : '')
      : '_nothing open_',
    inline: false
  });

  e.addFields({
    name: 'How it trades',
    value: table([
      ['Shares/trade', t.fmt('shares')],
      ['Exit', t.fmt('cashoutAt')],
      ['Daily stop', t.fmt('dailyStopLoss') +
        (t.get('dailyStopLoss') != null ? `   today ${signed(t.day().realised)}` : '')],
      ['Markets', `${gl.enabledSyms().length}/${gl.SYMS.length} on` +
        (gl.enabledSyms().length === gl.SYMS.length ? '' : `   off: ${gl.SYMS.filter(x => !gl.isEnabled(x)).join(' ')}`)]
    ]),
    inline: false
  });

  if (gl.isKilled()) {
    e.addFields({
      name: '🚨 Kill switch is ON',
      value: 'Nothing opens for anybody. Positions already held are still managed and settled.',
      inline: false
    });
  }
  if (!keyed) {
    e.addFields({
      name: '⚠️  No Kalshi key yet',
      value: 'Live trading needs one. **Import key** below — the Key ID and the whole `.key` ' +
        'file from Kalshi → Account & security → API Keys. It is proven against your account ' +
        'before it is trusted.',
      inline: false
    });
  }
  e.setFooter({ text: t.rec.tag ? `${t.rec.tag}${t.isOwner ? '  ·  owner' : ''}` : t.userId });
  return { embeds: [e], components: mainComponents(t), flags: MessageFlags.Ephemeral };
}

function mainComponents(t) {
  const live = t.get('live'), armed = t.get('armed');
  const keyed = auth.isImported(t.userId);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID}:arm`)
      .setLabel(armed ? 'Disarm' : 'Arm')
      .setStyle(armed ? ButtonStyle.Danger : ButtonStyle.Success)
      // Arming with no key would fail at the order, not at the button. Refusing here says why.
      .setDisabled(!keyed && !armed),
    new ButtonBuilder().setCustomId(`${ID}:live`)
      .setLabel(live ? 'Go paper' : 'Go live')
      .setStyle(live ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${ID}:refresh`).setLabel('Refresh').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID}:settings`).setLabel('Settings').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ID}:trades`).setLabel('Trades').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ID}:key`)
      .setLabel(keyed ? 'Replace key' : 'Import key')
      .setStyle(keyed ? ButtonStyle.Secondary : ButtonStyle.Primary)
  );
  if (t.isOwner) {
    row2.addComponents(new ButtonBuilder().setCustomId(`${ID}:admin`)
      .setLabel('Owner').setStyle(ButtonStyle.Danger));
  }
  return [row1, row2];
}

// ── settings ────────────────────────────────────────────────────

function settingsPayload(t) {
  const e = new EmbedBuilder().setTitle('Settings').setColor(0x71717a)
    .setDescription('Press one to change it. Every value shows what it is now.');
  for (const [g, label] of Object.entries(settings.GROUPS)) {
    const keys = settings.keysIn(g);
    if (!keys.length) continue;
    e.addFields({
      name: label,
      value: keys.map(k => `**${settings.SCHEMA[k].label}** — ${t.fmt(k)}`).join('\n'),
      inline: false
    });
  }
  // Four rows of five is Discord's limit; the schema is smaller than that, but slice anyway so
  // adding a setting can never break the panel with an invalid payload.
  const keys = Object.keys(settings.SCHEMA).slice(0, 20);
  const rows = [];
  for (let i = 0; i < keys.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      ...keys.slice(i, i + 5).map(k => new ButtonBuilder()
        .setCustomId(`${ID}:set:${k}`)
        .setLabel(settings.SCHEMA[k].label)
        .setStyle(ButtonStyle.Secondary))
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID}:home`).setLabel('◀ Back').setStyle(ButtonStyle.Primary)));
  return { embeds: [e], components: rows.slice(0, 5), flags: MessageFlags.Ephemeral };
}

function settingModal(t, key) {
  const spec = settings.SCHEMA[key];
  const m = new ModalBuilder().setCustomId(`${ID}:setmodal:${key}`).setTitle(spec.label);
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(spec.label.slice(0, 45))
    .setStyle(spec.help && spec.help.length > 120 ? TextInputStyle.Short : TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder(`now: ${t.fmt(key)}${spec.nullable ? '  ·  blank to turn off' : ''}`.slice(0, 100));
  return m.addComponents(new ActionRowBuilder().addComponents(input));
}

function keyModal() {
  return new ModalBuilder().setCustomId(`${ID}:keymodal`).setTitle('Import Kalshi key')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('keyid').setLabel('Key ID').setStyle(TextInputStyle.Short).setRequired(true)
        .setPlaceholder('the UUID Kalshi shows next to the key')),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('privatekey').setLabel('Private key (the whole .key file)')
        .setStyle(TextInputStyle.Paragraph).setRequired(true)
        .setPlaceholder('-----BEGIN RSA PRIVATE KEY-----'))
    );
}

// ── trades ──────────────────────────────────────────────────────

function tradesPayload(t) {
  const closed = book.closedPositions(t.rec.book)
    .slice().sort((a, b) => new Date(b.exitAt || 0) - new Date(a.exitAt || 0)).slice(0, 12);
  const s = book.stats(t.rec.book);
  const e = new EmbedBuilder().setTitle('Recent trades').setColor(0x71717a)
    .setDescription(closed.length
      ? `${s.n} closed · ${pct(s.hit)} won · **${signed(s.net)}** net · ${money(s.fees)} in fees`
      : '_nothing closed yet_');
  if (closed.length) {
    e.addFields({
      name: 'Newest first',
      value: closed.map(p => {
        const when = p.exitAt ? new Date(p.exitAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
        const mark = (Number(p.pnl) || 0) >= 0 ? '🟢' : '🔴';
        return `${mark} ${when} **${p.sym}** ${p.direction} ${p.contracts}× @${p.priceCents}c → ` +
          `${p.exitPriceCents == null ? '—' : p.exitPriceCents + 'c'} · **${signed(p.pnl)}** _(${p.outcome})_`;
      }).join('\n').slice(0, 1024),
      inline: false
    });
  }
  return {
    embeds: [e],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${ID}:home`).setLabel('◀ Back').setStyle(ButtonStyle.Primary))],
    flags: MessageFlags.Ephemeral
  };
}

// ── owner ───────────────────────────────────────────────────────
//
// Everything fleet-wide lives behind one door, and the door is checked at the dispatcher rather
// than per-button, so a control added later is owner-only by default instead of by remembering.

/**
 * Every account's P&L, the kill switch, and the market toggles.
 *
 * Deliberately shows tags rather than raw ids where a tag is known, and never shows anybody's
 * Kalshi key or balance beyond what they have realised — the owner needs to see performance and
 * risk, which is not the same as needing to see somebody's account.
 */
function adminPayload() {
  const all = users.all();
  const rows = all.map(t => {
    const st = book.stats(t.rec.book);
    const today = book.todayStats(t.rec.book);
    const open = book.openPositions(t.rec.book).length;
    const live = t.get('live'), armed = t.get('armed');
    return {
      who: (t.rec.tag || t.userId).slice(0, 16),
      state: gl.isKilled() ? 'halted' : !live ? 'paper' : armed ? 'ARMED' : 'live',
      n: st.n, net: st.net, today: today.net, open,
      atRisk: book.atRisk(t.rec.book),
      hit: st.hit
    };
  }).sort((a, b) => b.net - a.net);

  const fleetNet = rows.reduce((a, r) => a + r.net, 0);
  const fleetToday = rows.reduce((a, r) => a + r.today, 0);
  const fleetRisk = rows.reduce((a, r) => a + r.atRisk, 0);
  const armedN = rows.filter(r => r.state === 'ARMED').length;

  const e = new EmbedBuilder()
    .setColor(gl.isKilled() ? 0xf87171 : armedN ? 0x4ade80 : 0x71717a)
    .setAuthor({ name: `${NAME} ${VERSION} · owner` })
    .setTitle(gl.isKilled() ? 'Halted — kill switch on' : `${all.length} account(s), ${armedN} armed`);

  e.addFields({
    name: 'Fleet',
    value: table([
      ['Today', signed(fleetToday)],
      ['All time', signed(fleetNet)],
      ['At risk now', money(fleetRisk)],
      ['Markets on', `${gl.enabledSyms().length}/${gl.SYMS.length}`]
    ]),
    inline: false
  });

  e.addFields({
    name: 'Accounts',
    value: rows.length
      ? table(rows.map(r => [
        r.who,
        `${r.state.padEnd(6)} ${String(r.n).padStart(4)}T ${signed(r.net).padStart(9)}` +
        `  today ${signed(r.today).padStart(8)}${r.open ? `  ${r.open} open` : ''}`
      ]))
      : '_no accounts yet_',
    inline: false
  });

  e.addFields({
    name: 'Markets',
    value: table(gl.SYMS.map(sym => [sym, gl.isEnabled(sym) ? '● on' : '○ off'])),
    inline: false
  });

  return { embeds: [e], components: adminComponents(), flags: MessageFlags.Ephemeral };
}

function adminComponents() {
  const rows = [];
  // One button per market, in two rows of four/three. Labelled with the state it is IN, not the
  // action, because a button reading "BTC off" is ambiguous about which it means.
  for (let i = 0; i < gl.SYMS.length; i += 4) {
    rows.push(new ActionRowBuilder().addComponents(
      ...gl.SYMS.slice(i, i + 4).map(sym => new ButtonBuilder()
        .setCustomId(`${ID}:mkt:${sym}`)
        .setLabel(`${sym} ${gl.isEnabled(sym) ? 'on' : 'off'}`)
        .setStyle(gl.isEnabled(sym) ? ButtonStyle.Success : ButtonStyle.Secondary))
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID}:kill`)
      .setLabel(gl.isKilled() ? 'Lift kill switch' : 'KILL SWITCH')
      .setStyle(gl.isKilled() ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${ID}:admin`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ID}:home`).setLabel('◀ Back').setStyle(ButtonStyle.Primary)
  ));
  return rows.slice(0, 5);
}

module.exports = {
  NAME, VERSION, ID, init, owns, isOwner,
  mainPayload, mainComponents, settingsPayload, settingModal, keyModal, tradesPayload,
  adminPayload, adminComponents, table, bar,
  balanceFor, statusLine
};
