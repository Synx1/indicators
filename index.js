/**
 * The bot process: Discord client, slash command, and the interaction boundary.
 *
 * Separate from bot.js (the trading loop) so the panel can be run and tested on its own. Neither
 * one places an order yet — execution lands next.
 */

const {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  SlashCommandBuilder, MessageFlags, InteractionContextType, ApplicationIntegrationType
} = require('discord.js');

const {
  DISCORD_TOKEN, OWNER_ID, DATA_DIR, DATA_DIR_SOURCE,
  KEY_DIR, KEY_DIR_SOURCE, KEY_DIR_PERSISTENT, INSTANCE, localRunBlocked
} = require('./src/config');
const users = require('./src/users');
const settings = require('./src/settings');
const auth = require('./src/kalshiauth');
const kt = require('./src/kalshitrade');
const gl = require('./src/markets');
const panel = require('./src/panel');
const trader = require('./src/trader');
const notify = require('./src/notify');
const site = require('./src/site');

const line = (...a) => console.log(...a);

if (!DISCORD_TOKEN) {
  line('!! DISCORD_TOKEN is not set.');
  line('   Local: put it in .env.local (gitignored). Deployed: set it as a service variable.');
  process.exit(1);
}

// ── startup banner ──────────────────────────────────────────────
//
// Says where state lives and whether that survives a restart, because "my history reset" is
// otherwise discovered by noticing it is gone. DATA_DIR_SOURCE naming `repo-default` is the
// failing case and says so itself.
line('='.repeat(78));
line(`  ${panel.NAME} ${panel.VERSION} — Kalshi 15-minute crypto`);
line('-'.repeat(78));
line(`  State      ${DATA_DIR}  (via ${DATA_DIR_SOURCE})`);
if (DATA_DIR_SOURCE === 'repo-default') {
  line('  !! state is in the repo directory. On a hosted deploy that is rebuilt every');
  line('     release, so books and settings will reset. Attach a volume.');
}
line(`  Keys       ${KEY_DIR}/users  (encrypted, one file per user, outside the repo)`);
line(`             via ${KEY_DIR_SOURCE}${KEY_DIR_PERSISTENT ? '' : '  — !! REBUILT EVERY DEPLOY'}`);
if (!KEY_DIR_PERSISTENT) {
  line('  !! the key store is on a disk this platform rebuilds on every release. An imported');
  line('     key will disappear at the next deploy, and the secret beside it is regenerated, so');
  line('     the file could not be read even if it survived. Attach a volume.');
}
line(`  Key secret ${process.env.KALSHI_KEY_SECRET ? 'KALSHI_KEY_SECRET is set'
  : 'generated file beside the store — set KALSHI_KEY_SECRET to separate them'}`);
line(`  Instance   ${INSTANCE}`);
line(`  Owner      ${OWNER_ID}`);
line('='.repeat(78));

// ── one instance per token, or the panel answers from the wrong machine ─────────
//
// A laptop run and the deployment share one bot token. Discord hands each button press to
// whichever session acknowledges first, so the panel can render here and be answered there: a key
// imported on one is missing on the other, an Arm on one leaves the other's scanner filling paper,
// and a fix appears to work half the time. That is a full afternoon and five commits, and none of
// them could have worked. Refusing to start is the only version of this that cannot happen twice.
if (localRunBlocked(process.env)) {
  line('!! REFUSING TO START — this is not the deployment, and the deployment is using this token.');
  line('');
  line('   Two processes on one Discord token race for every button press, so half your clicks');
  line('   would be answered by Railway and half by this laptop, each with its own book, its own');
  line('   settings and its own key store. That is the bug that produced "the key does not save"');
  line('   and "I armed it and it still fills paper".');
  line('');
  line('   To iterate on the panel here: stop the Railway service (or use a second bot token),');
  line('   then run  ALLOW_LOCAL=1 npm start');
  line('   To run without touching the market:  ALLOW_LOCAL=1 TRADER=off npm start');
  process.exit(1);
}

auth.init();
gl.init({ log: line });
const store = users.init({ log: line });

