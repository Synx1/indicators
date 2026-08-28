/**
 * Kalshi API credentials, one per Discord user.
 *
 * Kalshi does not issue bearer tokens. Every authenticated request carries three
 * headers, and the signature is an RSA-PSS signature over a string built from the
 * timestamp, the HTTP method and the request path:
 *
 *     KALSHI-ACCESS-KEY        the Key ID (a UUID)
 *     KALSHI-ACCESS-TIMESTAMP  now, in MILLISECONDS
 *     KALSHI-ACCESS-SIGNATURE  base64(RSA-PSS-SHA256(timestamp + METHOD + path))
 *
 * See https://docs.kalshi.com/getting_started/api_keys and
 * https://docs.kalshi.com/getting_started/quick_start_authenticated_requests
 *
 * Two details in there are easy to get wrong and produce an opaque 401:
 *
 *   1. The path signed is the FULL path from the API root and excludes the query
 *      string. For a request to `/portfolio/fills?limit=5` against a base URL of
 *      `https://external-api.kalshi.com/trade-api/v2`, the signed path is
 *      `/trade-api/v2/portfolio/fills`. signPath() derives the root from the
 *      configured base rather than hardcoding it, so pointing the bot at the demo
 *      environment does not silently break every signature.
 *
 *   2. The timestamp is milliseconds, not seconds. A seconds timestamp is a valid
 *      number and signs perfectly; it just always fails.
 *
 * ── one file per user, and why that shape ──
 *
 * Each user's credential is its own encrypted file, named by Discord user id, under
 * a directory OUTSIDE the working tree. Not one file holding every key.
 *
 * That is a blast-radius decision. A single combined store means every read, write
 * and re-encryption touches every user's private key at once, so one bug — a
 * truncated write, a bad merge, a mis-scoped loop — can lose or leak the whole set.
 * Separate files mean the code that serves one user only ever opens that user's
 * file, and a mistake is contained to the person it belongs to.
 *
 * ── NOT in data/ ──
 *
 * This repository deliberately tracks data/ — .gitignore says so explicitly and
 * commits 122 MB of collected market history on purpose. A private key written there
 * would be committed by the next `git add data`, pushed, and then permanently in a
 * remote's history. That is exactly how the Discord token in this project was lost;
 * the comment at the top of src/config.js is the post-mortem.
 *
 * So the store lives under the user's home directory, encrypted at rest with
 * AES-256-GCM. No git operation in this repo can reach it. KALSHI_KEY_DIR overrides
 * the location for a host with a mounted secret volume.
 *
 * ── the boundary that matters in a multi-user bot ──
 *
 * A private key is decrypted for exactly one purpose: signing a request on behalf of
 * the user it belongs to. There is no export, no admin read, and no function that
 * returns key material. The admin panel can show another user's BALANCE, because
 * that is fetched by signing with that user's own key on their own behalf — it can
 * never show or move the key itself. `headers()` requires a userId and will not
 * accept a default, so there is no code path where "some user's" credential is
 * ambient.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KALSHI_API_BASE } = require('./config');

/**
 * Whether the store is at its default location.
 *
 * An explicit KALSHI_KEY_DIR means "use exactly this directory" — a mounted secret
 * volume, or a scratch path in a test. The legacy migrations below are therefore
 * skipped when it is set, because reaching into the home directory anyway would
 * violate that instruction in the one place it matters most.
 *
 * This is not theoretical. Before this guard existed, verify-live.js pointed
 * KALSHI_KEY_DIR at a temp directory and the migration still found the real key in
 * ~/.directionalbot, renamed it aside, and copied it somewhere the test then deleted.
 * A test consumed a live credential. Nothing was lost because the rename is
 * recoverable, and it should not have been possible at all.
 */
const KEY_DIR_IS_DEFAULT = !process.env.KALSHI_KEY_DIR;

const KEY_DIR = process.env.KALSHI_KEY_DIR ||
  require('./config').KEY_DIR;
const USER_DIR = path.join(KEY_DIR, 'users');
const SECRET_FILE = path.join(KEY_DIR, 'secret.bin');

/**
 * The directory this used to live in, before the bot was renamed.
 *
 * Adopted rather than abandoned. A Kalshi private key can only be exported at the
 * moment it is created, so a rename that orphaned the store would force every user
 * to generate a fresh key for no reason other than a change of branding.
 */
const LEGACY_DIR = path.join(os.homedir(), '.directionalbot');

