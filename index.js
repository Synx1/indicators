/**
 * The bot process: Discord client, slash command, and the interaction boundary.
 *
 * Separate from bot.js (the trading loop) so the panel can be run and tested on its own. Neither
 * one places an order yet — execution lands next.
 */

const {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  SlashCommandBuilder, MessageFlags, InteractionContextType
} = require('discord.js');

const { DISCORD_TOKEN, OWNER_ID, DATA_DIR, DATA_DIR_SOURCE, KEY_DIR } = require('./src/config');
const users = require('./src/users');
const settings = require('./src/settings');
const auth = require('./src/kalshiauth');
const kt = require('./src/kalshitrade');
const panel = require('./src/panel');

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
line(`  Key secret ${process.env.KALSHI_KEY_SECRET ? 'KALSHI_KEY_SECRET is set'
  : 'generated file beside the store — set KALSHI_KEY_SECRET to separate them'}`);
line(`  Owner      ${OWNER_ID}`);
line('='.repeat(78));

auth.init();
users.init({ log: line });

const client = new Client({
  // DM-only, so no guild intents and no message content. The panel never reads a message; it
  // only answers interactions, which is the smallest permission surface that can work.
  intents: [GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

const command = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('Your balance, positions, P&L and controls')
  // Declared DM-only to Discord as well as enforced below. The panel shows a balance and open
  // positions; in a server an ephemeral reply is one misclick from a screenshot.
  .setContexts(InteractionContextType.BotDM);

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
      if (!settings.SCHEMA[key]) return; // unknown key: the boundary explains it as stale
      // A boolean has nothing to type. Toggling is one press instead of a modal asking for
      // "on" — the kind of friction that makes a panel feel like paperwork.
      if (settings.SCHEMA[key].type === settings.TYPE.BOOL) {
        const next = t.get(key) ? 'off' : 'on';
        t.set(key, next);
        await interaction.deferUpdate();
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
      if (!spec) return;
      const raw = interaction.fields.getTextInputValue('value');
      const res = t.set(key, raw);
      if (!res.ok) {
        return interaction.reply({ content: `❌ **${spec.label}**: ${res.why}`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({
        content: `✅ **${spec.label}** is now **${t.fmt(key)}**` +
          (res.was == null && res.value != null ? '' : ''),
        flags: MessageFlags.Ephemeral
      });
    }
  }

  if (!interaction.isButton()) return;

  if (id === `${panel.ID}:home` || id === `${panel.ID}:refresh`) {
    await interaction.deferUpdate();
    return interaction.editReply(await panel.mainPayload(t));
  }
  if (id === `${panel.ID}:settings`) {
    await interaction.deferUpdate();
    return interaction.editReply(panel.settingsPayload(t));
  }
  if (id === `${panel.ID}:trades`) {
    await interaction.deferUpdate();
    return interaction.editReply(panel.tradesPayload(t));
  }
  if (id === `${panel.ID}:live`) {
    t.set('live', t.get('live') ? 'off' : 'on');
    // Going back to paper disarms too. Leaving `armed` set on a paper account means the next
    // flip to live is instantly hot, which is not what anybody pressing "Go paper" intends.
    if (!t.get('live')) t.set('armed', 'off');
    await interaction.deferUpdate();
    return interaction.editReply(await panel.mainPayload(t));
  }
  if (id === `${panel.ID}:arm`) {
    if (t.get('armed')) {
      t.set('armed', 'off');
      await interaction.deferUpdate();
      return interaction.editReply(await panel.mainPayload(t));
    }
    // Refusals name the missing thing rather than saying no.
    if (!auth.isImported(t.userId)) {
      return interaction.reply({
        content: '❌ No Kalshi key imported, so there is nothing to arm. Press **Import key** first.',
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
    await interaction.deferUpdate();
    await interaction.editReply(await panel.mainPayload(t));
    return interaction.followUp({
      content: `🔴 **Armed.** The next qualifying signal buys ${t.fmt('shares')} contracts with ` +
        `real money.\n\nArming does not survive a restart — a redeploy or a crash brings you ` +
        `back in paper.`,
      flags: MessageFlags.Ephemeral
    });
  }
}

client.once(Events.ClientReady, async c => {
  line(`  Discord: connected as ${c.user.tag}`);
  try { await registerCommands(c.application.id); }
  catch (e) { line(`  !! could not register /dashboard: ${e.message}`); }
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
