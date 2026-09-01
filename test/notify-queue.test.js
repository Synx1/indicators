/**
 * The DM queue.
 *
 * Twenty accounts filling on seven markets is a hundred and forty DMs inside one scan pass.
 * Discord answers a burst like that with 429s, and discord.js handles a 429 by waiting — inside
 * whatever awaited the send. That await is in the trading loop, and a pass held open is a pass
 * whose spot price goes stale, which is the failure that cost this bot 85% of its bankroll once.
 *
 * So two properties matter here and neither is visible in production until it hurts: the sends are
 * SPACED, and the caller does not WAIT for them.
 *
 * Run: node test/notify-queue.test.js
 */
const assert = require('assert');
const notify = require('../src/notify');

let checks = 0;
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what}: got ${a}, want ${b}`); checks++; };

(async () => {
  // ── the caller is not made to wait ──
  const sent = [];
  notify.init({ gapMs: 40, log: () => {}, dm: async (userId) => { sent.push(userId); return true; } });

  const t0 = Date.now();
  for (const id of ['a', 'b', 'c', 'd', 'e']) await notify.forcedDisarm(id);
  const callerMs = Date.now() - t0;
  assert.ok(callerMs < 40, `five sends returned to the caller immediately (took ${callerMs}ms)`);
  checks++;
  assert.ok(sent.length < 5, `and delivery had not finished yet (${sent.length} of 5 delivered)`);
  checks++;
  eq(notify.pending() > 0, true, 'so the queue reports what is still waiting');

  await notify.drain();
  eq(sent.join(''), 'abcde', 'delivery is in the order the sends were made');
  const drainMs = Date.now() - t0;
  assert.ok(drainMs >= 40 * 4, `and was spaced out, not flushed at once (${drainMs}ms)`); checks++;
  eq(notify.pending(), 0, 'the queue empties');

  // ── one undeliverable DM must not block the rest ──
  const after = [];
  notify.init({
    gapMs: 1,
    log: () => {},
    dm: async userId => {
      if (userId === 'closed-dms') throw new Error('50007: cannot send messages to this user');
      after.push(userId);
      return true;
    }
  });
  for (const id of ['x', 'closed-dms', 'y', 'z']) await notify.forcedDisarm(id);
  await notify.drain();
  eq(after.join(''), 'xyz', 'the sends after a permanent failure still went out');
  eq(notify.pending(), 0, 'and the queue did not wedge on it');

  // ── a queue that cannot drain drops rather than growing without limit ──
  const deep = [];
  notify.init({ gapMs: 0, log: () => {}, dm: async userId => { deep.push(userId); return true; } });
  let accepted = 0, dropped = 0;
  for (let i = 0; i < 205; i++) {
    // Not awaited: this is the burst case, all enqueued inside one tick.
    if (notify.forcedDisarm(`u${i}`) === false) dropped++;
  }
  // forcedDisarm is async, so its return value is a promise; the drop shows up as a queue cap.
  accepted = notify.pending();
  assert.ok(accepted <= 200, `the queue is capped at 200, not ${accepted}`); checks++;
  await notify.drain();
  assert.ok(deep.length <= 200, `at most 200 were delivered, not ${deep.length}`); checks++;
  assert.ok(deep.length >= 100, `and the cap did not swallow nearly everything (${deep.length})`);
  checks++;

  // ── the missed-fill DM shows where the price WENT, when it can ──
  //
  // The message names Slippage allowance as the fix, and that advice is only sound when the reader
  // can see how far the book moved: "now 46¢" means one more cent catches it, "now 82¢" means no
  // slippage would have and chasing it is throwing money after a jump. So the now-price is not
  // decoration — it is the number that tells those two cases apart. When the book cannot be re-read
  // the figure is simply absent rather than shown as a misleading zero.
  const grab = [];
  notify.init({ gapMs: 0, log: () => {}, dm: async (userId, payload) => { grab.push(payload); return true; } });
  const d = { sym: 'SOL', direction: 'DOWN', price: 0.44 };

  await notify.missedFill({ userId: 'u' }, d, { limitCents: 45, nowCents: 82 });
  await notify.drain();
  let val = grab[0].embeds[0].data.fields[0].value;
  assert.ok(/wanted \*\*44¢\*\*/.test(val), `the DM states what was wanted (${val})`); checks++;
  assert.ok(/limit \*\*45¢\*\*/.test(val), 'and the limit that was placed'); checks++;
  assert.ok(/now \*\*82¢\*\*/.test(val), 'and where the price is NOW, so the slippage advice is judgeable'); checks++;

  grab.length = 0;
  await notify.missedFill({ userId: 'u' }, d, { limitCents: 45, nowCents: null });
  await notify.drain();
  val = grab[0].embeds[0].data.fields[0].value;
  assert.ok(!/now \*\*/.test(val), 'with no readable book the now-price is omitted, not shown as 0¢'); checks++;
  assert.ok(!/undefined|NaN/.test(val), 'and nothing leaks undefined/NaN into a money message'); checks++;

  console.log(`PASS notify-queue — ${checks} assertions (spaced, ordered, non-blocking, capped, now-price)`);
})().catch(e => { console.error(e); process.exit(1); });
