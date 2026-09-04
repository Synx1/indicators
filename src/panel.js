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

const { OWNER_ID, INSTANCE, KEY_DIR_SOURCE, KEY_DIR_PERSISTENT, STRATEGY } = require('./config');
const settings = require('./settings');
const users = require('./users');
const book = require('./book');
const gl = require('./markets');
const presets = require('./presets');
const auth = require('./kalshiauth');
const kt = require('./kalshitrade');
const advice = require('./advice');
const licences = require('./licences');

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

/**
 * ── how this embed is laid out, and why ──
 *
 * Discord renders up to THREE inline fields across one row, and stacks every non-inline field at full
 * width. This panel used to set inline:false on everything, so a dozen short numbers each claimed a
 * whole row and the result read as one ragged column you had to scan top-to-bottom to find a figure.
 * Long warning sentences were also wedged inside monospace code-block tables, where they wrap at the
 * block width and destroy the column alignment that was the only reason to use a table.
 *
 * Three shapes now, each with one job:
 *   cell()    - a SHORT number in the three-across grid, with an optional short second line.
 *   divider() - a bold section label on its own row, so sections read as sections.
 *   table()   - genuinely tabular rows only (open positions, key details), cells kept short.
 * Anything that is a sentence goes in prose() at full width, never in a cell or a table row.
 */
const ZWSP = '\u200b';
const cell = (name, value, sub) => ({
  name, value: sub ? `${value}\n\`${sub}\`` : String(value), inline: true
});
const divider = label => ({ name: ZWSP, value: `**${label}**`, inline: false });
const prose = text => ({ name: ZWSP, value: text, inline: false });
/** Pad a short row so its columns still line up with the rows above. */
const padGrid = cells => {
  const out = cells.filter(Boolean);
  while (out.length % 3 !== 0) out.push({ name: ZWSP, value: ZWSP, inline: true });
  return out;
};

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

/**
 * Can this account actually afford the size it is configured for?
 *
 * Judged at the bot's 80¢ CEILING rather than its 25¢ floor. Sizing against the floor is how a
 * balance that covers exactly one cheap entry gets reported as sufficient, and then every real
 * signal — most of which price 60-80¢ — is refused for insufficient funds.
 *
 * Returns null when there is nothing to say: no key, no balance read, or the size fits.
 */
// Kept in step with src/trader.js MIN_PRICE, which is the source of truth. Raised 0.25 -> 0.35 on
// 2026-08-31: a 25c contract the model calls 85% is a 60-point disagreement with the market, and
// the corpus says that is where the model is wrong rather than where the edge is.
//
// These MUST track the active gate. Left at the model's 0.35-0.65 they silently mis-serve every other
// strategy: auto size divides the risk budget by BAND_HI, so under STRATEGY=calibration a 0.65 ceiling
// sizes each trade ~48% larger than the risk dial asks for, and the affordability check then clears an
// order the account cannot actually fund at 95c. Favourite buys 85-90c; calibration buys 75-95c and may
// pay one cent of grace on top, so its true ceiling is 0.96.
//
// Affordability bounds only — src/favourite.js, src/calibration.js and src/trader.js remain the
// strategy sources of truth.
const CAL_ACTIVE = STRATEGY === 'calibration' || STRATEGY === 'calibration+model';
const BAND_LO = STRATEGY === 'favourite' ? 0.85 : (CAL_ACTIVE ? 0.75 : 0.35);
// Kept in step with src/trader.js MAX_PRICE, which is the source of truth for the model entry band.
const BAND_HI = STRATEGY === 'model' ? 0.65 : (CAL_ACTIVE ? 0.96 : 0.90);
/**
 * The exchange shard the 15-minute crypto markets live on.
 *
 * Kalshi splits matching across shards and holds cash per shard: 0 is the fallback, 1 exotics,
 * 2 crypto, 3 tennis/baseball. Every market this bot trades is crypto, so this is the only shard
 * whose cash can back one of its orders — a balance parked on shard 0 is unspendable here.
 */
const CRYPTO_SHARD = 2;
/**
 * Above this share of the balance in ONE position, say something even though it fits.
 *
 * 50% because a binary loses the entire stake: two consecutive losses at half the account is the
 * account. The paper book has already produced a single -$19.69 trade, so this is not hypothetical.
 */
const CONCENTRATION = 0.5;
/**
 * The share count that will ACTUALLY be used.
 *
 * t.get('shares') is the fixed setting, and with auto size on it is inert. Reading it here told
 * somebody arming their account that one trade was 96% of their balance when the sizer had already
 * resolved to 7 contracts — 22%. The panel's own Size row said "30 ignored, auto size decides (7
 * right now)" two screens earlier, so the confirmation contradicted the settings page it came from.
 *
 * Required lazily: the trader pulls in the whole market stack and the panel must render without it.
 */
function resolvedShares(t) {
  try { return require('./trader').sharesFor(t, { price: BAND_HI, pricePct: BAND_HI * 100 }); }
  catch (_) { return Math.floor(Number(t.get('shares')) || 0); }
}