const client = new Client({
  // DM-only, so no guild intents and no message content. The panel never reads a message; it
  // only answers interactions, which is the smallest permission surface that can work.
  intents: [GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

const command = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('Your balance, positions, P&L and controls')
  // ── why a USER install, not only a guild install ──
  //
  // Discord will not let somebody DM a bot they share no server with. With a guild install only,
  // "other people cannot use the bot" is the correct behaviour rather than a fault: they had no way
  // to open the conversation. A user install lets a person add the app to their own account and run
  // /dashboard in their own DMs, which is the whole distribution story for a bot that is DM-only by
  // design.
  .setIntegrationTypes([
    ApplicationIntegrationType.GuildInstall,
    ApplicationIntegrationType.UserInstall
  ])
  // Still never in a server. The panel shows a balance and open positions; in a guild an ephemeral
  // reply is one misclick from a screenshot. Private channels are allowed because that is where a
  // user-installed app lives, and every reply here is ephemeral.
  .setContexts(InteractionContextType.BotDM, InteractionContextType.PrivateChannel);

async function registerCommands(appId) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(appId), { body: [command.toJSON()] });
  line('  /dashboard registered (global, DM-only)');
}

// ── the interaction boundary ────────────────────────────────────
//
// Discord allows THREE SECONDS. Miss it and the token is dead, so nothing can be said at all —
// that is what "The application did not respond" is. In the other bot three separate paths could
// return without acknowledging, so this wrapper exists from the first commit: whatever dispatch()
// leaves unacknowledged gets an answer, and a handler that overruns gets deferred at 2.2s.
//
// showModal is the one response that cannot follow a defer, so rather than keeping a list of
// modal-opening ids that the next one would fall off, showModal is wrapped to cancel the timer.
const ACK_MS = 2200;

function armAck(interaction) {
  let cancelled = false;
  const acked = () => Boolean(interaction.replied || interaction.deferred);
  const deferrable = typeof interaction.isButton === 'function' && interaction.isButton();
  const timer = deferrable ? setTimeout(() => {
    if (cancelled || acked()) return;
    Promise.resolve(interaction.deferUpdate()).catch(() => {});
  }, ACK_MS) : null;
  const cancel = () => { cancelled = true; if (timer) clearTimeout(timer); };
  if (typeof interaction.showModal === 'function') {
    const original = interaction.showModal.bind(interaction);
    interaction.showModal = (...args) => { cancel(); return original(...args); };
  }
  return { cancel, acked };
}

/**
 * Defer, but only if nothing has acknowledged yet.
 *
 * The 2.2s watchdog in armAck() can fire while a handler is still working, and the handler then
 * called deferUpdate() itself — Discord rejects the second one with "Interaction has already been
 * acknowledged", which surfaced as buttons that simply did nothing. Both paths now go through here,
 * so whichever gets there first wins and the other is a no-op.
 */
async function ackUpdate(interaction) {
  if (interaction.replied || interaction.deferred) return;
  // interaction.deferUpdate(), NOT ackUpdate(). A blanket search-and-replace of deferUpdate calls
  // rewrote this one too and made the function call itself — every button that went through here
  // threw "Maximum call stack size exceeded", which is to say every button.
  await interaction.deferUpdate();
}

async function handle(interaction) {
  const ack = armAck(interaction);
  try {
    await dispatch(interaction);
  } catch (e) {
    line(`  panel error on ${interaction.customId || interaction.commandName}: ${e.message}`);
    const msg = { content: `❌ ${e.message}`, flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch (_) { /* token already gone; the log line above is the record */ }
  } finally {
    ack.cancel();
  }
  if (ack.acked()) return;
  // Nothing claimed it. A stale button from an older deploy is the common case, and Discord
  // keeps old messages forever, so this will happen.
  try {
    await interaction.reply({
      content: '🕸️ That control is from an older version of the panel. Run `/dashboard` for a ' +
        'current one — nothing of yours has changed.',
      flags: MessageFlags.Ephemeral
    });
  } catch (e) {
    line(`  could not acknowledge ${interaction.customId || '?'}: ${e.message}`);
  }
}

async function dispatch(interaction) {
  // Enforced as well as declared: a stale guild-scoped registration or a component on a message
  // that ended up in a channel would both land here.
  if (interaction.guildId) {
    return interaction.reply({
      content: '🔒 **This panel only works in DMs.** It shows your balance and positions, so it ' +
        'is not something to open in a server. Message me directly and run `/dashboard`.',
      flags: MessageFlags.Ephemeral
    });
  }

  // The tenant comes from the AUTHENTICATED user and from nothing else. This is the isolation
  // boundary, and it is the only place a record is created — the one place the person is
  // demonstrably present.
  const t = users.tenant(interaction.user.id, { create: true });
  if (!t) return interaction.reply({ content: '❌ Could not resolve your account.', flags: MessageFlags.Ephemeral });
  users.touch(interaction.user.id, interaction.user.tag);

  const id = interaction.customId || '';

  if (interaction.isChatInputCommand()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply(await panel.mainPayload(t));
  }

  // ── modals first: showModal cannot follow a defer ──
  if (interaction.isButton()) {
    if (id === `${panel.ID}:key`) return interaction.showModal(panel.keyModal());
    if (id.startsWith(`${panel.ID}:set:`)) {
      const key = id.slice(`${panel.ID}:set:`.length);
      // Unknown OR hidden: the boundary explains either as a stale control.
      //
      // Hidden matters as much as unknown here. Discord keeps old messages forever, so a panel
      // rendered before `armed` was withdrawn still carries its button — and this path writes with
      // a bare t.set(), which would arm real money while skipping every check the Arm button makes.
      // Withdrawing a control means refusing it here, not only leaving it off the next render.
      if (!settings.SCHEMA[key] || settings.SCHEMA[key].hidden) return;
      // A boolean has nothing to type. Toggling is one press instead of a modal asking for
      // "on" — the kind of friction that makes a panel feel like paperwork.
      if (settings.SCHEMA[key].type === settings.TYPE.BOOL) {
        const next = t.get(key) ? 'off' : 'on';
        t.set(key, next);
        await ackUpdate(interaction);
        return interaction.editReply(panel.settingsPayload(t));
      }
      return interaction.showModal(panel.settingModal(t, key));
    }
  }

  if (interaction.isModalSubmit()) {
    if (id === `${panel.ID}:keymodal`) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const keyId = interaction.fields.getTextInputValue('keyid').trim();
      const privateKey = interaction.fields.getTextInputValue('privatekey');
      // importKey proves the credential against the live account before storing it. A key that
      // parses but cannot sign is the common failure, and calling that "imported" would be worse
      // than refusing it.
      const res = auth.importKey(t.userId, { keyId, privateKey });
      if (!res.ok) return interaction.editReply({ content: `❌ ${res.why}` });

      // Stored is not the same as WORKING. A key can parse perfectly and still be the wrong
      // key, a deleted key, or paired with the wrong Key ID — and every one of those fails
      // identically later, at the order. So it is proven with a real signed request now, and
      // the two outcomes are reported separately because their fixes differ: a parse problem
      // is a paste problem, a 401 is the wrong credential.
      let proof = null;
      try {
        const client = kt.forUser(auth.forUser(t.userId));
        proof = await client.balance();
      } catch (e) { proof = { ok: false, why: e.message }; }

      if (!proof || !proof.ok) {
        return interaction.editReply({
          content: `⚠️ Key stored, but it could not sign a request: ${(proof && proof.why) || 'unknown'}\n\n` +
            `The usual causes are the Key ID not matching this private key, or the key having ` +
            `been deleted on Kalshi. Re-import with the pair from the same row of ` +
            `Account & security → API Keys.`
        });
      }
      return interaction.editReply({
        content: `✅ Key imported and **proven** — it signed a live request and your balance is ` +
          `${users.money(proof.dollars)}.\n` +
          `Key ID \`${auth.maskedKeyId(t.userId) || keyId.slice(0, 8) + '…'}\`, encrypted on disk ` +
          `outside the repo and never shown again.\n\n` +
          `Run \`/dashboard\` — **Arm** is available now.`
      });
    }
    if (id.startsWith(`${panel.ID}:setmodal:`)) {
      const key = id.slice(`${panel.ID}:setmodal:`.length);
      const spec = settings.SCHEMA[key];
      // Hidden refused here too — a modal from an old message is the same stale control as a button.
      if (!spec || spec.hidden) return;
      const raw = interaction.fields.getTextInputValue('value');
      const res = t.set(key, raw);
      if (!res.ok) {
        return interaction.reply({ content: `❌ **${spec.label}**: ${res.why}`, flags: MessageFlags.Ephemeral });
      }
      let extra = '';
      if (key === 'paperBankroll') {
        // Re-baseline, or the figure just typed is added to a lifetime paper P&L that can dwarf
        // it — the trap that made the other bot's paper balance impossible to reset.
        t.set('paperResetAt', String(Date.now()));
        extra = '\n\nPaper P&L now counts from here; earlier paper trades no longer count ' +
          'against it.';
      }
      if (key === 'liveBankroll') {
        extra = '\n\nCapped by your real balance whatever is entered — the panel shows the ' +
          'figure actually in play.';
      }
      return interaction.reply({
        content: `✅ **${spec.label}** is now **${t.fmt(key)}**${extra}`,
        flags: MessageFlags.Ephemeral
      });
    }
  }

  if (!interaction.isButton()) return;

// ── owner-only, checked here rather than per-button ──
  //
  // One gate for every fleet-wide control, so a control added later is owner-only by default
  // instead of by somebody remembering to add the check.
  const OWNER_IDS = [`${panel.ID}:admin`, `${panel.ID}:kill`];
  const isOwnerControl = OWNER_IDS.includes(id) || id.startsWith(`${panel.ID}:mkt:`) ||
    id.startsWith(`${panel.ID}:ok:`) || id.startsWith(`${panel.ID}:no:`);
  if (isOwnerControl && !t.isOwner) {
    return interaction.reply({
      content: '🔒 That control is owner-only.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (id === `${panel.ID}:admin`) {
    await ackUpdate(interaction);
    return interaction.editReply(panel.adminPayload());
  }
  if (id.startsWith(`${panel.ID}:mkt:`)) {
    const sym = id.slice(`${panel.ID}:mkt:`.length);
    const r = gl.toggleMarket(sym);
    await ackUpdate(interaction);
    await interaction.editReply(panel.adminPayload());
    if (!r.ok) return;
    return interaction.followUp({
      content: `${sym} is now **${r.enabled ? 'ON' : 'OFF'}** for everybody.` +
        (r.enabled ? '' : ' Positions already open on it are still managed and settled.'),
      flags: MessageFlags.Ephemeral
    });
  }
  if (id === `${panel.ID}:kill`) {
    const now = !gl.isKilled();
    gl.setKilled(now, t.userId);
    await ackUpdate(interaction);
    await interaction.editReply(panel.adminPayload());
    return interaction.followUp({
      content: now
        ? '🚨 **Kill switch ON.** Nothing opens for anybody, on any market.\n\n' +
          'Anything already held is **still managed and settled** — this stops opening, it does ' +
          'not abandon open positions. It also survives a restart, unlike arming, because a kill ' +
          'is a decision somebody made and a redeploy must not undo it.'
        : '✅ **Kill switch lifted.** Accounts that were armed before the kill still need to ' +
          're-arm — arming never survives anything.',
      flags: MessageFlags.Ephemeral
    });
  }

  // ── enable or disable another account, owner only ──
  //
  // The id carries the SUBJECT's user id, which is the one place this bot reads an id out of a
  // customId rather than from the interaction. It is safe here and only here: the surrounding gate
  // has already established the presser is the owner, and validId() refuses anything that is not a
  // snowflake. tenant() without `create` then refuses an id that has never appeared on its own.
  if (id.startsWith(`${panel.ID}:ok:`) || id.startsWith(`${panel.ID}:no:`)) {
    const on = id.startsWith(`${panel.ID}:ok:`);
    const subjectId = id.slice(`${panel.ID}:${on ? 'ok' : 'no'}:`.length);
    const subject = users.validId(subjectId) ? users.tenant(subjectId) : null;
    if (!subject) {
      return interaction.reply({ content: '❌ No such account.', flags: MessageFlags.Ephemeral });
    }
    subject.setApproved(on, t.userId);
    await ackUpdate(interaction);
    await interaction.editReply(panel.adminPayload());
    // Told, not left to be discovered. Somebody waiting has no way to know the switch was flipped.
    if (on) notify.enabled(subject).catch(() => {});
    return interaction.followUp({
      content: on
        ? `✅ **${subject.rec.tag || subjectId}** is enabled. Their signals will be acted on from ` +
          'the next pass — as paper until they press Go live and Arm themselves.'
        : `⛔ **${subject.rec.tag || subjectId}** is disabled. Nothing new opens for them; anything ` +
          'already open is still managed and settled.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (id === `${panel.ID}:home` || id === `${panel.ID}:refresh`) {
    await ackUpdate(interaction);
    return interaction.editReply(await panel.mainPayload(t));
  }
  if (id === `${panel.ID}:settings`) {
    await ackUpdate(interaction);
    return interaction.editReply(panel.settingsPayload(t));
  }
  if (id === `${panel.ID}:trades`) {
    await ackUpdate(interaction);
    return interaction.editReply(panel.tradesPayload(t));
  }
  if (id === `${panel.ID}:live`) {
    if (!t.isApproved()) {
      return interaction.reply({
        content: '⏳ Your account is not enabled yet. Live mode can wait — nothing is acted on ' +
          'until the owner switches you on.',
        flags: MessageFlags.Ephemeral
      });
    }
    const turningOn = !t.get('live');
    t.set('live', turningOn ? 'on' : 'off');
    // Going back to paper disarms too. Leaving `armed` set on a paper account means the next
    // flip to live is instantly hot, which is not what anybody pressing "Go paper" intends.
    if (!turningOn) t.set('armed', 'off');
    await ackUpdate(interaction);
    await interaction.editReply(await panel.mainPayload(t));
    if (!turningOn) return;
    // Live mode ALONE changes nothing, and pressing a button labelled "Go live" and then watching
    // paper fills arrive is a reasonable thing to read as broken. So say what is still missing,
    // at the moment the expectation is formed rather than in a status line to be noticed later.
    const armedNow = t.get('armed') === true;
    if (armedNow) return;
    return interaction.followUp({
      content: '🟡 **Live mode is on — but nothing trades for real yet.**\n\n' +
        'Signals will keep filling as **paper** until you press **Arm**. Two switches on ' +
        'purpose: live is "I intend to trade real money", armed is "I am watching right now" — ' +
        'and arming is cleared by every restart, so real money can only ever be trading because ' +
        'somebody armed it since the process started.',
      flags: MessageFlags.Ephemeral
    });
  }
  if (id === `${panel.ID}:arm`) {
    // Checked here as well as disabled on the button: Discord keeps old messages, and the button on
    // one rendered before the owner disabled this account would otherwise still arm it.
    if (!t.isApproved()) {
      return interaction.reply({
        content: '⏳ Your account is not enabled yet, so arming would change nothing — the scanner ' +
          'skips it entirely. The owner has to switch it on first.',
        flags: MessageFlags.Ephemeral
      });
    }
    if (t.get('armed')) {
      t.set('armed', 'off');
      await ackUpdate(interaction);
      return interaction.editReply(await panel.mainPayload(t));
    }
    // Refusals name the missing thing rather than saying no.
    if (!auth.isImported(t.userId)) {
      // Distinguish "no key" from "a key that will not decrypt". Telling somebody to import a key
      // they already imported is the most confusing message this panel can produce, and it was
      // produced twice.
      const onDisk = auth.hasKeyFile(t.userId);
      // Instrumented because this refusal has now contradicted the panel in the same session, and
      // the panel and this branch call the SAME function on the same process. Whatever the cause,
      // the next occurrence records its own inputs rather than leaving it to be reasoned about.
      line(`  !! ARM REFUSED for ${t.userId}: isImported=${auth.isImported(t.userId)} ` +
        `hasKeyFile=${onDisk} userDir=${auth.USER_DIR} ` +
        `typeofId=${typeof t.userId} idLen=${String(t.userId).length} ` +
        `status=${JSON.stringify(auth.status(t.userId))}`);
      return interaction.reply({
        content: onDisk
          ? '❌ A key file exists for your account but it could not be decrypted — almost always ' +
            '**KALSHI_KEY_SECRET** having changed since it was saved. Set the old value back, or ' +
            'press **Import key** to replace it.'
          : '❌ No Kalshi key imported, so there is nothing to arm. Press **Import key** first.',
        flags: MessageFlags.Ephemeral
      });
    }
    if (!t.get('live')) {
      return interaction.reply({
        content: '❌ Live mode is off, so arming would change nothing. Press **Go live** first, ' +
          'then **Arm**.\n\nTwo switches on purpose: live is "I intend to trade real money", ' +
          'armed is "I am watching right now".',
        flags: MessageFlags.Ephemeral
      });
    }
    t.set('armed', 'on');
    await ackUpdate(interaction);
    await interaction.editReply(await panel.mainPayload(t));

    // Arming an account that cannot afford one contract is not an error, but every order it
    // places will be refused by Kalshi — so it is said here rather than discovered as a stream of
    // rejections. The cheapest entry this bot will take is 25c, so that is the floor to compare.
    const bal = await panel.balanceFor(t);
    const aff = panel.affordability(t, bal);
    // The size that will actually be used, not the fixed setting auto size is overriding. Saying
    // "buys 30 contracts" while the sizer had resolved 7 is the confirmation contradicting the
    // settings screen it was launched from.
    const shares = panel.resolvedShares(t) || 0;
    const auto = t.get('autoShares') === true;
    const cheapest = aff ? aff.cheapest : +(shares * 0.25).toFixed(2);
    const short = Boolean(aff);
    return interaction.followUp({
      content: `🔴 **Armed.** The next qualifying signal buys **${shares} contracts** with real ` +
        `money` + (auto ? ` (auto size, ${t.fmt('riskPerTrade')} risk)` : '') + `.\n\n` +
        (aff && aff.kind === 'concentrated'
          ? `⚠️ One trade is **${aff.sharePct}% of your ${users.money(aff.dollars)}** — ` +
            `${shares} contracts costs up to ${users.money(aff.worst)} at 80¢. A binary loses the ` +
            `whole stake, so two losses in a row at this size is the account. ` +
            `**${aff.safer} contracts** keeps one trade under half.\n\n`
          : aff
            ? `⚠️ Your balance is **${users.money(aff.dollars)}** and ${shares} contracts costs ` +
              `**${users.money(aff.cheapest)}** at 25¢ up to **${users.money(aff.worst)}** at 80¢. ` +
              `Most signals price 60–80¢, so those orders will be refused for insufficient funds. ` +
              `Set **Shares per trade** to **${aff.safer}** to trade the whole band, or fund the ` +
              `account — paper keeps running either way.\n\n`
            : '') +
        `Arming does not survive a restart — a redeploy or a crash brings you back in paper.`,
      flags: MessageFlags.Ephemeral
    });
  }
}

client.once(Events.ClientReady, async c => {
  line(`  Discord: connected as ${c.user.tag}`);
  try { await registerCommands(c.application.id); }
  catch (e) { line(`  !! could not register /dashboard: ${e.message}`); }

  // Started after Discord so its log lines have somewhere to go and the banner is already out.
  // TRADER=off runs the panel alone, which is what iterating on the UI wants.
  // The only delivery path notify has. It is handed a DM function and nothing else, so a
  // position can never be posted to a channel — a structural fact rather than a convention.
  notify.init({
    log: line,
    dm: async (userId, payload) => {
      const user = await c.users.fetch(userId);
      if (!user) return false;
      await user.send(payload);
      return true;
    }
  });

  if (process.env.TRADER === 'off') {
    line('  trader: OFF (TRADER=off) — panel only, no scanning');
  } else {
    trader.start({ log: line });
  }
  // Served from THIS process, so the site reads the same in-memory book the trader writes and
  // cannot disagree with the Discord panel. The old server.js read state.json off disk, which is
  // one restart away from showing a stale file.
  site.start({ log: line });

  // Told, not left to be inferred. Anybody the restart disarmed hears why, once, so paper fills
  // arriving on an account they armed cannot read as the bot disarming itself.
  for (const uid of (store.forcedDisarm || [])) {
    notify.forcedDisarm(uid).catch(() => {});
  }
  if ((store.forcedDisarm || []).length) {
    line(`  told ${store.forcedDisarm.length} user(s) they were disarmed by this restart`);
  }
  line('  ready — DM the bot and run /dashboard');
});

client.on(Events.InteractionCreate, async interaction => {
  if (!panel.owns(interaction)) return;
  await handle(interaction);
});

panel.init({ log: line });
client.login(DISCORD_TOKEN).catch(e => {
  line(`!! Discord login failed: ${e.message}`);
  line('   The token is probably wrong or has been regenerated.');
  process.exit(1);
});
