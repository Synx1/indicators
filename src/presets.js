/**
 * The three risk presets, and the measurement each one is allowed to claim.
 *
 * ── why presets and not just knobs ──
 *
 * Every dial the favourite gate has was already reachable one at a time: which coins are on, how much of
 * the clock window counts, how many positions may be open. Set independently they produce combinations
 * nobody measured — 85-90c at T-3 with six positions open is a configuration this project has no number
 * for, and the panel would have rendered it as confidently as one it does. A preset is a NAMED point in
 * that space with a measured row attached, so the help text quotes the corpus instead of an adjective.
 *
 * ── what actually differs between the tiers, honestly ──
 *
 * Measured on research/arb/paths.jsonl — 13,269 settled markets, 2026-06-26 to 2026-09-01, per-minute
 * two-sided books, entries at the ask, Kalshi's fee charged the way the exchange charges it:
 *
 *   preset    coins  clock        n      win%    edge      ROI      H1/H2 edge
 *   passive   5      T-12..T-7    3,844  90.1%   +2.20pp   +2.50%   +2.09 / +2.32
 *   neutral   6      T-12..T-7    4,645  89.9%   +2.00pp   +2.27%   +1.80 / +2.20
 *   aggro     7      T-12..T-6    6,362  89.5%   +1.55pp   +1.76%   +1.48 / +1.63
 *
 * Of the 0.65pp between passive and aggro, roughly 0.3 is the CLOCK and 0.35 is the two coins. Only the
 * clock is outside the noise: T-6 loses in both chronological halves (-0.80pp then -0.04pp on n=899)
 * while T-9 makes +3.86pp and T-11 +2.45pp with near-identical halves. The coin ranking does NOT persist
 * — BTC is the best coin in the first half and mid-pack in the second, DOGE is the worst then the second
 * best, and at ~450 trades per coin per half the standard error is ~1.4pp. So the coin lists here are a
 * FREQUENCY dial, not a coin-picking edge, and they are ordered by measured edge only because something
 * had to break the tie. XRP is the one defensible exclusion: weakest overall at +0.46pp and the only coin
 * whose second half went negative.
 *
 * ── the tiers are not a cage ──
 *
 * Toggling a coin or moving the clock by hand flips the preset to 'custom' and KEEPS the edited value.
 * A preset is a starting point that can name itself; it is not a lock, and it must never silently
 * overwrite a deliberate change.
 */

/** Every coin, in the order src/markets.js declares them. */
const ALL = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];

/**
 * The bundles.
 *
 * `maxOpen` is a fleet-wide CEILING, not an assignment: a user who set 2 keeps 2 under aggro. Capping
 * rather than setting is the only way a fleet policy can tighten risk without also being able to force
 * somebody to carry more positions than they chose.
 */
const PRESETS = {
  passive: {
    label: 'Passive',
    coins: ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE'],
    minLeft: 7, maxLeft: 12, maxOpen: 1,
    blurb: 'The five coins with the highest measured edge, the clock minute that loses money removed, '
      + 'one position at a time.',
    measured: { n: 3844, win: 90.1, edge: 2.20, roi: 2.50, h1: 2.09, h2: 2.32 }
  },
  neutral: {
    label: 'Neutral',
    coins: ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'HYPE'],
    minLeft: 7, maxLeft: 12, maxOpen: 3,
    blurb: 'Same clock, six coins, up to three positions — 21% more trades than Passive for 0.2pp less '
      + 'edge.',
    measured: { n: 4645, win: 89.9, edge: 2.00, roi: 2.27, h1: 1.80, h2: 2.20 }
  },
  aggro: {
    label: 'Aggro',
    coins: ALL.slice(),
    minLeft: 6, maxLeft: 12, maxOpen: 6,
    blurb: 'Every coin, the full 6-12 minute window, up to six positions. The most trades and the most '
      + 'total profit; the least edge per trade.',
    measured: { n: 6362, win: 89.5, edge: 1.55, roi: 1.76, h1: 1.48, h2: 1.63 }
  }
};

/** The corpus every `measured` row above came from, quoted wherever one is shown. */
const CORPUS = { markets: 13269, from: '2026-06-26', to: '2026-09-01', size: 100 };

const NAMES = Object.keys(PRESETS);
const CUSTOM = 'custom';

/** The default. Neutral rather than aggro: it beat aggro in BOTH halves, and it is the safer direction. */
const DEFAULT = 'neutral';

const isName = n => NAMES.includes(String(n || '').toLowerCase());
const get = n => PRESETS[String(n || '').toLowerCase()] || null;

/**
 * Which preset, if any, a concrete configuration IS.
 *
 * Used after a manual edit to decide whether the label still applies: editing a coin off and back on
 * should not leave the fleet stuck on 'custom' when the state is once again exactly Neutral.
 */
function match({ coins, minLeft, maxLeft, maxOpen }) {
  const key = xs => xs.slice().sort().join(',');
  for (const name of NAMES) {
    const p = PRESETS[name];
    if (key(p.coins) !== key(coins || [])) continue;
    if (Number(minLeft) !== p.minLeft || Number(maxLeft) !== p.maxLeft) continue;
    if (maxOpen != null && Number(maxOpen) !== p.maxOpen) continue;
    return name;
  }
  return CUSTOM;
}

/** One line for a panel row or a log: "Neutral — 89.9% win, +2.00pp edge over 4,645 measured trades". */
function summary(name) {
  const p = get(name);
  if (!p) return 'Custom — hand-tuned, no measured row';
  const m = p.measured;
  return `${p.label} — ${m.win}% win, ${m.edge >= 0 ? '+' : ''}${m.edge.toFixed(2)}pp edge `
    + `over ${m.n.toLocaleString('en-US')} measured trades`;
}

/**
 * The next preset in the cycle, for a single control that advances through the three.
 *
 * One button rather than three because the admin panel is already at Discord's five-row ceiling and the
 * row that would be dropped to make space is the key-generation one. From 'custom' it goes to the
 * default rather than to the top of the cycle: somebody on a hand-tuned config who presses this is asking
 * for a known configuration back, and the default is the one with the best-behaved halves.
 */
function next(name) {
  const i = NAMES.indexOf(String(name || '').toLowerCase());
  return i < 0 ? DEFAULT : NAMES[(i + 1) % NAMES.length];
}

module.exports = { PRESETS, NAMES, ALL, CUSTOM, DEFAULT, CORPUS, isName, get, match, summary, next };