/** The pre-multi-user store, in either directory. Migrated once, then left alone. */
const LEGACY_FILE = path.join(KEY_DIR, 'kalshi-key.enc');
const LEGACY_DIR_FILE = path.join(LEGACY_DIR, 'kalshi-key.enc');

/**
 * The path prefix that must appear in the signed string.
 *
 * Derived from the configured base URL rather than written as a literal, so the demo
 * environment (`https://demo-api.kalshi.co/trade-api/v2`) and any future versioned
 * root sign correctly without a second constant to keep in step.
 */
function apiRoot() {
  try {
    const p = new URL(KALSHI_API_BASE).pathname.replace(/\/+$/, '');
    return p || '';
  } catch (_) {
    return '/trade-api/v2';
  }
}

const API_ROOT = apiRoot();

// ── encryption at rest ────────────────────────────────────────

/**
 * The 32-byte key used to encrypt every user's store.
 *
 * KALSHI_KEY_SECRET is preferred: it keeps the secret and the ciphertext in
 * different places, which is the only arrangement where the encryption does
 * meaningful work against stolen files. Absent that, a random secret is generated
 * once and written alongside — which still defeats casual reading of the key files
 * themselves, and is a great deal better than plaintext.
 *
 * Any passphrase is accepted and hashed to the right length, so the environment
 * variable does not have to be exactly 32 bytes of hex.
 *
 * One secret for all users rather than one per user, deliberately. A per-user secret
 * would have to be stored somewhere this process can reach anyway, so it would add
 * key management without adding protection — the honest security boundary here is
 * "can you execute code as this account", and that is the same either way.
 */