function affordability(t, bal) {
  const shares = resolvedShares(t) || 0;
  const dollars = bal && bal.dollars != null ? Number(bal.dollars) : null;
  if (!shares || dollars == null || !(dollars > 0)) return null;
  const worst = +(shares * BAND_HI).toFixed(2);
  const cheapest = +(shares * BAND_LO).toFixed(2);
  // Whole contracts only — a fraction of a contract is not a thing Kalshi sells.
  const fits = Math.floor(dollars / BAND_HI);
  if (dollars >= worst) {
    // It fits. But "fits" and "sensible" are different questions, and a size that fits by 90c
    // while committing 96% of the balance is the one this used to stay silent about.
    const share = worst / dollars;
    if (share <= CONCENTRATION) return null;
    const safer = Math.max(1, Math.floor((dollars * CONCENTRATION) / BAND_HI));
    return { kind: 'concentrated', shares, dollars, worst, cheapest, fits, safer,
      sharePct: Math.round(share * 100) };
  }
  return { kind: 'unaffordable', shares, dollars, worst, cheapest, fits,
    anyFit: dollars >= cheapest, safer: Math.max(1, fits) };
}

/**
 * How much access is left, in the words that matter at each stage.
 *
 * Null for the owner — an owner row reading "unlimited" is noise on every render. Under three days
 * it says the date as well as the count, because "2 days" on its own is the kind of thing somebody
 * reads on Friday and forgets by Sunday.
 */
function accessRow(t) {
  const left = t.accessLeftMs();
  if (!Number.isFinite(left)) return null;           // the owner
  if (left <= 0) return null;                        // the status line already leads with this
  const days = left / 86400000;
  const until = new Date(t.rec.accessUntil).toLocaleString();
  if (days <= 3) {
    return ['Access', `${days < 1 ? `${Math.ceil(left / 3600000)} hour(s)` : `${Math.ceil(days)} day(s)`} left` +
      `   ⚠️ ends ${until} — a new key extends it`];
  }
  return ['Access', `${Math.floor(days)} day(s) left   until ${until}`];
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
    return {
      dollars: rec.balance, exact: rec.balanceExact, cached: true,
      shards: rec.balanceShards || null
    };
  }
  if (!auth.isImported(t.userId)) return { dollars: null, cached: false, why: 'no key imported' };
  try {
    const client = kt.forUser(auth.forUser(t.userId));
    const b = await client.balance();
    if (b && b.ok && b.dollars != null) {
      // users.noteBalance is the only writer of these fields, so the trader's copy of the balance
      // and this one cannot drift — including the per-shard split, which is what an order's
      // collateral is actually checked against.
      users.noteBalance(t, b);
      return {
        dollars: b.dollars, exact: rec.balanceExact, cached: false,
        breakdown: b.breakdown, shards: rec.balanceShards || null
      };
    }
    return { dollars: rec.balance, cached: true, why: (b && b.why) || 'Kalshi did not answer' };
  } catch (e) {
    return { dollars: rec.balance, cached: true, why: e.message };
  }
}

function statusLine(t) {
  const live = t.get('live');
  // Before anything about live or paper: an account nobody has enabled is not trading either way,
  // and a panel that shows "Paper — every decision is recorded" to somebody whose decisions are
  // being discarded is simply wrong.
  if (!t.hasAccess()) {
    if (t.rec.blocked === true) {
      return { badge: '⛔', title: 'Blocked', colour: 0xf87171,
        text: 'the owner has switched this account off. Nothing trades, and a key will not change ' +
          'that until the block is lifted.' };
    }
    const had = Boolean(t.rec.accessUntil);
    return { badge: '🔑', title: had ? 'Access expired' : 'Key required', colour: 0xfbbf24,
      text: had
        ? `access ran out ${new Date(t.rec.accessUntil).toLocaleString()}. Nothing trades until a ` +
          'new key is entered — **Enter key** below.'
        : 'this bot runs on access keys. Press **Enter key** and paste the one you were given — ' +
          'until then nothing is acted on, not even paper.' };
  }
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
  // ── the title names what happens to the NEXT signal, not what the user selected ──
  //
  // This used to read "Live, not trading". The leading word was "Live", so the panel appeared to confirm
  // that pressing Go live had worked, and then paper fills arrived — reported in exactly those words:
  // "when I click LIVE and I don't arm it it's also PAPER, very confusing". The state was correct and the
  // label was lying about it. Real money needs BOTH the mode and the arm, and until both are set the
  // honest description of this account is Paper, whatever was selected.
  //
  // Still amber rather than the plain paper blue, because this is not the same as paper by choice — there
  // is one press left to make it real, and the colour is what says so.
  const why = block === 'not armed'
    ? 'real money is selected but **not armed**, so the next signal still fills as paper.'
    : `${block} — so signals are **still filling as paper**.`;
  return {
    badge: '📝', title: 'Paper — not armed', colour: 0xfbbf24,
    text: `${why} Press **Arm** to trade for real.`
  };
}

