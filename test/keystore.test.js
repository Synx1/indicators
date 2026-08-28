/**
 * Where the encrypted Kalshi key store lives, and whether a second instance may boot.
 *
 * Both of these are asserted because both were live defects on 2026-08-28, and neither showed a
 * symptom at the point of failure:
 *
 *   1. KEY_DIR was HOME-relative while DATA_DIR followed the mounted volume. On Railway that puts
 *      the credential on the container filesystem, which is rebuilt on every deploy — and
 *      masterKey() generates a NEW secret when it finds none, so even a surviving .enc becomes
 *      undecryptable. The user's report was "the key doesn't save", four hours after it saved fine.
 *
 *   2. Nothing stopped a laptop `node index.js` from logging into the SAME Discord token as the
 *      deployment. Discord then hands each button press to whichever session acknowledges first,
 *      so a key imported on one instance is absent on the other and an Arm on one leaves the other
 *      filling paper. Five fixes were validated through that coin flip before anyone noticed.
 *
 * Run: node test/keystore.test.js
 */
const assert = require('assert');
const path = require('path');
const cfg = require('../src/config');

const HOME = '/home/tester';
let checks = 0;
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what}: got ${a}, want ${b}`); checks++; };

// ── where the key store goes ────────────────────────────────────
assert.strictEqual(typeof cfg.resolveKeyDir, 'function', 'config must export resolveKeyDir(env, home, dataExists)');

// The bug, stated as a test: a mounted volume must capture the KEY store too, not just the book.
eq(cfg.resolveKeyDir({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }, HOME, false).dir, '/data/keys',
  'a mounted volume holds the keys');
eq(cfg.resolveKeyDir({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }, HOME, false).source, 'RAILWAY_VOLUME_MOUNT_PATH',
  'and says where that came from');
assert.ok(!cfg.resolveKeyDir({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }, HOME, false).dir.startsWith(HOME),
  'with a volume mounted, the key store must NOT fall back under the home directory');
checks++;

// An explicit setting is taken literally, and KALSHI_KEY_DIR outranks it because kalshiauth.js
// reads that variable directly — the two must never disagree about the path.
eq(cfg.resolveKeyDir({ KALSHI_KEY_DIR: '/mnt/secrets', KEY_DIR: '/other', RAILWAY_VOLUME_MOUNT_PATH: '/data' }, HOME, true).dir,
  '/mnt/secrets', 'KALSHI_KEY_DIR wins outright');
eq(cfg.resolveKeyDir({ KEY_DIR: '/other', RAILWAY_VOLUME_MOUNT_PATH: '/data' }, HOME, true).dir,
  '/other', 'KEY_DIR beats the volume');

// A volume that exists but was not announced by the platform still counts.
eq(cfg.resolveKeyDir({}, HOME, true).dir, '/data/keys', 'an existing /data holds the keys');
eq(cfg.resolveKeyDir({}, HOME, true).source, '/data', 'and names itself');

// A laptop keeps the store it already has, outside the repo. Changing this would orphan a real key.
eq(cfg.resolveKeyDir({}, HOME, false).dir, path.join(HOME, '.indicbot'), 'a laptop keeps ~/.indicbot');
eq(cfg.resolveKeyDir({}, HOME, false).source, 'home-default', 'and is honest that it is the default');

// Persistence is reported, not guessed at: the banner and the panel both render this.
eq(cfg.resolveKeyDir({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }, HOME, false).persistent, true, 'volume is persistent');
eq(cfg.resolveKeyDir({}, HOME, false).persistent, true, 'a laptop home directory is persistent');
// The case that actually lost a key: deployed, no volume attached, so the store falls back to a
// home directory the platform rebuilds. It must report itself as ephemeral rather than look fine.
eq(cfg.resolveKeyDir({ RAILWAY_ENVIRONMENT: 'production' }, HOME, false).persistent, false,
  'deployed with no volume is EPHEMERAL');
eq(cfg.resolveKeyDir({ RAILWAY_ENVIRONMENT: 'production' }, HOME, false).source, 'home-default',
  'and still says where it landed');

// ── who may log into Discord ────────────────────────────────────
assert.strictEqual(typeof cfg.isDeployed, 'function', 'config must export isDeployed(env)');
assert.strictEqual(typeof cfg.localRunBlocked, 'function', 'config must export localRunBlocked(env)');

eq(cfg.isDeployed({ RAILWAY_ENVIRONMENT: 'production' }), true, 'any RAILWAY_ var means deployed');
eq(cfg.isDeployed({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }), true, 'a Railway volume means deployed');
eq(cfg.isDeployed({ PATH: '/usr/bin' }), false, 'a bare environment is not deployed');

// The whole point: a laptop run is refused, because it would share the deployment's token.
eq(cfg.localRunBlocked({ PATH: '/usr/bin' }), true, 'a local run is blocked by default');
eq(cfg.localRunBlocked({ RAILWAY_ENVIRONMENT: 'production' }), false, 'the deployment is never blocked');
eq(cfg.localRunBlocked({ ALLOW_LOCAL: '1' }), false, 'ALLOW_LOCAL=1 is the deliberate override');
eq(cfg.localRunBlocked({ ALLOW_LOCAL: '0' }), true, 'ALLOW_LOCAL=0 is not an override');
eq(cfg.localRunBlocked({ ALLOW_LOCAL: '' }), true, 'an empty ALLOW_LOCAL is not an override');

// ── the live values agree with the resolver ─────────────────────
// Guards against the resolver being correct while the exported constant is computed some other way,
// which is exactly the shape of the original bug.
const liveResolved = cfg.resolveKeyDir(process.env, require('os').homedir(), require('fs').existsSync('/data'));
eq(cfg.KEY_DIR, liveResolved.dir, 'exported KEY_DIR comes from the resolver');
eq(cfg.KEY_DIR_SOURCE, liveResolved.source, 'exported KEY_DIR_SOURCE comes from the resolver');

console.log(`PASS keystore — ${checks} assertions (key store follows the volume; local runs refused)`);
