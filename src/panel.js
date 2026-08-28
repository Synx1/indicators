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
const auth = require('./kalshiauth');
const kt = require('./kalshitrade');

const NAME = 'Indicators';
const VERSION = 'v0.1';

const ID = 'ib';                                  // customId namespace
const money = users.money;
const signed = n => `${Number(n) >= 0 ? '+' : '-'}$${Math.abs(Number(n) || 0).toFixed(2)}`;
const pct = n => (n == null ? '—' : `${(Number(n) * 100).toFixed(1)}%`);

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
  const live = t.get('live'), armed = t.get('armed');
  if (!live) return { text: '📝 **PAPER** — decisions recorded, no orders sent', colour: 0x5b9dff };
  const block = t.liveBlock();
  if (!block) return { text: '🔴 **LIVE AND ARMED** — the next qualifying signal buys', colour: 0xf87171 };
  return { text: `🟡 **LIVE, NOT TRADING** — ${block}`, colour: 0xfbbf24 };
}

async function mainPayload(t) {
  const bal = await balanceFor(t);
  const st = statusLine(t);
  const open = book.openPositions(t.rec.book);
  const all = book.stats(t.rec.book);
  const dayLedger = t.day();
  const todayBook = book.todayStats(t.rec.book);

  const e = new EmbedBuilder()
    .setTitle(`${NAME} ${VERSION}`)
    .setColor(st.colour)
    .setDescription(st.text);

  e.addFields(
    {
      name: 'Money',
      value: [
        `Kalshi balance  **${bal.dollars == null ? '—' : money(bal.dollars)}**` +
          (bal.why ? `  _(${bal.why})_` : ''),
        `Today            **${signed(todayBook.net)}** on ${todayBook.n} closed`,
        `All time         **${signed(all.net)}** on ${all.n} closed` +
          (all.hit == null ? '' : ` · ${pct(all.hit)} won`)
      ].join('\n'),
      inline: false
    },
    {
      name: `Open — ${open.length}`,
      value: open.length
        ? open.slice(0, 6).map(p =>
          `**${p.sym}** ${p.direction} ${p.contracts}× @${p.priceCents}c  _(${money(p.cost)})_`).join('\n')
          + (open.length > 6 ? `\n_…and ${open.length - 6} more_` : '')
        : '_nothing open_',
      inline: false
    },
    {
      name: 'Size and exits',
      value: [
        `Shares per trade **${t.fmt('shares')}**`,
        `Exit             **${t.fmt('cashoutAt')}**`,
        `Daily stop       **${t.fmt('dailyStopLoss')}**` +
          (t.get('dailyStopLoss') != null ? `  _(today ${signed(dayLedger.realised)})_` : '')
      ].join('\n'),
      inline: false
    }
  );

  const keyed = auth.isImported(t.userId);
  if (!keyed) {
    e.addFields({
      name: '⚠️ No Kalshi key',
      value: 'Nothing can trade live until a key is imported. **Import key** below — you need ' +
        'the Key ID and the .key file from Kalshi → Account & security → API Keys.',
      inline: false
    });
  }
  e.setFooter({ text: t.rec.tag ? `${t.rec.tag} · ${t.userId}` : t.userId });

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

module.exports = {
  NAME, VERSION, ID, init, owns, isOwner,
  mainPayload, mainComponents, settingsPayload, settingModal, keyModal, tradesPayload,
  balanceFor, statusLine
};