async function mainPayload(t) {
  const bal = await balanceFor(t);
  const st = statusLine(t);
  // Resolved ONCE per render and passed down, so two blocks in one render cannot disagree — and
  // cross-checked against the disk, because a cache that wrongly says "no key" is a claim the user
  // has no way to argue with.
  const keyed = auth.isImported(t.userId);
  const keyFile = auth.hasKeyFile(t.userId);
  const live = t.get('live');
  const armed = t.get('armed') === true;
  const b = t.rec.book;
  const open = book.openPositions(b);
  // ── the two books, computed side by side and never pooled ──
  //
  // Today used to come from the WHOLE book while All time came from the live half, so a panel
  // could show `Today +$82.98 / 10 closed` above `All time +$0.00 / 0 closed` and read as a
  // contradiction. They were two different measurements wearing one label. Both are computed here,
  // each internally consistent, and the active one drives the headline.
  const paperBaseline = t.get('paperResetAt');
  const liveSt = book.stats(b, { liveOnly: true });
  const paperSt = book.stats(b, {
    liveOnly: false,
    sinceMs: paperBaseline == null ? null : Number(paperBaseline)
  });
  const liveEq = book.equity(b, { start: Number(t.get('liveBankroll')) || 0, liveOnly: true });
  const paperEq = book.equity(b, {
    start: Number(t.get('paperBankroll')) || 0,
    liveOnly: false,
    sinceMs: paperBaseline == null ? null : Number(paperBaseline)
  });
  const all = live ? liveSt : paperSt;

  // ── the bankroll is a LIVE figure, not the setting ──
  //
  // It showed the number somebody typed while the account had actually made or lost money against
  // it: $100.00 on screen with $93.93 in the book. That is not a rounding disagreement, it is the
  // screen describing a different quantity from the one that matters.
  //
  // Live is capped by the real Kalshi balance, because you cannot allocate money you do not hold;
  // paper walks its own curve from the configured start.
  // The active mode's curve is the headline. Both were already computed above, so the two cannot
  // be derived from different inputs.
  const eq = live ? liveEq : paperEq;
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
  // When cash is split across shards, the total is not the number that can trade. Said on the
  // Balance block itself, because that is where somebody looks to answer "can it afford a trade".
  const shardCash = live && bal.shards ? Number(bal.shards[String(CRYPTO_SHARD)]) : null;
  const shardShort = shardCash != null && bal.dollars != null &&
    (bal.dollars - shardCash) > 1 && shardCash < BAND_LO;
  // ── the headline: the three numbers somebody opened the panel to find ──
  //
  // Equity, today, all time — for the book this account is actually using. Everything else is detail
  // and lives below a divider. Today sits BESIDE all time rather than replacing it, because a book at
  // +$5 that was once +$60 is a different situation from one that climbed steadily to +$5, and a
  // single total reports them identically.
  // ── which book is ACTUALLY in use, not which one was selected ──
  //
  // `live` is only the mode switch. Real money needs the mode AND the arm — paperAllowed() is
  // !(live && armed) — so an account with live selected but not armed still fills as paper. Keying the
  // headline off `live` alone showed the LIVE book's history above a description reading "Paper — not
  // armed": nineteen closed trades and an 89.5% win rate that had nothing to do with what the next
  // signal will do. This is the same trap the perfField comment below was written about.
  const usingLive = live === true && armed === true;
  const headCurve = usingLive ? liveEq : paperEq;
  const headSt = usingLive ? liveSt : paperSt;
  e.addFields(...padGrid([
    cell('Equity', money(shown),
      eq.atRisk > 0 ? `${money(eq.free)} free` : `from ${money(eq.start)}`),
    cell('Today', headCurve.todayN ? signed(headCurve.todayNet) : '—',
      headCurve.todayN ? `${headCurve.todayN} closed` : 'none closed'),
    cell('All time', headSt.n ? signed(headSt.net) : '—',
      headSt.n ? `${headSt.wins}W/${headSt.losses}L · ${pct(headSt.hit)}` : 'no history')
  ]));
  if (eq.atRisk > 0 || headSt.n) {
    e.addFields(...padGrid([
      eq.atRisk > 0 && cell('At risk', money(eq.atRisk), `${open.length} open`),
      headSt.n && cell('Day high', money(headCurve.todayPeak),
        headCurve.todayPeak - headCurve.equity > 0.005
          ? `${signed(-(headCurve.todayPeak - headCurve.equity))} off` : 'at the high'),
      headSt.n && cell('Peak', money(headCurve.peak),
        headCurve.fromPeak > 0.005 ? `${signed(-headCurve.fromPeak)} off` : 'new high')
    ]));
  }
  // Sentences, at full width, only when there is something to say.
  const headNotes = [
    capped && `Equity is capped by your ${money(ceiling)} exchange balance.`,
    shardShort && `⚠️ Only **${money(shardCash)}** is usable here — crypto trades on shard ` +
      `${CRYPTO_SHARD} and the rest of your balance sits on another shard, where it cannot back an order.`,
    (() => { const r = accessRow(t); return r ? `${r[0]}: ${r[1]}` : null; })()
  ].filter(Boolean);
  if (headNotes.length) e.addFields(prose(headNotes.join('\n')));

  // ── performance: live and paper, side by side, never pooled ──
  //
  // `net` says where a book ended. Only walking the curve gives the best it ever had and how far
  // back it has come — a book at +$5 having been +$60 is a different situation from one that
  // climbed steadily to +$5, and the totals report them identically. The day's high therefore sits
  // beside the day's P&L rather than instead of it.
  //
  // Two blocks because there are two books. Today used to be read off the WHOLE book while All
  // time was read off the live half, so one panel showed `Today +$82.98 / 10 closed` directly
  // above `All time +$0.00 / 0 closed`. Neither number was wrong; the label was.
  // ── the two books, never pooled, but only one of them expanded ──
  //
  // There are two books and they must never be added together, but they do not deserve equal space:
  // the one this account is USING is what the reader came for, and the other only needs to exist so
  // nobody wonders where it went. So the active book gets the grid and the idle one gets a single
  // line. Both are labelled explicitly, because Today was once read off the whole book while All time
  // came off the live half, and one panel showed `Today +$82.98 / 10 closed` directly above
  // `All time +$0.00 / 0 closed` — neither number wrong, the labels lying.
  const bookLine = (label, st, curve) => st.n
    ? `**${label}** ${signed(st.net)} · ${st.n} closed · ${st.wins}W/${st.losses}L · ${pct(st.hit)}`
    : `**${label}** nothing closed yet — starts at ${money(curve.start)}`;

  const idle = usingLive
    ? bookLine('Paper', paperSt, paperEq)
    : bookLine('Live · real money', liveSt, liveEq);

  if (headSt.n) {
    e.addFields(divider(usingLive ? 'Live · real money' : 'Paper'));
    e.addFields(...padGrid([
      cell('Closed', String(headSt.n), `${headSt.wins}W/${headSt.losses}L`),
      cell('Win rate', pct(headSt.hit),
        // The one figure here with a denominator that cannot be exceeded, so the only one a bar can
        // honestly draw. Below three trades it would be drawing noise.
        headSt.n >= 3 && headSt.hit != null ? bar(headSt.hit, 8) : undefined),
      cell('Fees paid', money(headSt.fees),
        headCurve.maxDrawdown > 0.005 ? `worst drop ${signed(-headCurve.maxDrawdown)}` : undefined)
    ]));
  }
  // The idle book, one line. Present so nobody hunts for it, quiet so it does not compete.
  e.addFields(prose(idle));

  // ── open: the money actually at stake, and nothing else ──
  //
  // While ARMED this lists live positions only. It used to list the whole book, so a screenshot
  // showed `Open · 2 · $0.00 at risk` above two paper positions — the count came from the book and
  // the risk from the live half, and the reader is left to work out that the two rows are
  // imaginary. Paper positions opened before arming are still managed and settled; they are
  // reported as a footnote and counted in the paper book, not shown as exposure here.
  const liveView = live && armed;
  const shownOpen = liveView ? open.filter(p => p.live) : open;
  const paperOpenN = liveView ? open.length - shownOpen.length : 0;
  const settling = paperOpenN
    ? `\n_${paperOpenN} paper position${paperOpenN === 1 ? '' : 's'} from before you armed ` +
      'is still settling — it counts towards the paper book above, not towards this. See Trades._'
    : '';
  e.addFields(divider('Open positions'));
  e.addFields({
    name: shownOpen.length
      ? `Open  ·  ${shownOpen.length}  ·  ${money(eq.atRisk)} at risk`
      : 'Open  ·  0',
    value: (shownOpen.length
      ? table(shownOpen.slice(0, 6).map(p => [
        `${p.sym} ${p.direction === 'UP' ? '▲' : '▼'}`,
        `${p.contracts}× @${p.priceCents}¢   ${money(p.cost)}   closes ${String(p.closeTime).slice(11, 16)}`
      ])) + (shownOpen.length > 6 ? `…and ${shownOpen.length - 6} more` : '')
      : '_nothing open — it enters when a market clears every gate_') + settling,
    inline: false
  });

  e.addFields(divider(`Setup · ${STRATEGY}`));
  e.addFields({
    name: ZWSP,
    value: table([
      ['Shares/trade', (() => {
        if (!t.get('autoShares')) return t.fmt('shares');
        // Auto size is arithmetic on a balance, so it has to show the ANSWER. A row reading
        // "auto" tells somebody nothing about how big their next trade is.
        const n = resolvedShares(t);
        return `${n == null ? '—' : n} contracts   auto · ${t.fmt('riskPerTrade')} risk`;
      })()],
      ['Exit', t.fmt('cashoutAt')],
      ['Daily stop', t.fmt('dailyStopLoss') +
        (t.get('dailyStopLoss') != null ? `   today ${signed(t.day().realised)}` : '')],
      ['Markets', `${gl.enabledSyms().length}/${gl.SYMS.length} on` +
        (gl.enabledSyms().length === gl.SYMS.length ? '' : `   off: ${gl.SYMS.filter(x => !gl.isEnabled(x)).join(' ')}`)],
      scannerLine()
    ]),
    inline: false
  });

  const aff = live ? affordability(t, bal) : null;
  if (aff && aff.kind === 'concentrated') {
    e.addFields({
      name: `⚠️  One trade is ${aff.sharePct}% of your account`,
      value: table([
        ['Balance', money(aff.dollars)],
        ['Your size', `${aff.shares} contracts`],
        ['Costs', `${money(aff.cheapest)} at 25¢  …  ${money(aff.worst)} at 80¢`]
      ]) +
      `_A binary loses the **whole** stake, so two losses in a row at this size is the account. ` +
      `**${aff.safer} contracts** keeps one trade under half. Auto size does this arithmetic for ` +
      `you._`,
      inline: false
    });
  } else if (aff) {
    e.addFields({
      name: aff.anyFit ? '⚠️  Your size only fits the cheapest entries' : '⚠️  Your size is unaffordable',
      value: table([
        ['Balance', money(aff.dollars)],
        ['Your size', `${aff.shares} contracts`],
        ['Needs', `${money(aff.cheapest)} at 25¢  …  ${money(aff.worst)} at 80¢`],
        ['Fits', aff.fits >= 1 ? `${aff.fits} contracts across the whole band` : 'nothing at 80¢']
      ]) +
      (aff.anyFit
        ? `_Most signals price 60–80¢, so orders above ${money(aff.dollars)} will be refused for ` +
          `insufficient funds. Set **Shares per trade** to **${Math.max(1, aff.fits)}** to trade ` +
          `the whole band, or fund the account._`
        : `_No order can fill at this size. Set **Shares per trade** to **${Math.max(1, aff.fits)}** ` +
          `or fund the account._`),
      inline: false
    });
  }
  if (gl.isKilled()) {
    e.addFields({ name: '🚨 Kill switch is ON',
      value: 'Nothing opens for anybody. Anything held is still managed and settled.', inline: false });
  }
  if (keyFile && !keyed) {
    // The file is there and could not be read. Almost always a changed KALSHI_KEY_SECRET, which is
    // recoverable with the old value and unrecoverable without it — so it must not be reported as
    // "no key imported", which would send somebody to re-import when the problem is the secret.
    e.addFields({
      name: '⚠️  Key file is present but could not be read',
      value: `A credential exists for ${t.userId} on disk, and decrypting it failed. That is ` +
        'almost always **KALSHI_KEY_SECRET changing**: the value that encrypted the file is the ' +
        'only value that can read it.\n\nIf you know the old secret, set it back. Otherwise ' +
        '**Import key** again — the old file is replaced, nothing else is lost.',
      inline: false
    });
  } else if (!keyed) {
    e.addFields({
      name: t.hasAccess() ? 'No Kalshi key — paper works anyway' : 'No Kalshi key — nothing to do yet',
      // The copy has to follow the gate. Telling somebody "it is already scanning and the P&L above
      // is real bookkeeping" while their account is switched off is simply untrue, and it is the
      // kind of untrue that reads as the bot being broken later.
      value: (t.hasAccess()
        ? 'You do **not** need a key. It is already scanning and the P&L above is real ' +
          'bookkeeping on real prices. A key buys one thing: **real money**.'
        : 'Nothing is being recorded yet — this account has no access key on the clock. You can ' +
          'import a Kalshi key now to be ready, but it changes nothing until access starts.') +
        // Said BEFORE the import rather than after it disappears. An import onto a disk the
        // platform rebuilds looks identical to a successful one until the next release.
        (KEY_DIR_PERSISTENT ? '' :
          '\n\n⚠️ **Importing one will not stick right now** — the key store is on a disk this ' +
          `deploy rebuilds (\`${KEY_DIR_SOURCE}\`). Attach a volume first, or the key vanishes at ` +
          'the next release.'),
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
        // Only shown when it is a WARNING. A row reporting that persistence is working is noise on
        // every render, and the reason it existed was the deploy that lost a key.
        !KEY_DIR_PERSISTENT && ['Stored', `${KEY_DIR_SOURCE}  — REBUILT EVERY DEPLOY`],
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
  // The instance that answered, because two of them once shared a token and every symptom read as
  // the panel contradicting itself. If two footers ever differ, that is the whole diagnosis.
  // A timestamp because "is this stale?" is the second question after "is it on?", and an embed with
  // no clock looks equally fresh an hour later. Discord renders setTimestamp in the reader's own zone.
  e.setFooter({ text: (t.rec.tag || t.userId) + (t.isOwner ? '  ·  owner' : '') + `  ·  ${INSTANCE}` });
  e.setTimestamp(new Date());
  return { embeds: [e], components: mainComponents(t), flags: MessageFlags.Ephemeral };
}

function mainComponents(t) {
  const live = t.get('live'), armed = t.get('armed');
  const keyed = auth.isImported(t.userId);
  const approved = t.hasAccess();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID}:arm`)
      .setLabel(armed ? 'Disarm' : 'Arm')
      .setStyle(armed ? ButtonStyle.Danger : ButtonStyle.Success)
      // Arming with no key would fail at the order, not at the button. Refusing here says why.
      // An unapproved account cannot arm at all: the trader would refuse every entry anyway, and a
      // button that appears to work while changing nothing is worse than one that is plainly off.
      .setDisabled((!keyed && !armed) || !approved),
    // ── "Go live" promised something it could not deliver ──
    //
    // This button only SELECTS which money the account will use; the Arm button is what starts using it.
    // Labelled "Go live" it read as the whole action, so pressing it and then getting paper fills looked
    // like a bug rather than a missing second step. "Use real money" describes choosing a mode, which
    // leaves Arm as the obvious trigger.
    new ButtonBuilder().setCustomId(`${ID}:live`)
      .setLabel(live ? 'Back to paper' : 'Use real money')
      .setStyle(live ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(!approved),
    new ButtonBuilder().setCustomId(`${ID}:refresh`).setLabel('Refresh').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID}:settings`).setLabel('Settings').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ID}:trades`).setLabel('Trades').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ID}:access`)
      .setLabel(approved ? 'Extend access' : 'Enter key')
      .setStyle(approved ? ButtonStyle.Secondary : ButtonStyle.Success),
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
      value: keys.map(k => {
        // With auto size on, the fixed share count is inert. Printing it next to "Auto size — on"
        // read as a contradiction, and reasonably so: two numbers, no clue which one is in force.
        if (k === 'shares' && t.get('autoShares')) {
          let n = null;
          try { n = require('./trader').sharesFor(t, { price: 0.80, pricePct: 80 }); } catch (_) {}
          return `**${settings.SCHEMA[k].label}** — ~~${t.fmt(k)}~~ ignored, auto size decides` +
            (n == null ? '' : ` (**${n}** right now)`);
        }
        return `**${settings.SCHEMA[k].label}** — ${t.fmt(k)}`;
      }).join('\n'),
      inline: false
    });
  }
  // visibleKeys(), not Object.keys(SCHEMA) — the latter offered `paperResetAt`, an internal
  // millisecond timestamp, as a button somebody could be asked to type into.
  //
  // Four rows of five is Discord's limit; the schema is smaller, but slice anyway so adding a
  // setting can never break the panel with an invalid payload.
  const keys = settings.visibleKeys().slice(0, 20);
  const rows = [];
  for (let i = 0; i < keys.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      ...keys.slice(i, i + 5).map(k => {
        const spec = settings.SCHEMA[k];
        const isBool = spec.type === settings.TYPE.BOOL;
        const on = isBool && t.get(k) === true;
        return new ButtonBuilder()
          .setCustomId(`${ID}:set:${k}`)
          // A toggle carries its own state, so a press that registered is visible on the thing
          // that was pressed rather than in a list above it.
          .setLabel(isBool ? `${spec.label}: ${on ? 'ON' : 'off'}` : spec.label)
          .setStyle(isBool ? (on ? ButtonStyle.Success : ButtonStyle.Secondary)
            : ButtonStyle.Secondary);
      })
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

/**
 * Where a user pastes the access key they were given.
 *
 * Short, one field, and the placeholder shows the shape — the commonest failure with a code like
 * this is not knowing whether the dashes are part of it. normalise() accepts it either way.
 */
function accessModal() {
  return new ModalBuilder()
    .setCustomId(`${ID}:accessmodal`)
    .setTitle('Enter your access key')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('accesskey')
        .setLabel('Access key')
        .setPlaceholder('IND-XXXX-XXXX-XXXX')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(40)
    ));
}