let secretCache = null;
function masterKey() {
  if (secretCache) return secretCache;

  const fromEnv = process.env.KALSHI_KEY_SECRET;
  if (fromEnv && String(fromEnv).trim()) {
    secretCache = crypto.createHash('sha256').update(String(fromEnv).trim()).digest();
    return secretCache;
  }

  ensureDirs();
  if (fs.existsSync(SECRET_FILE)) {
    const raw = fs.readFileSync(SECRET_FILE);
    if (raw.length >= 32) {
      secretCache = raw.subarray(0, 32);
      return secretCache;
    }
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  try { fs.chmodSync(SECRET_FILE, 0o600); } catch (_) { /* best effort on Windows */ }
  secretCache = generated;
  return secretCache;
}

function ensureDirs() {
  if (!fs.existsSync(KEY_DIR)) fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
}

function decrypt(blob) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', masterKey(), Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

// ── identity ──────────────────────────────────────────────────

/**
 * A Discord snowflake, validated before it is used in a file path.
 *
 * This is the only user-supplied value that reaches the filesystem, so it is checked
 * as a strict numeric id rather than merely escaped. `../` in a user id would
 * otherwise be a path traversal straight out of the key directory, and an id is
 * always 17-20 digits — there is no reason to accept anything else.
 */
function validId(userId) {
  return /^\d{17,20}$/.test(String(userId || ''));
}

function fileFor(userId) {
  if (!validId(userId)) throw new Error(`kalshiauth: '${userId}' is not a Discord user id`);
  return path.join(USER_DIR, `${userId}.enc`);
}

// ── credentials ───────────────────────────────────────────────

/**
 * Decrypted credentials, per user, so a signature does not read a file per request.
 * @type {Map<string, {keyId:string, privateKey:string, importedAt:string}>}
 */
const cache = new Map();
/** Users whose file was checked and found absent, so we do not stat it repeatedly. */
const known = new Set();

/**
 * Normalise a pasted private key.
 *
 * Every failure mode here is a paste artefact rather than a wrong key, which is
 * worth handling because they all surface as the same unhelpful OpenSSL error. A key
 * pasted through a Discord modal commonly arrives with literal backslash-n instead
 * of newlines, with CRLF, or with the header and body run together on one line.
 */
function normalisePem(input) {
  let s = String(input || '').trim();
  if (!s) return '';

  if (!s.includes('\n') && s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

  const header = s.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  const footer = s.match(/-----END [A-Z ]*PRIVATE KEY-----/);
  if (!header || !footer) return s;              // let the parser reject it

  // Rebuild with the body wrapped at 64 characters. This repairs a key whose
  // newlines were stripped entirely, which is otherwise unparseable even though
  // every byte of the secret is present.
  const body = s
    .slice(s.indexOf(header[0]) + header[0].length, s.indexOf(footer[0]))
    .replace(/[^A-Za-z0-9+/=]/g, '');
  const wrapped = body.match(/.{1,64}/g) || [];
  return `${header[0]}\n${wrapped.join('\n')}\n${footer[0]}\n`;
}

/** A Key ID is a UUID. Checked so a swapped-fields mistake names itself. */
function looksLikeKeyId(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(String(s || '').trim());
}

/**
 * Store one user's credential, after proving it can actually sign.
 *
 * The signing test is the point of this function. Writing the key and discovering at
 * the first order that it is a public key, a truncated paste or the wrong format
 * would mean finding out during the one operation that moves money. Signing a
 * throwaway string offline costs nothing and rules all of that out.
 *
 * It does NOT prove the key is the one Kalshi holds, or that the Key ID matches it —
 * only a request can show that. kalshitrade.forUser(...).verify() does that part, and
 * the panel runs it immediately after this.
 *
 * @returns {{ok:true, keyId:string}|{ok:false, why:string}}
 */
function importKey(userId, { keyId, privateKey }) {
  if (!validId(userId)) return { ok: false, why: 'invalid Discord user id' };

  const id = String(keyId || '').trim();
  if (!id) return { ok: false, why: 'no Key ID given' };
  if (!looksLikeKeyId(id)) {
    return {
      ok: false,
      why: 'that does not look like a Kalshi Key ID. It is a UUID, like ' +
        'a952bcbe-ec3b-4b5b-b8f9-11dae589608c. The long PEM block is the private ' +
        'key and goes in the other field.'
    };
  }

  const pem = normalisePem(privateKey);
  if (!pem) return { ok: false, why: 'no private key given' };
  if (/BEGIN [A-Z ]*PUBLIC KEY/.test(pem)) {
    return {
      ok: false,
      why: 'that is a PUBLIC key. Kalshi shows the private key once, when the key is ' +
        'created, and downloads it as a .key file — paste the contents of that file.'
    };
  }
  if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(pem)) {
    return {
      ok: false,
      why: 'that is not a PEM private key. It should start with ' +
        '"-----BEGIN RSA PRIVATE KEY-----". Paste the whole contents of the .key ' +
        'file Kalshi downloaded, including the BEGIN and END lines.'
    };
  }

  let keyObject;
  try {
    keyObject = crypto.createPrivateKey(pem);
  } catch (e) {
    return { ok: false, why: `the private key could not be read: ${e.message}` };
  }
  if (keyObject.asymmetricKeyType !== 'rsa') {
    return {
      ok: false,
      why: `this is a ${keyObject.asymmetricKeyType || 'non-RSA'} key. Kalshi signs ` +
        `with RSA-PSS, so it needs the RSA key it generated for you.`
    };
  }
  try {
    signString(pem, `${Date.now()}GET${API_ROOT}/portfolio/balance`);
  } catch (e) {
    return { ok: false, why: `the private key cannot sign: ${e.message}` };
  }

  ensureDirs();
  const record = { keyId: id, privateKey: pem, importedAt: new Date().toISOString() };
  const file = fileFor(userId);
  const tmp = `${file}.tmp`;
  try {
    // Temp file then rename, so an interrupted write cannot leave a user with a
    // half-written credential in place of a working one.
    fs.writeFileSync(tmp, JSON.stringify(encrypt(JSON.stringify(record))), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on Windows */ }
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, why: `could not write the key store: ${e.message}` };
  }

  cache.set(String(userId), record);
  known.add(String(userId));
  return { ok: true, keyId: id };
}

/**
 * Read and decrypt one user's credential.
 *
 * Module-private. Nothing outside this file receives key material — callers get
 * `headers()`, which uses the key without handing it over. In a bot that holds other
 * people's trading credentials, "who can obtain the key" should have exactly one
 * answer, and it should be "nobody".
 */
function load(userId) {
  const uid = String(userId || '');
  if (cache.has(uid)) return cache.get(uid);
  if (known.has(uid)) return null;
  if (!validId(uid)) return null;
  known.add(uid);

  migrateLegacy();

  const file = path.join(USER_DIR, `${uid}.enc`);
  if (!fs.existsSync(file)) return null;
  try {
    const rec = JSON.parse(decrypt(JSON.parse(fs.readFileSync(file, 'utf8'))));
    if (!rec || !rec.keyId || !rec.privateKey) return null;
    cache.set(uid, rec);
    return rec;
  } catch (e) {
    // Almost always a changed KALSHI_KEY_SECRET rather than a corrupt file, and that
    // distinction is the whole of the fix, so say it.
    console.error(`[kalshiauth] could not decrypt the key for ${uid}: ${e.message}`);
    console.error('[kalshiauth] if KALSHI_KEY_SECRET changed, the old value is needed ' +
      'to read this file — otherwise the user must re-import');
    return null;
  }
}

