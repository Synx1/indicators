/**
 * One place for the values that differ between a laptop and the deployed service.
 *
 * ── secrets are read from the environment, never from this file ──
 *
 * A token committed once is a token leaked forever, so nothing secret is written here. For a
 * local run, `.env.local` is read at boot (gitignored); on Railway these are service variables
 * and that file does not exist. loadEnvFile() is deliberately tiny rather than a dotenv
 * dependency: it does one job, and a secrets loader is a bad place for a supply-chain surprise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Read KEY=value lines from a file into process.env, without overwriting anything already set.
 *
 * The environment WINS on purpose: on the deployed service the real variables are already
 * present, and a stray committed or copied file must never be able to override them.
 */
function loadEnvFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return 0; }
  let n = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const k = s.slice(0, eq).trim();
    // Quotes stripped because a pasted value often arrives wrapped in them, and an RSA key
    // pasted as one line uses \n escapes that have to survive into the value.
    let v = s.slice(eq + 1).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (!k || process.env[k] !== undefined) continue;
    process.env[k] = v;
    n++;
  }
  return n;
}
loadEnvFile(path.join(__dirname, '..', '.env.local'));

/**
 * Where state lives.
 *
 * Railway sets RAILWAY_VOLUME_MOUNT_PATH itself whenever a volume is attached, so reading it
 * means attaching a volume is the whole configuration — no second variable to forget. The
 * lesson is borrowed at full price: the other bot lost its trade history repeatedly because
 * DATA_DIR silently fell through to a directory the platform rebuilds on every deploy, and
 * every write succeeded right up until it did not.
 */
const DATA_DIR = process.env.STATE_DIR
  || process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..'));

const DATA_DIR_SOURCE = process.env.STATE_DIR ? 'STATE_DIR'
  : process.env.DATA_DIR ? 'DATA_DIR'
    : process.env.RAILWAY_VOLUME_MOUNT_PATH ? 'RAILWAY_VOLUME_MOUNT_PATH'
      : fs.existsSync('/data') ? '/data'
        : 'repo-default';

/**
 * Encrypted Kalshi credentials, one file per user, OUTSIDE the repository.
 *
 * Its own directory rather than the other bot's: two bots sharing a key store means a bug in
 * either can destroy both, and while this one is being built the other is still running.
 *
 * ── it follows the volume, for the same reason the book does ──
 *
 * This was HOME-relative while DATA_DIR followed RAILWAY_VOLUME_MOUNT_PATH, which put the
 * credential on the container filesystem the platform rebuilds on every release. Worse than
 * losing it: masterKey() writes a NEW secret when it finds none, so the next deploy could not
 * have read a surviving file either. The symptom arrived hours later as "the key doesn't save",
 * pointing at the import, which had worked perfectly.
 *
 * So the same rule as the book: an explicit setting wins, otherwise the mounted volume, otherwise
 * the home directory. `dataExists` is passed in rather than probed so the decision is testable —
 * see test/keystore.test.js.
 */
function resolveKeyDir(env = process.env, home = os.homedir(), dataExists = false) {
  // KALSHI_KEY_DIR first because kalshiauth.js reads that variable directly; if this disagreed
  // with it, one of them would be writing where the other does not look.
  if (env.KALSHI_KEY_DIR) return { dir: env.KALSHI_KEY_DIR, source: 'KALSHI_KEY_DIR', persistent: true };
  if (env.KEY_DIR) return { dir: env.KEY_DIR, source: 'KEY_DIR', persistent: true };
  if (env.RAILWAY_VOLUME_MOUNT_PATH) {
    return { dir: path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'keys'), source: 'RAILWAY_VOLUME_MOUNT_PATH', persistent: true };
  }
  if (dataExists) return { dir: path.join('/data', 'keys'), source: '/data', persistent: true };
  // A laptop. Kept exactly where it was, because a Kalshi private key can only be exported at the
  // moment it is created and moving the default would orphan one.
  //
  // Deployed and landing HERE is the case that lost a key: no volume attached, so this is a
  // container home directory that the next release rebuilds. It reports itself ephemeral rather
  // than looking like every other successful write.
  return { dir: path.join(home, '.indicbot'), source: 'home-default', persistent: !isDeployed(env) };
}