/** The owner's custom-length key. Presets cover 1/7/30; this is for everything else. */
function generateModal() {
  return new ModalBuilder()
    .setCustomId(`${ID}:genmodal`)
    .setTitle('Generate an access key')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('days')
          .setLabel('How many days of access?')
          .setPlaceholder('e.g. 14')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(4)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Note to yourself (who is it for?)')
          .setPlaceholder('optional — shown only to you')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100)
      )
    );
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
  // One snapshot per account, in the shape src/advice.js takes. Built here because this file is
  // the one that knows where a book and a key live; advice.js stays pure arithmetic over it.
  const snaps = all.map(t => {
    const b = t.rec.book;
    const opens = book.openPositions(b);
    const liveSt = book.stats(b, { liveOnly: true });
    const paperSt = book.stats(b, { liveOnly: false });
    const liveEq = book.equity(b, { start: Number(t.get('liveBankroll')) || 0, liveOnly: true });
    return {
      t,
      who: (t.rec.tag || t.userId).slice(0, 16),
      userId: t.userId,
      live: t.get('live') === true,
      armed: t.get('armed') === true,
      keyed: auth.isImported(t.userId),
      keyFile: auth.hasKeyFile(t.userId),
      balance: t.rec.balance == null ? null : Number(t.rec.balance),
      shares: resolvedShares(t) || 0,
      dailyStop: t.get('dailyStopLoss'),
      todayRealised: t.day().realised,
      approved: t.hasAccess(),
      pending: !t.hasAccess(),
      accessUntil: t.rec.accessUntil || null,
      blocked: t.rec.blocked === true,
      accessLeftMs: t.accessLeftMs(),
      lastReject: t.rec.lastReject || null,
      balanceShards: t.rec.balanceShards || null,
      // Crypto is shard 2 in Kalshi's own sharding doc, and every market this bot trades is crypto.
      cryptoShard: CRYPTO_SHARD,
      paperOpen: opens.filter(p => !p.live).length,
      liveOpen: opens.filter(p => p.live).length,
      atRiskLive: book.atRisk(b, { liveOnly: true }),
      liveNet: liveSt.net, paperNet: paperSt.net,
      liveN: liveSt.n, paperN: paperSt.n,
      liveToday: liveEq.todayNet,
      state: !t.hasAccess() ? 'OFF' :
        gl.isKilled() ? 'halted' : !t.get('live') ? 'paper' : t.get('armed') ? 'ARMED' : 'live'
    };
  });

  // Aggregated across every account, because one person's twelve trades on SOL is not evidence
  // about SOL. Live and paper pooled deliberately here: the question is whether the SIGNAL on that
  // market makes money, and both books answer it.
  const markets = {};
  for (const s2 of snaps) {
    for (const m of book.byMarket(s2.t.rec.book)) {
      const g = markets[m.sym] || (markets[m.sym] = { sym: m.sym, n: 0, net: 0 });
      g.n += m.n;
      g.net = +(g.net + m.net).toFixed(2);
    }
  }
  const findings = advice.review(snaps, { markets: Object.values(markets) });

  const rows = snaps.slice().sort((a, b) => (b.liveNet + b.paperNet) - (a.liveNet + a.paperNet));
  const fleetLive = +rows.reduce((a, r) => a + r.liveNet, 0).toFixed(2);
  const fleetPaper = +rows.reduce((a, r) => a + r.paperNet, 0).toFixed(2);
  const fleetRisk = +rows.reduce((a, r) => a + r.atRiskLive, 0).toFixed(2);
  const armedN = rows.filter(r => r.state === 'ARMED').length;

  const e = new EmbedBuilder()
    .setColor(gl.isKilled() ? 0xf87171 : armedN ? 0x4ade80 : 0x71717a)
    .setAuthor({ name: `${NAME} ${VERSION} · owner` })
    .setTitle(gl.isKilled() ? 'Halted — kill switch on' : `${all.length} account(s), ${armedN} armed`);

  // ── access, above the money ──
  //
  // Who is on the clock, who has run out, and which keys are still in your pocket. First because a
  // person who cannot use the bot is the most time-sensitive thing on this screen, and because an
  // unused key sitting in the store is money not yet collected.
  const spare = licences.unused();
  const withAccess = snaps.filter(x => x.accessLeftMs > 0 && !x.blocked);
  const without = snaps.filter(x => x.accessLeftMs <= 0 || x.blocked);
  const accessRows = [
    ...withAccess.map(x => [x.who,
      // The owner has no clock, and rendering Infinity days "until 12/31/1969" is how a screen
      // teaches somebody to distrust every other number on it.
      !Number.isFinite(x.accessLeftMs) ? 'owner — no key needed'
        : `${Math.floor(x.accessLeftMs / 86400000)}d left   until ` +
          `${new Date(x.accessUntil).toLocaleDateString()}`]),
    ...without.map(x => [x.who,
      x.blocked ? 'BLOCKED by you'
        : x.accessUntil ? `expired ${new Date(x.accessUntil).toLocaleDateString()}`
          : 'never entered a key'])
  ];
  e.addFields({
    name: `🔑 Access  ·  ${withAccess.length} active  ·  ${spare.length} key(s) unused`,
    value: table(accessRows.length ? accessRows : [['—', 'no accounts yet']]) +
      (spare.length
        ? '**Unused keys**\n' + spare.slice(0, 6).map(k =>
          `\`${k.key}\`  ${k.days}d${k.note ? ` · ${k.note}` : ''}`).join('\n') +
          (spare.length > 6 ? `\n_…and ${spare.length - 6} more_` : '')
        : '_No unused keys. Generate one below._'),
    inline: false
  });

  // ── what to look at, before what happened ──
  //
  // Findings first on purpose. Every one of these was previously found by a person reading the
  // numbers below and doing the arithmetic in their head, hours late — a size that was 96% of an
  // account, a stop larger than the balance it protected, a key that had stopped decrypting.
  if (findings.length) {
    const mark = { high: '🔴', warn: '🟡', note: '·' };
    e.addFields({
      name: `Worth looking at  ·  ${findings.length}`,
      value: findings.slice(0, 6).map(f =>
        `${mark[f.severity]} **${f.who}** — ${f.text}` + (f.fix ? `\n   ↳ _${f.fix}_` : '')
      ).join('\n') + (findings.length > 6 ? `\n_…and ${findings.length - 6} more_` : ''),
      inline: false
    });
  } else if (all.length) {
    e.addFields({
      name: 'Worth looking at  ·  0',
      value: '_Nothing. Sizes fit their balances, stops can trip, keys decrypt, and no market is ' +
        'losing money over a meaningful sample._',
      inline: false
    });
  }

  e.addFields({
    name: 'Fleet',
    value: table([
      ['Live', `${signed(fleetLive)}   real money`],
      ['Paper', signed(fleetPaper)],
      ['At risk now', `${money(fleetRisk)}   live only`],
      ['Markets on', `${gl.enabledSyms().length}/${gl.SYMS.length}`],
      ['Preset', presets.summary(gl.preset)],
      ['Clock', `T-${gl.activeClock().maxLeft}..T-${gl.activeClock().minLeft} left` +
        `   ceiling ${gl.maxOpenCap()} open`]
    ]),
    inline: false
  });

  // Live and paper in separate columns rather than one pooled figure: pooling them produces a
  // number that describes neither book, and lets a good paper run hide a bad live one.
  e.addFields({
    name: 'Accounts',
    value: rows.length
      ? table(rows.map(r => [
        r.who,
        `${r.state.padEnd(6)} live ${signed(r.liveNet).padStart(8)}/${String(r.liveN).padStart(3)}T` +
        `  paper ${signed(r.paperNet).padStart(9)}/${String(r.paperN).padStart(4)}T` +
        (r.liveOpen ? `  ${r.liveOpen} open` : '')
      ]))
      : '_no accounts yet_',
    inline: false
  });

  e.addFields({
    name: 'Markets',
    value: table(gl.SYMS.map(sym => {
      const g = markets[sym];
      return [sym, `${gl.isEnabled(sym) ? '● on ' : '○ off'}` +
        (g && g.n ? `   ${signed(g.net).padStart(9)} over ${g.n}T` : '')];
    })),
    inline: false
  });

  return { embeds: [e], components: adminComponents(), flags: MessageFlags.Ephemeral };
}

