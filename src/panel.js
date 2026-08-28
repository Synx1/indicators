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

/**
 * Is the scanner actually running, and when did it last look?
 *
 * The panel could not answer the first question anybody asks — "is it on" — which meant the only
 * way to know was reading a log file. `lastPass` is the honest signal: a process can be alive
 * with a wedged loop, so this reports when a pass last COMPLETED rather than whether the module
 * loaded. Required lazily so the panel still renders with TRADER=off.
 */
function scannerLine() {
  let st = null;
  try { st = require('./trader').stats; } catch (_) { return ['Scanner', 'unavailable']; }
  if (!st || !st.lastPass) return ['Scanner', 'starting…'];
  const ageS = Math.round((Date.now() - new Date(st.lastPass).getTime()) / 1000);
  // Two poll intervals of silence means the loop is not turning, whatever the process is doing.
  const stale = ageS > 45;
  return ['Scanner', `${stale ? '⚠️ last pass ' : 'ok · '}${ageS}s ago` +
    `   ${st.decisions} signal${st.decisions === 1 ? '' : 's'}, ${st.entries} filled` +
    (st.lastError ? `   last error: ${String(st.lastError).slice(0, 40)}` : '')];
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
  if (fresh && rec.balance != null) {
    return { dollars: rec.balance, exact: rec.balanceExact, cached: true };
  }
  if (!auth.isImported(t.userId)) return { dollars: null, cached: false, why: 'no key imported' };
  try {
    const client = kt.forUser(auth.forUser(t.userId));
    const b = await client.balance();
    if (b && b.ok && b.dollars != null) {
      rec.balance = b.dollars;
      rec.balanceExact = b.exact != null ? b.exact : b.dollars;
      rec.balanceAt = new Date().toISOString();
      t.save();
      return { dollars: b.dollars, exact: rec.balanceExact, cached: false, breakdown: b.breakdown };
    }
    return { dollars: rec.balance, cached: true, why: (b && b.why) || 'Kalshi did not answer' };
  } catch (e) {
    return { dollars: rec.balance, cached: true, why: e.message };
  }
}

function statusLine(t) {
  const live = t.get('live');
  if (gl.isKilled()) {
    return { badge: '🚨', title: 'Halted', colour: 0xf87171,
      text: 'the kill switch is on, so nothing will open for anybody.' };
  }
  if (!live) {
    return { badge: '📝', title: 'Paper', colour: 0x5b9dff,
      text: 'every decision is recorded and priced at the real quote. No order is sent.' };
  }
  const block = t.liveBlock();
  if (!block) {
    return { badge: '🔴', title: 'Live and armed', colour: 0x4ade80,
      text: 'the next qualifying signal buys with real money.' };
  }
  return { badge: '🟡', title: 'Live, not trading', colour: 0xfbbf24, text: block };
}

