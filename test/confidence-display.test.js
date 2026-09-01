/**
 * The DM must never print the model's confidence as if it were the probability.
 *
 * Measured over the 1,806-market corpus, the printed model figure averages 87.5% in the band this bot
 * trades while those entries settle at 68.2%. A "4/4 at 85%" reading as near-certain is how a
 * coin-flip-plus-a-hair bet gets mistaken for a lock, so the book's own number — the price paid — has
 * to travel beside it.
 */
const assert = require('assert');
const notify = require('../src/notify');

let captured = null;
notify.init({ dm: async (_id, payload) => { captured = payload; return true; }, log: () => {}, gapMs: 0 });

const position = over => ({
  sym: 'BNB', direction: 'DOWN', confidence: 85, confirm: 4, contracts: 10,
  price: 0.66, cost: 6.60, entryFee: 0.16, total: 6.76, style: 'MOMENTUM',
  pnl: -6.76, entryFee2: 0, ...over
});

(async () => {
  // ── entry ──
  await notify.entry({ userId: 'u1' }, position(), { live: true });
  await notify.drain();
  let e = captured.embeds[0].data;
  assert.ok(/model 85%/.test(e.description), 'the model figure must be labelled as the model’s');
  assert.ok(/book 66%/.test(e.description), 'the price paid is a probability and must be shown');
  assert.ok(!/·\s*85%\s*·\s*4\/4/.test(e.description), 'an unlabelled bare confidence is the thing being fixed');
  const body = e.fields[0].value;
  assert.ok(/the price says 66%/.test(body));
  // The claim must be about which forecast is better where they disagree, not about the model being
  // "optimistic" — measured over 68 days the model is if anything cold, and the earlier wording was a
  // 44-row artifact stated as a property of the model.
  assert.ok(/the price is the better forecast/.test(body), 'the DM must name which number to trust');
  assert.ok(!/optimistic/.test(body), 'the retracted 19-points-hot framing must not come back');

  // The book number is derived from the fill, so a different fill must move it.
  await notify.entry({ userId: 'u1' }, position({ price: 0.41 }), { live: false });
  await notify.drain();
  assert.ok(/book 41%/.test(captured.embeds[0].data.description));

  // ── settlement carries the same pairing, so the record reads honestly after the fact ──
  await notify.settled({ userId: 'u1' }, position(), false);
  await notify.drain();
  const settledBody = captured.embeds[0].data.fields[0].value;
  assert.ok(/model 85%/.test(settledBody), 'a graded loss must still show which number was optimistic');
  assert.ok(/book 66%/.test(settledBody));

  // A missing or malformed price must print nothing, not a number. Number(null) is 0, so the naive
  // version renders "book 0%" — the market declaring the bet impossible — which is worse than a dash.
  for (const bad of [null, undefined, '', 'x', NaN]) {
    await notify.entry({ userId: 'u1' }, position({ price: bad }), { live: false });
    await notify.drain();
    const text = JSON.stringify(captured);
    assert.ok(!/NaN/.test(text), `NaN reached the user for price=${String(bad)}`);
    assert.ok(!/book 0%/.test(text), `a missing price rendered as "book 0%" for price=${String(bad)}`);
    assert.ok(/book —/.test(text), `a missing price must render as a dash for price=${String(bad)}`);
  }

  console.log('PASS confidence-display — model and book figures are shown side by side, never a bare confidence');
})().catch(e => { console.error(e); process.exit(1); });