function adminComponents() {
  const rows = [];

  // ── enable / disable accounts, newest first ──
  //
  // Newest first because the person who just appeared is the one waiting to be let in. The owner's
  // own row is omitted — they are approved implicitly and a button to disable yourself is a trap.
  // Discord allows five rows of five and the markets take two of them, so this is capped at one row
  // of five with the count spelled out in the embed when there are more.
  const others = users.all()
    .filter(x => x.userId !== OWNER_ID)
    .sort((a, b) => new Date(b.rec.createdAt || 0) - new Date(a.rec.createdAt || 0))
    .slice(0, 5);
  if (others.length) {
    rows.push(new ActionRowBuilder().addComponents(
      ...others.map(x => {
        const on = x.rec.blocked !== true;
        return new ButtonBuilder()
          .setCustomId(`${ID}:${on ? 'no' : 'ok'}:${x.userId}`)
          .setLabel(`${on ? '⛔ block' : '✅ unblock'} ${(x.rec.tag || x.userId).slice(0, 9)}`)
          .setStyle(on ? ButtonStyle.Secondary : ButtonStyle.Success);
      })
    ));
  }

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
  // Key generation, one press per common length. `genx` opens a box for anything else.
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID}:gen:1`).setLabel('+ 1 day key').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${ID}:gen:7`).setLabel('+ 7 day key').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${ID}:gen:30`).setLabel('+ 30 day key').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${ID}:genx`).setLabel('+ custom…').setStyle(ButtonStyle.Secondary)
  ));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID}:kill`)
      .setLabel(gl.isKilled() ? 'Lift kill switch' : 'KILL SWITCH')
      .setStyle(gl.isKilled() ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${ID}:pre`)
      .setLabel(`Preset: ${gl.preset === presets.CUSTOM ? 'Custom' : presets.get(gl.preset).label}`)
      .setStyle(gl.preset === presets.CUSTOM ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${ID}:admin`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ID}:home`).setLabel('◀ Back').setStyle(ButtonStyle.Primary)
  ));
  // Discord allows five rows. The controls row is the one that must never be dropped — losing the
  // kill switch and Back to a layout overflow would be a silent, dangerous regression as accounts
  // or markets grow — so it is kept and the optional rows are what get trimmed.
  const controls = rows.pop();
  return [...rows.slice(0, 4), controls];
}

module.exports = {
  NAME, VERSION, ID, init, owns, isOwner, affordability, resolvedShares,
  mainPayload, mainComponents, settingsPayload, settingModal, keyModal, tradesPayload,
  accessModal, generateModal,
  adminPayload, adminComponents, table, bar,
  balanceFor, statusLine
};