/**
 * Move a pre-multi-user key into the owner's slot, once.
 *
 * The single-user build kept one key at kalshi-key.enc with no user attached. It
 * belongs to whoever was running the bot, which is the owner, so it is adopted into
 * their slot rather than discarded — a key can only be exported from Kalshi at
 * creation time, so throwing it away would mean generating a new one for no reason.
 *
 * The legacy file is RENAMED rather than deleted. If this attribution is wrong, the
 * original is still there to recover from; and a stale copy left in place would be a
 * second live credential nobody is tracking.
 */
let migrated = false;
function migrateLegacy() {
  if (migrated) return;
  migrated = true;

  // An explicit key directory is taken literally. See KEY_DIR_IS_DEFAULT.
  if (!KEY_DIR_IS_DEFAULT) return;

  try {
    ensureDirs();

    // ── 1. the old directory name (.directionalbot -> .betsbot) ──
    //
    // Copied, not moved, and only into slots that are empty. A user who has already
    // imported under the new name must not have their current credential replaced by
    // an older one just because a stale directory still exists.
    if (fs.existsSync(LEGACY_DIR) && LEGACY_DIR !== KEY_DIR) {
      const oldUsers = path.join(LEGACY_DIR, 'users');
      if (fs.existsSync(oldUsers)) {
        for (const f of fs.readdirSync(oldUsers)) {
          if (!f.endsWith('.enc')) continue;
          const target = path.join(USER_DIR, f);
          if (fs.existsSync(target)) continue;
          fs.copyFileSync(path.join(oldUsers, f), target);
          try { fs.chmodSync(target, 0o600); } catch (_) {}
          console.log(`[kalshiauth] adopted ${f.slice(0, -4)} from the old key directory`);
        }
      }
      // The generated secret has to come across too, or nothing copied above can be
      // decrypted. Only when KALSHI_KEY_SECRET is unset — if it is set, that is the
      // key in use and a stale file must not shadow it.
      if (!process.env.KALSHI_KEY_SECRET) {
        const oldSecret = path.join(LEGACY_DIR, 'secret.bin');
        if (fs.existsSync(oldSecret) && !fs.existsSync(SECRET_FILE)) {
          fs.copyFileSync(oldSecret, SECRET_FILE);
          try { fs.chmodSync(SECRET_FILE, 0o600); } catch (_) {}
          secretCache = null;          // re-read, now that the real secret is present
          console.log('[kalshiauth] adopted the encryption secret from the old directory');
        }
      }
    }

    // ── 2. the single-user file, from either directory ──
    //
    // The pre-multi-user build kept one key with no user attached. It belongs to
    // whoever was running the bot, which is the owner, so it is adopted into their
    // slot. Renamed rather than deleted: if this attribution is wrong the original is
    // still recoverable, and a stale copy left in place would be a second live
    // credential nobody is tracking.
    const { OWNER_ID } = require('./config');
    if (!validId(OWNER_ID)) return;
    const target = path.join(USER_DIR, `${OWNER_ID}.enc`);

    for (const legacy of [LEGACY_FILE, LEGACY_DIR_FILE]) {
      if (!fs.existsSync(legacy)) continue;
      if (!fs.existsSync(target)) {
        fs.copyFileSync(legacy, target);
        try { fs.chmodSync(target, 0o600); } catch (_) {}
        console.log(`[kalshiauth] migrated the single-user key to ${OWNER_ID}`);
      }
      fs.renameSync(legacy, `${legacy}.migrated`);
    }
  } catch (e) {
    console.error(`[kalshiauth] could not migrate a legacy key: ${e.message}`);
  }
}

function isImported(userId) {
  return Boolean(load(userId));
}

/**
 * Run the legacy migrations without asking about a specific user.
 *
 * load() calls this lazily, which is enough for signing but not for reporting:
 * listUsers() at startup would show an empty fleet if nobody had been looked up yet.
 * Called once from the bot's boot sequence so the migration happens before anything
 * counts users.
 */
function init() {
  migrateLegacy();
  return { keyDir: KEY_DIR, users: listUsers().length };
}

