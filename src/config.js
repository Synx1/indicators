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
 */
const KEY_DIR = process.env.KEY_DIR || path.join(os.homedir(), '.indicbot');

module.exports = {
  loadEnvFile,

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

  // ── web ──
  PORT: Number(process.env.PORT || 3000),
  // Gates the web dashboard. Unset means the site serves only what is safe to serve openly.
  WEB_TOKEN: process.env.WEB_TOKEN || ''
};