async function mainPayload(t) {
  const bal = await balanceFor(t);
  const st = statusLine(t);
  const live = t.get('live');
  const b = t.rec.book;
  const open = book.openPositions(b);
  const all = book.stats(b, { liveOnly: live ? true : false });
  const today = book.todayStats(b);

  // ── the bankroll is a LIVE figure, not the setting ──
  //
  // It showed the number somebody typed while the account had actually made or lost money against
  // it: $100.00 on screen with $93.93 in the book. That is not a rounding disagreement, it is the
  // screen describing a different quantity from the one that matters.
  //
  // Live is capped by the real Kalshi balance, because you cannot allocate money you do not hold;
  // paper walks its own curve from the configured start.
  const startBal = live ? t.get('liveBankroll') : t.get('paperBankroll');
  const baseline = t.get('paperResetAt');
  const eq = book.equity(b, {
    start: Number(startBal) || 0,
    liveOnly: live ? true : false,
    sinceMs: live ? null : (baseline == null ? null : Number(baseline))
  });
  const ceiling = live && bal.dollars != null ? bal.dollars : null;
  const shown = live
    ? (ceiling == null ? eq.equity : Math.min(eq.equity, ceiling))
    : eq.equity;
  const capped = live && ceiling != null && eq.equity > ceiling + 0.005;

  const e = new EmbedBuilder()
    .setColor(st.colour)
    .setAuthor({ name: `${NAME} ${VERSION}  ·  ${live ? 'real money' : 'paper'}` })
    .setTitle(`${money(shown)}      ${eq.realised === 0 ? '—' : signed(eq.realised)} all time`)
    .setDescription(`${st.badge} **${st.title}** — ${st.text}`);

  // ── the headline block: where the money is ──
  e.addFields({
    name: 'Balance',
    value: table([
      ['Equity', money(shown) + (capped ? `   (capped by your ${money(ceiling)} balance)` : '')],
      ['Started at', money(eq.start)],
      ['Realised', signed(eq.realised)],
      eq.atRisk > 0 && ['Committed', `${money(eq.atRisk)} in ${open.length} open`],
      eq.atRisk > 0 && ['Free to bet', money(eq.free)]
    ]),
    inline: false
  });

  // ── performance: the three numbers that were missing ──
  //
  // `net` says where it ended. Only walking the curve gives the best it ever had and how far back
  // it has come — a book at +$5 having been +$60 is a different situation from one that climbed
  // steadily to +$5, and the totals report them identically.
  e.addFields({
    name: 'Performance',
    value: table([
      // Both lines in the SAME shape. They read as a comparison, so describing one with W/L and
      // the other with a percentage made them look like they disagreed when they never did.
      ['Today', `${signed(today.net)}   ${today.n} closed` +
        (today.n ? `  ·  ${today.wins}W/${today.losses}L  ·  ${pct(today.wins / today.n)}` : '')],
      ['All time', `${signed(all.net)}   ${all.n} closed` +
        (all.n ? `  ·  ${all.wins}W/${all.losses}L  ·  ${pct(all.hit)}` : '')],
      ['Peak equity', money(eq.peak) +
        (eq.fromPeak > 0.005 ? `   ${signed(-eq.fromPeak)} from peak` : '   ← at a new high')],
      eq.maxDrawdown > 0.005 && ['Worst drop', `${signed(-eq.maxDrawdown)} peak to trough`],
      all.n > 0 && ['Fees paid', money(all.fees)]
    ]) + (all.n >= 3 && all.hit != null
      // Win rate is the one figure here with a denominator that cannot be exceeded, so it is the
      // one a bar can honestly draw. Below three trades it would be drawing noise.
      //
      // Labelled "2 of 3 won" and not "66.7% of 3 won": the latter parses as "66.7%, of which 3
      // won", which is how a correct 2W/1L book got read as three wins.
      ? `${bar(all.hit)}  ${all.wins} of ${all.n} won\n` : ''),
    inline: false
  });

  e.addFields({
    name: open.length ? `Open  ·  ${open.length}  ·  ${money(eq.atRisk)} at risk` : 'Open  ·  0',
    value: open.length
      ? table(open.slice(0, 6).map(p => [
        `${p.sym} ${p.direction === 'UP' ? '▲' : '▼'}`,
        `${p.contracts}× @${p.priceCents}¢   ${money(p.cost)}   closes ${String(p.closeTime).slice(11, 16)}`
      ])) + (open.length > 6 ? `…and ${open.length - 6} more` : '')
      : '_nothing open — it enters when a market clears every gate_',
    inline: false
  });

  e.addFields({
    name: 'Setup',
    value: table([
      ['Shares/trade', t.fmt('shares')],
      ['Exit', t.fmt('cashoutAt')],
      ['Daily stop', t.fmt('dailyStopLoss') +
        (t.get('dailyStopLoss') != null ? `   today ${signed(t.day().realised)}` : '')],
      ['Markets', `${gl.enabledSyms().length}/${gl.SYMS.length} on` +
        (gl.enabledSyms().length === gl.SYMS.length ? '' : `   off: ${gl.SYMS.filter(x => !gl.isEnabled(x)).join(' ')}`)],
      scannerLine()
    ]),
    inline: false
  });

  if (gl.isKilled()) {
    e.addFields({ name: '🚨 Kill switch is ON',
      value: 'Nothing opens for anybody. Anything held is still managed and settled.', inline: false });
  }
  if (!auth.isImported(t.userId)) {
    e.addFields({
      name: 'No Kalshi key — paper works anyway',
      value: 'You do **not** need a key. It is already scanning and the P&L above is real ' +
        'bookkeeping on real prices. A key buys one thing: **real money**.',
      inline: false
    });
  } else {
    // Stored, and it says so. "Did my key save?" was previously answered by guessing from
    // whether a balance appeared, which is how a saved key reading a near-empty account looked
    // like a key that had not saved at all.
    const st2 = auth.status(t.userId) || {};
    const exact = bal.exact != null ? Number(bal.exact) : null;
    const dust = exact != null && exact > 0 && exact < 0.01;
    e.addFields({
      name: '🔑 Kalshi key saved',
      value: table([
        ['Key ID', String(st2.keyId || auth.maskedKeyId(t.userId) || '—')],
        ['Imported', st2.importedAt ? new Date(st2.importedAt).toLocaleString() : '—'],
        ['Linked to', t.rec.tag ? `${t.rec.tag}  (${t.userId})` : t.userId],
        ['Balance', bal.dollars == null ? `— ${bal.why || 'not read yet'}`
          : dust ? `${money(exact)}  — under a cent, so this account is effectively empty`
            : money(bal.dollars)]
      ]) + (bal.dollars != null && exact != null && exact < 1
        ? '_Kalshi reports this key\'s balance, so a figure you do not recognise means the key ' +
          'belongs to a different account than the one you funded — or the deposit has not ' +
          'settled. Nothing here can spend money that is not in the account it can see._'
        : ''),
      inline: false
    });
  }
  e.setFooter({ text: (t.rec.tag || t.userId) + (t.isOwner ? '  ·  owner' : '') });
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