/** Enough of the Key ID to identify it, never enough to use it. */
function maskedKeyId(userId) {
  const c = load(userId);
  if (!c) return null;
  const id = c.keyId;
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** For a status panel. Deliberately carries no key material. */
function status(userId) {
  const c = load(userId);
  return {
    userId: String(userId || ''),
    imported: Boolean(c),
    keyId: c ? maskedKeyId(userId) : null,
    importedAt: c ? c.importedAt : null,
    storeDir: USER_DIR,
    envSecret: Boolean(process.env.KALSHI_KEY_SECRET),
    apiRoot: API_ROOT
  };
}

/**
 * Every user with a stored credential.
 *
 * Reads the directory rather than the cache, so it reports what is actually on disk
 * including users this process has never served. Ids only — no key material, which
 * is what makes it safe for the admin panel.
 */
function listUsers() {
  migrateLegacy();
  try {
    if (!fs.existsSync(USER_DIR)) return [];
    return fs.readdirSync(USER_DIR)
      .filter(f => f.endsWith('.enc'))
      .map(f => f.slice(0, -4))
      .filter(validId);
  } catch (_) {
    return [];
  }
}

/**
 * Delete one user's credential.
 *
 * Worth being plain about the limit of this: it stops THIS bot signing for them. It
 * does not revoke anything. A key that may have been seen by someone else has to be
 * deleted in Kalshi's account settings, which is the only action that makes it stop
 * working.
 */
function forget(userId) {
  const uid = String(userId || '');
  if (!validId(uid)) return { ok: false, why: 'invalid Discord user id' };
  cache.delete(uid);
  known.delete(uid);
  try {
    const file = path.join(USER_DIR, `${uid}.enc`);
    if (!fs.existsSync(file)) return { ok: true, removed: false };
    fs.unlinkSync(file);
    return { ok: true, removed: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// ── signing ───────────────────────────────────────────────────

/**
 * RSA-PSS over SHA-256, salt length equal to the digest length.
 *
 * RSA_PSS_SALTLEN_DIGEST is required, not a default. Node's default for PSS is
 * RSA_PSS_SALTLEN_MAX_SIGN, which produces a signature Kalshi rejects — and rejects
 * as a plain 401, with nothing to indicate the padding was the problem.
 */
function signString(privateKeyPem, message) {
  return crypto.sign('sha256', Buffer.from(message, 'utf8'), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }).toString('base64');
}

/**
 * The full path to sign, for a request path relative to the API base.
 *
 * Query string stripped: Kalshi signs the path only, and including `?limit=5` fails
 * every paginated call while leaving unpaginated ones working — a miserable thing to
 * debug.
 */
function signPath(requestPath) {
  const noQuery = String(requestPath || '').split('?')[0];
  const withSlash = noQuery.startsWith('/') ? noQuery : `/${noQuery}`;
  return `${API_ROOT}${withSlash}`;
}

/**
 * Signed headers for one request, on behalf of ONE user.
 *
 * userId is required and has no default. That is the multi-user safety property:
 * there is no ambient credential, so no code path can accidentally sign one user's
 * order with another user's key. A missing or unknown user returns null, which every
 * caller in src/kalshitrade.js checks and reports as "no key imported".
 *
 * @param {string} userId
 * @param {string} method  GET | POST | DELETE ...
 * @param {string} requestPath  relative to KALSHI_API_BASE, e.g. '/portfolio/balance'
 */
function headers(userId, method, requestPath) {
  const c = load(userId);
  if (!c) return null;

  const ts = Date.now().toString();
  const m = String(method || 'GET').toUpperCase();

  return {
    'KALSHI-ACCESS-KEY': c.keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signString(c.privateKey, `${ts}${m}${signPath(requestPath)}`)
  };
}

/**
 * An auth provider bound to one user, for kalshitrade.forUser().
 *
 * Passing this object around instead of a userId string means a trading client
 * physically cannot be re-pointed at a different account after it is built — the
 * userId is closed over, not a parameter. In a bot handling several people's money,
 * that is the difference between an isolation bug being impossible and being merely
 * unlikely.
 */
function forUser(userId) {
  const uid = String(userId || '');
  return {
    userId: uid,
    isImported: () => isImported(uid),
    maskedKeyId: () => maskedKeyId(uid),
    status: () => status(uid),
    headers: (method, requestPath) => headers(uid, method, requestPath)
  };
}

module.exports = {
  API_ROOT,
  KEY_DIR,
  USER_DIR,
  LEGACY_DIR,
  init,
  importKey,
  isImported,
  status,
  maskedKeyId,
  listUsers,
  forget,
  headers,
  forUser,
  signPath,
  validId,
  // Exported for verify-live.js, which signs a known string and verifies it against
  // a derived public key. Nothing else should need these.
  signString,
  normalisePem
};