/**
 * Whether this process is the deployment.
 *
 * Any RAILWAY_* variable, rather than one specific name, so the check does not quietly become
 * false the day the platform renames something.
 */
function isDeployed(env = process.env) {
  return Object.keys(env).some(k => k.startsWith('RAILWAY_'));
}

/**
 * Whether this process must refuse to log into Discord.
 *
 * A laptop run and the deployment share one bot token, and Discord hands each button press to
 * whichever session acknowledges first. The result is a panel that answers from a different
 * machine than the one it rendered on: a key imported here is absent there, an Arm here leaves
 * the scanner there filling paper, and every fix appears to work half the time. That cost five
 * commits on 2026-08-28 before the two processes were noticed.
 *
 * ALLOW_LOCAL=1 is the deliberate override, for iterating on the panel with the deployment
 * stopped — or with a second bot token, which is the safe way to do it.
 */
function localRunBlocked(env = process.env) {
  if (isDeployed(env)) return false;
  return String(env.ALLOW_LOCAL || '') !== '1';
}

const keyStore = resolveKeyDir(process.env, os.homedir(), fs.existsSync('/data'));
const KEY_DIR = keyStore.dir;
const KEY_DIR_SOURCE = keyStore.source;
const KEY_DIR_PERSISTENT = keyStore.persistent;

/**
 * Which process this is, in one short string.
 *
 * Printed at boot and put on the panel footer. When two instances shared a token, every symptom
 * was "the panel contradicts itself" and there was no way to tell that consecutive replies had
 * come from different machines. Now the reply says which one it is, so that is a glance rather
 * than an afternoon.
 */
const INSTANCE = [
  isDeployed(process.env) ? (process.env.RAILWAY_SERVICE_NAME || 'railway') : `local:${os.hostname().split('.')[0]}`,
  (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
  `pid${process.pid}`
].filter(Boolean).join('·');

module.exports = {
  loadEnvFile,
  resolveKeyDir,
  isDeployed,
  localRunBlocked,

  // ── Discord ──
  // Required to run the bot. Absent is a clear startup error, not a crash halfway through.
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || '',
  // Bento. The one account that may see or change anything fleet-wide.
  OWNER_ID: process.env.OWNER_ID || '384033277595484160',

  // ── Kalshi ──
  // Same host the other bot signs against, so a working key stays working.
  KALSHI_API_BASE: process.env.KALSHI_API_BASE
    || 'https://api.elections.kalshi.com/trade-api/v2',
  COINBASE_BASE: process.env.COINBASE_BASE || 'https://api.exchange.coinbase.com/products',

  // ── storage ──
  DATA_DIR,
  DATA_DIR_SOURCE,
  KEY_DIR,
  KEY_DIR_SOURCE,
  KEY_DIR_PERSISTENT,
  INSTANCE,

  // ── which gate decides ──
  //
  // 'favourite' buys the side the book already favours at 85-90c (src/favourite.js); 'model' is the
  // original spot-vs-strike read with four indicators confirming (src/decide.js); 'both' runs the
  // favourite gate first and falls back to the model when it does not fire.
  //
  // The default is 'favourite' because the model gate was measured over 68 days and 45,030 settled
  // markets and is fairly priced — its realised win rate equals the price it pays, so the fee is the
  // whole result. The favourite gate is the one configuration that earned above its own break-even on
  // data that had no part in choosing it. Changing the default cannot move real money by itself:
  // `armed` is forced false on every startup, so live trading still needs somebody to arm it.
  STRATEGY: (process.env.STRATEGY || 'favourite').toLowerCase(),

  // ── web ──
  PORT: Number(process.env.PORT || 3000),
  // Gates the web dashboard. Unset means the site serves only what is safe to serve openly.
  WEB_TOKEN: process.env.WEB_TOKEN || ''
};
