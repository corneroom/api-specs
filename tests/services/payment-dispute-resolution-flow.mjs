// payment-service × booking-service — CR-650 / CR-679: what happens when a card
// dispute CLOSES. The other half of services/payment-dispute-flow.mjs, which
// stops at "the dispute is open and the money is frozen" (AC1).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SEPARATE, GATED FILE
//
// Closing a test-mode dispute needs a Stripe **secret** key, and asserting on
// payouts needs Firestore: there is no app-gateway endpoint that returns a
// `payouts` row or a `refund_requests` row. Both are capabilities the 6-hourly
// CI run deliberately does not have, so every case here SKIPS cleanly without
// them (lib/skip.mjs) rather than failing. Locally, with tests/.env carrying
// STRIPE_SECRET_KEY and gcloud ADC active, all four run for real.
//
// It is also slow by construction — four real Stripe-sandbox bookings, two
// fast-forwards, a real completion sweep and two dispute closures — which is
// the second reason it is not folded into payment-dispute-flow.mjs.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY FOUR BOOKINGS
//
// A dispute's outcome touches two different pots of money, and they need
// mutually exclusive booking states:
//   · the GUEST's held refund — only exists if the booking was CANCELLED while
//     the dispute was open (payment_dispute.go `holdRefundForDispute`);
//   · the HOST's payout — only exists if the booking COMPLETED
//     (payment.go `handleBookingCompleted`).
// A booking cannot be both. So each outcome (won / lost) needs one cancelled
// booking and one completed booking: 4 in total, all booked by ONE throwaway
// guest (registering four would cost eight requests against user-service's
// 10/min auth limit — see lib/booking-flow.mjs).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A BOOKING GETS FAST-FORWARDED
//
// The payout only appears once booking-service's auto-complete sweep runs, and
// that sweep selects `status == Confirmed AND check_out <= now - 24h`
// (booking_completion.go:81) on a DAILY schedule (`auto-complete-booking-job`,
// 0 9 * * * UTC). Every fixture here is booked ~a year out. So the flow moves
// the stay into the past (lib/firestore.mjs `fastForwardBookingToCompletion`,
// mirroring test-data/scripts/fast-forward-bookings.js field for field) and
// then triggers the real sweep through Cloud Scheduler
// (lib/staging-jobs.mjs). Nothing is bypassed: the same job, the same handler,
// the same booking_completed event.
//
// A side benefit for leak discipline: a fast-forwarded booking's dates are in
// the PAST, so the completed bookings this flow leaves behind occupy no future
// availability on the shared staging fixtures.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULES BEING ASSERTED, AND WHERE THEY COME FROM
//
// AC2 — a dispute that is open when the booking completes must make the payout
//   created at that moment a BLOCKED, DISPUTE-FLAGGED payout. The host must not
//   be paid out of a charge the bank may still claw back. The dispute half of
//   that (`has_dispute: true` + `dispute_info`) is the load-bearing assertion:
//   `status: blocked` on its own is NOT evidence here, because this suite's bot
//   hosts have no payout method (see FIXTURE LIMITATION below) and that alone
//   already blocks the row.
//
// AC3 — dispute LOST is terminal and pays the guest nothing further. The card
//   network has already returned the money, so:
//     · the held refund_request goes to `settled_by_chargeback`, NEVER
//       `refunded` — we must not also send a refund (payment_dispute.go:389);
//     · the payout stays BLOCKED (`resolvePayoutsForDispute`, the non-won
//       branch: has_dispute stays true, last_error records the loss).
//
// AC4 — dispute WON: the provider ruled for the host, so the charge stands.
//     · The held refund is CLOSED WITHOUT PAYING: refund_request →
//       `rejected`, ledger row → `cancelled` / "No refund".
//       ⚠ NOTE THE DIRECTION. The original CR-612 design (2026-08-27) paid the
//       held policy refund on a win; that was SUPERSEDED on 2026-09-01 and the
//       reasoning is written into payment_dispute.go:353-362 — paying both
//       would make disputing risk-free for the guest (worst case they keep the
//       policy refund, best case the chargeback pays more). This file asserts
//       the rule as it actually stands. If the product decision is ever
//       reversed, change it here deliberately — do not "fix" it to match a
//       stale ticket.
//     · The dispute stops blocking the payout: `has_dispute` → false and
//       `dispute_info.status` → won. (Whether the row then becomes `ready` is
//       a separate question for a host who HAS a payout method — see below.)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PAYOUT-METHOD FIXTURE — WHY THE COMPLETE TRACK PICKS A SPECIFIC HOST
//
// Until 2026-09-15 no seeded bot host had a `payout_method` (only three users
// did, all REAL accounts including the owner's). Since the suite may only book
// bot hosts — every booking, payment and cancellation pushes the host a real
// notification, see lib/booking-flow.mjs — every payout it could create took
// payment-service's unconfigured-host branch
// (`CreatePayoutForUnconfiguredHost`) and was `blocked` with
// `last_error: host_payout_method_not_configured`. That made two claims
// vacuous: "blocked because of the dispute" (it was blocked anyway) and "a won
// dispute releases it" (the no-method block correctly survives the win).
//
// Fixed by fixture, not by loosening: test-data's
//   make seed-bot-host-payout-method apply=1
// gives ONE bot host `payout_method: paypal` + `payout_email` (the two fields
// booking-service's `readHostPayoutInfo` actually reads). PayPal, not Stripe,
// because a `stripe` method additionally needs a real Connect account on the
// user and Connect onboarding is a hosted web form that cannot be driven
// headless.
//
// The COMPLETE track discovers that host at run time
// (`findBotHostsWithPayoutMethod`) and books ITS listing, so it can assert the
// strong forms: AC2 `blocked` *for the dispute* (with `last_error` naming the
// dispute, not the missing method) and AC4 released to `ready`.
//
// ⚠ It asserts `ready`, NOT "paid". A `paypal`-method payout that reaches
// `ready` and is eligible WILL be dispatched by the nightly
// daily-payout-processing job as a real PayPal SANDBOX payout. Asserting the
// dispatch would mean waiting for a 02:00 UTC job and would spend sandbox
// balance; `ready` is the state the dispute is responsible for.
//
// If the fixture is missing (a staging reseed drops it), the complete track
// SKIPS with the make target to run — it does not silently fall back to a
// method-less host and assert the weak form.
//
// ─────────────────────────────────────────────────────────────────────────────
// EXPECTED-RED HISTORY (measured on staging 2026-09-15, payment-service-00251-jfp,
// i.e. BEFORE the fix — kept because it is why these assertions are shaped this way)
//
// The three PAYOUT assertions (AC2, AC3-host, AC4-host) are written for the
// behaviour the product must have and fail today. The two GUEST-money
// assertions (AC3-guest, AC4-guest) pass. What was actually observed, on
// payout row for booking Erd4mIZHh9puYOjw9aEE:
//
//   status: "blocked", last_error: "host_payout_method_not_configured",
//   has_dispute: false, dispute_info: absent,
//   payment_intent_id: "", transaction_id: ""
//
// Two distinct defects, and the ORDER matters because the first makes the
// second unfixable on its own:
//   1. the payout is created with an EMPTY payment_intent_id. Every
//      dispute↔payout lookup in payment-service goes through
//      `GetPayoutsByPaymentIntentID` (`blockPayoutsForDispute` AND
//      `resolvePayoutsForDispute`), so this payout is permanently invisible to
//      every dispute webhook — before and after the close. The auto-complete
//      sweep's `booking_completed` event simply does not carry
//      payment_intent_id or transaction_id (booking-service
//      `completeBookingAndPublish` in internal/service/booking_completion.go;
//      the manual-complete path DOES carry them).
//   2. the unconfigured-host creation path never consults the charge's dispute
//      state at all — `blockPayoutIfTransactionDisputed` is called only on the
//      configured-host branch of `handleBookingCompleted` (payment-service
//      internal/service/payment.go).
//
// This is NOT a fresh diagnosis: payment-service commits `1a91473` + `1370b00`
// already fix it by resolving the intent from the booking's own transaction
// before the payout is created, and they are now LIVE on staging (revision
// payment-service-00252-ksw). The numbers above were measured against the
// pre-fix revision, so these cases ARE the verification vehicle for that fix.
// Do NOT loosen them.
//
// This suite's own baseline for the flow is commit 25f48af.
//
// ─────────────────────────────────────────────────────────────────────────────
// RESIDUE (deliberate, documented)
//   · 4 Stripe sandbox disputed charges per run — 2 closed won, 2 closed lost.
//   · 2 cancelled bookings (torn down and verified) + 2 COMPLETED bookings that
//     cannot be torn down by design. Their dates are in the past, so they block
//     no availability; they leave one payouts row each.
//   · one throwaway qa+<digits>@bot.com guest.
// Because of that cost, this flow is BEHIND ITS OWN GATE and is NOT part of a
// normal `make test-gateway` even when the Stripe secret is present:
//
//     make test-gateway-dispute        # runs the whole suite with DISPUTE_FLOW=1
//     DISPUTE_FLOW=1 node tests/run.mjs
//
// Without `DISPUTE_FLOW=1` every case skips. A plain `make test-gateway` must
// stay a few minutes long and must not burn four Stripe sandbox bookings, a
// scheduler sweep run and two irreversible dispute closures.
import {
  registerFreshUser,
  pickListings,
  pickListingHostedBy,
  bookAndConfirm,
  getBooking,
  cancelBooking,
  teardownBooking,
} from '../lib/booking-flow.mjs';
import { getBookingTransactions } from '../lib/payment-helpers.mjs';
import { poll } from '../lib/poll.mjs';
import { skip } from '../lib/skip.mjs';
import { requireStripeSecret, findDisputeForIntent, closeDisputeWon, closeDisputeLost } from '../lib/stripe-dispute.mjs';
import {
  firestore,
  fastForwardBookingToCompletion,
  getRefundRequestsByBookingId,
  getUserPayoutMethod,
  findBotHostsWithPayoutMethod,
} from '../lib/firestore.mjs';
import { runAutoCompleteSweep } from '../lib/staging-jobs.mjs';
import { theRefundRequest, thePayout, theRefundLedgerRow } from '../lib/money-rows.mjs';

const ctx = { bookings: {} };

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const OPEN_DISPUTE_STATUSES = ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review'];

// ─── gating ─────────────────────────────────────────────────────────────────
//
// Two different gates, and the distinction is the whole point:
//
//   · MISSING CAPABILITY (no DISPUTE_FLOW opt-in, no Stripe secret, no
//     Firestore, no payout-method fixture) → skip. Nothing was attempted.
//   · SETUP FAILED FOR A PRODUCT REASON (a booking would not confirm, a dispute
//     never landed) → the dependent cases must FAIL, not skip. A skip there
//     would hide a real regression behind a ⏭, which is exactly what
//     lib/skip.mjs forbids.
//
// `ctx.setupSkipReason` is set only on the first kind; `ctx.setupError` on the
// second.
function requireGate() {
  if (process.env.DISPUTE_FLOW !== '1') {
    skip(
      'DISPUTE_FLOW=1 not set — this flow books four real Stripe-sandbox stays, runs the completion sweep and closes ' +
        'two disputes irreversibly (~15 min). Run it deliberately: `make test-gateway-dispute`'
    );
  }
  requireStripeSecret();
}

// Every case after setup depends on the four fixtures. Distinguish "setup never
// ran" (skip) from "setup broke" (fail) so a product failure can never hide
// behind a ⏭.
function requireFixtures() {
  requireGate();
  if (ctx.setupSkipReason) skip(ctx.setupSkipReason);
  if (ctx.setupError) {
    throw new Error(`setup failed, so this case could not run: ${ctx.setupError}`);
  }
  for (const key of ['lostCancel', 'wonCancel', 'lostComplete', 'wonComplete']) {
    if (!ctx.bookings[key]?.disputeId) {
      throw new Error(`setup did not produce the ${key} fixture — see the setup case above`);
    }
  }
}

// Wrap a setup step so the reason it stopped is recorded in the right bucket.
async function runSetup(fn) {
  try {
    await fn();
  } catch (e) {
    if (e.skip === true) {
      ctx.setupSkipReason = e.message;
      throw e;
    }
    ctx.setupError = e.message;
    throw e;
  }
}

// ─── fixtures ───────────────────────────────────────────────────────────────

// One paid, confirmed, disputed booking. The booking id is recorded in
// ctx.bookings[key] the instant the draft exists (bookAndConfirm's onDraft), so
// cleanup can always find it even if payment or finalize throws.
async function bookDisputedStay(key, listing) {
  const entry = { id: null, listing, total: 0, intentId: null, disputeId: null };
  ctx.bookings[key] = entry;

  const { bookingId, total, intentId } = await bookAndConfirm(ctx.guest.tokens, listing, {
    guestId: ctx.guest.id,
    hostId: listing.host.id,
    currency: listing.currency,
    cardToken: 'tok_createDispute',
    onDraft: (id) => {
      entry.id = id;
    },
  });
  entry.id = bookingId;
  entry.total = total;
  entry.intentId = intentId;

  // Stripe raises the dispute a few seconds after capture; wait for OUR side to
  // have recorded it before anything depends on it.
  await poll(
    async () => {
      const b = await getBooking(ctx.guest.tokens, bookingId);
      return { done: b.has_dispute === true, value: b.has_dispute };
    },
    { timeoutMs: 180000, intervalMs: 5000, desc: `booking ${bookingId} to be flagged has_dispute` }
  );
  const dispute = await poll(
    async () => {
      const d = await findDisputeForIntent(intentId);
      return { done: !!d, value: d };
    },
    { timeoutMs: 120000, intervalMs: 5000, desc: `Stripe to raise a dispute on ${intentId}` }
  );
  entry.disputeId = dispute.id;
  console.log(`    · ${key}: booking ${bookingId}, intent ${intentId}, dispute ${dispute.id} (${dispute.status})`);
  return entry;
}

// Both complete-track stays go on the ONE payout-method-configured bot host's
// listing, so `futureDates()` can collide. Retry with fresh dates rather than
// failing the run over an availability clash on a shared fixture.
async function bookDisputedStayOnHostListing(key, listing, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await bookDisputedStay(key, listing);
    } catch (e) {
      const collision = /not available|availability|overlap/i.test(e.message);
      if (!collision || i === attempts) throw e;
      console.log(`    · ${key}: date collision on ${listing.id} (attempt ${i}), retrying with fresh dates`);
    }
  }
}

// Cancel while the dispute is open → the refund must be PARKED, not sent.
// (AC1's rule; asserted here as the precondition the outcome cases resolve.)
async function cancelAndExpectHold(key) {
  const entry = ctx.bookings[key];
  await cancelBooking(ctx.guest.tokens, entry.id);
  entry.cancelled = true;
  const held = await poll(
    async () => {
      const all = await getRefundRequestsByBookingId(entry.id);
      const r = all.find((x) => x.status === 'held_dispute');
      return { done: !!r, value: r ?? all };
    },
    { timeoutMs: 120000, intervalMs: 5000, desc: `a held_dispute refund_request for booking ${entry.id}` }
  );
  // Re-read through the exactly-one selector: a duplicate request for one
  // booking is a real bug (they are keyed `<bookingId>_cancel`) and must fail
  // loudly rather than be hidden by the `.find()` above.
  const only = await theRefundRequest(entry.id);
  // Recorded so every later assertion is pinned to THIS row (see money-rows.mjs).
  entry.refundRequestId = only.id;
  return only;
}

// Complete the confirmed bookings for real: move the stays into the past, then
// run booking-service's own sweep. Asserts the BOOKING completed first, so a
// slow or capped sweep is attributed to the sweep rather than to
// payment-service's payout creation.
async function completeAndAwaitPayout(keys) {
  for (const key of keys) {
    const entry = ctx.bookings[key];
    const { checkOut } = await fastForwardBookingToCompletion(entry.id);
    console.log(`    · ${key}: booking ${entry.id} fast-forwarded, check_out=${checkOut.toISOString()}`);
  }
  await runAutoCompleteSweep();

  for (const key of keys) {
    const entry = ctx.bookings[key];
    await poll(
      async () => {
        const b = await getBooking(ctx.guest.tokens, entry.id);
        return { done: b.status === 'completed', value: b.status };
      },
      {
        timeoutMs: 120000,
        intervalMs: 5000,
        desc:
          `booking ${entry.id} to be COMPLETED by the auto-complete sweep (the scheduler target is capped at ` +
          `?limit=100, so a busy staging backlog can leave this booking for the next run — that is a sweep problem, ` +
          `not a payout problem)`,
      }
    );
  }

  const payouts = {};
  for (const key of keys) {
    const entry = ctx.bookings[key];
    payouts[key] = await poll(
      async () => {
        const p = await thePayout(entry.id);
        return { done: !!p, value: p };
      },
      { timeoutMs: 180000, intervalMs: 6000, desc: `a payouts row for completed booking ${entry.id}` }
    );
    entry.payoutId = payouts[key].id;
  }
  return payouts;
}

// The dispute close is a webhook round-trip; poll our own state, not Stripe's.
const pollRefundRequest = (entry, want, desc) =>
  poll(
    async () => {
      const r = await theRefundRequest(entry.id, { expectId: entry.refundRequestId });
      return { done: want.includes(r.status), value: r };
    },
    { timeoutMs: 150000, intervalMs: 5000, desc }
  );

const pollPayout = (bookingId, done, desc) =>
  poll(
    async () => {
      const p = await thePayout(bookingId);
      return { done: !!p && done(p), value: p };
    },
    { timeoutMs: 150000, intervalMs: 5000, desc }
  );

// The guest-visible refund ledger row, and its Firestore twin. Both are read
// because they answer different questions: the gateway row is what the guest
// sees, the Firestore row carries `refund_id` (where a `chargeback:<id>` marker
// lands — it is on the LEDGER row, not on the refund_request).
async function refundRows(bookingId) {
  const viaGateway = (await getBookingTransactions(ctx.guest.tokens, bookingId)).filter((t) => t.type === 'refund');
  const viaFirestore = await theRefundLedgerRow(bookingId);
  return { viaGateway, viaFirestore };
}

export default {
  name: 'payment-service × booking-service (CR-650/CR-679 dispute resolution: the held refund and the host payout)',
  cases: [
    {
      name: 'setup: four disputed, paid stays — two to cancel, two to complete on a payout-configured host',
      run: () =>
        runSetup(async () => {
          // Capability gates first: fail fast on a live key, skip on no opt-in /
          // no key / no Firestore, before creating anything on Stripe.
          requireGate();
          firestore();

          // The complete track NEEDS a host with a payout method, or its
          // assertions are vacuous (see the header). Resolve it before spending
          // anything.
          const configured = await findBotHostsWithPayoutMethod();
          if (!configured.length) {
            skip(
              'no seeded bot host has a payout_method, so "the payout is blocked BY THE DISPUTE" and "a won dispute ' +
                'releases it" cannot be proven. Seed one: in test-data, `make seed-bot-host-payout-method apply=1`'
            );
          }
          ctx.payoutHost = configured[0];
          console.log(
            `    · payout-configured bot host: ${ctx.payoutHost.id} (${ctx.payoutHost.email}) ` +
              `method=${ctx.payoutHost.payoutMethod}`
          );

          ctx.guest = await registerFreshUser('DisputeResolution');

          // full_refund_24h for the cancel track: the held amount must be the
          // FULL total, or "the refund was held" is a claim about nothing.
          const [lostCancelListing, wonCancelListing] = await pickListings(ctx.guest.tokens, 2, {
            minPrice: 1,
            policy: 'full_refund_24h',
          });
          // The complete track must be on the configured host's own listing.
          const hostListing = await pickListingHostedBy(ctx.guest.tokens, ctx.payoutHost.id);

          await bookDisputedStay('lostCancel', lostCancelListing);
          await bookDisputedStay('wonCancel', wonCancelListing);
          await bookDisputedStayOnHostListing('lostComplete', hostListing);
          await bookDisputedStayOnHostListing('wonComplete', hostListing);

          ctx.hostPayoutMethods = {};
          for (const key of ['lostComplete', 'wonComplete']) {
            const hostId = ctx.bookings[key].listing.host.id;
            ctx.hostPayoutMethods[key] = (await getUserPayoutMethod(hostId)) || '(none)';
          }
          assert(
            Object.values(ctx.hostPayoutMethods).every((m) => m && m !== '(none)' && m !== 'not_specified'),
            `the complete-track host must have a payout method, got ${JSON.stringify(ctx.hostPayoutMethods)}`
          );
        }),
    },
    {
      name: 'setup: cancelling both cancel-track stays during the open dispute parks the full refund (AC1 precondition)',
      run: async () => {
        requireFixtures();
        for (const key of ['lostCancel', 'wonCancel']) {
          const entry = ctx.bookings[key];
          const held = await cancelAndExpectHold(key);
          assert(
            Math.abs(held.suggested_amount - entry.total) < 0.005,
            `${key}: expected the full ${entry.total} policy refund parked (full_refund_24h, ~a year out), got ${held.suggested_amount}`
          );
          const { viaGateway } = await refundRows(entry.id);
          assert(viaGateway.length === 1, `${key}: expected exactly one refund ledger row, got ${JSON.stringify(viaGateway)}`);
          assert(
            viaGateway[0].status === 'on_hold',
            `${key}: the guest-visible refund row must be on_hold while the dispute is open, got '${viaGateway[0].status}'`
          );
        }
      },
    },
    {
      // AC2. With a payout-method-configured host, `blocked` is now real
      // evidence — the no-method reason is gone, so the only thing that can
      // block this row is the dispute.
      name: 'AC2: a stay that completes while its dispute is OPEN creates a payout linked to the charge and blocked BY THE DISPUTE',
      run: async () => {
        requireFixtures();
        const payouts = await completeAndAwaitPayout(['lostComplete', 'wonComplete']);
        const problems = [];
        for (const [key, payout] of Object.entries(payouts)) {
          const entry = ctx.bookings[key];
          console.log(
            `    · ${key}: payout ${payout.id} status=${payout.status} has_dispute=${payout.has_dispute} ` +
              `method=${payout.payout_method} payment_intent_id=${JSON.stringify(payout.payment_intent_id)} ` +
              `last_error=${JSON.stringify(payout.last_error || '')}`
          );
          // Collected rather than thrown, so ONE case reports everything wrong
          // with BOTH payouts instead of stopping at the first.
          if (payout.status !== 'blocked') {
            problems.push(
              `${key}: a payout created while the charge is disputed must not be payable — expected status='blocked', ` +
                `got '${payout.status}'`
            );
          }
          if (/host_payout_method_not_configured/.test(payout.last_error || '')) {
            problems.push(
              `${key}: payout ${payout.id} was blocked for a MISSING PAYOUT METHOD, not for the dispute — the fixture ` +
                `host ${entry.listing.host.id} was supposed to have one, so this case is no longer proving anything ` +
                `about disputes. Re-seed: test-data \`make seed-bot-host-payout-method apply=1\``
            );
            continue;
          }
          // The linkage assertion: every dispute↔payout lookup in
          // payment-service is keyed on payment_intent_id, so a payout without
          // one can never be blocked or released by a dispute webhook.
          if (!payout.payment_intent_id) {
            problems.push(
              `${key}: payout ${payout.id} was created with an EMPTY payment_intent_id (charge was ${entry.intentId}). ` +
                'Nothing can ever tie a dispute to this payout: both blockPayoutsForDispute and ' +
                'resolvePayoutsForDispute look payouts up by payment_intent_id.'
            );
            continue;
          }
          if (payout.payment_intent_id !== entry.intentId) {
            problems.push(
              `${key}: payout ${payout.id} points at payment_intent_id '${payout.payment_intent_id}' but the booking ` +
                `was paid by '${entry.intentId}'`
            );
            continue;
          }
          if (payout.has_dispute !== true) {
            problems.push(
              `${key}: payout ${payout.id} for disputed charge ${entry.intentId} was created with ` +
                `has_dispute=${payout.has_dispute}. The host must not be paid out of a charge the bank may claw back.`
            );
            continue;
          }
          if (payout.dispute_info?.dispute_id !== entry.disputeId) {
            problems.push(
              `${key}: expected dispute_info.dispute_id=${entry.disputeId} on the payout, got ${JSON.stringify(payout.dispute_info)}`
            );
          }
        }
        assert(problems.length === 0, problems.join(' | '));
      },
    },
    {
      name: 'AC3 (guest money): dispute LOST — the held refund settles as a chargeback and is never refunded again',
      run: async () => {
        requireFixtures();
        const entry = ctx.bookings.lostCancel;
        await closeDisputeLost(entry.disputeId);
        const req = await pollRefundRequest(
          entry,
          ['settled_by_chargeback', 'refunded', 'rejected'],
          `refund_request for ${entry.id} to leave held_dispute after the dispute was LOST`
        );
        assert(
          req.status === 'settled_by_chargeback',
          `a LOST dispute already returned the money via the card network — the held request must close as ` +
            `'settled_by_chargeback', never be paid again — got '${req.status}'`
        );
        assert(
          !req.refund_id,
          `a lost dispute must not record a provider refund on the refund_request; refund_id=${req.refund_id}`
        );

        const { viaGateway, viaFirestore } = await refundRows(entry.id);
        assert(viaGateway.length === 1, `expected the ONE held refund row to be closed in place, got ${viaGateway.length} refund rows`);
        // The POSITIVE lost state, not merely "not on_hold" — `!== 'on_hold'`
        // would also pass the WON behaviour (cancelled at 0), which is the
        // opposite money outcome.
        assert(
          viaGateway[0].status === 'completed',
          `a lost dispute means the guest HAS the money back (the card network returned it) — the refund row must read ` +
            `'completed', got '${viaGateway[0].status}'`
        );
        assert(
          Math.abs(viaGateway[0].amount - entry.total) < 0.005,
          `the chargeback returned the full ${entry.total} — expected the closed refund row at that amount, got ${viaGateway[0].amount}`
        );
        // `chargeback:<disputeId>` is recorded as the LEDGER row's refund_id
        // (closeHeldRow), which the gateway does not expose — hence the
        // Firestore read.
        assert(
          String(viaFirestore.refund_id || '') === `chargeback:${entry.disputeId}`,
          `the closed ledger row must record the chargeback that paid it — expected refund_id='chargeback:${entry.disputeId}', ` +
            `got '${viaFirestore.refund_id}'`
        );
      },
    },
    {
      name: 'AC3 (host money): dispute LOST — the payout stays blocked and stays flagged',
      run: async () => {
        requireFixtures();
        const entry = ctx.bookings.lostComplete;
        await closeDisputeLost(entry.disputeId);
        const payout = await pollPayout(
          entry.id,
          (p) => p.dispute_info?.status === 'lost' || /Dispute closed/i.test(p.last_error || ''),
          `payout for ${entry.id} to record the LOST outcome`
        );
        console.log(`    · lostComplete: payout ${payout.id} status=${payout.status} has_dispute=${payout.has_dispute}`);
        assert(
          payout.status === 'blocked',
          `a lost dispute means the host is not paid from this charge — payout must stay 'blocked', got '${payout.status}'`
        );
        assert(payout.has_dispute === true, `a lost dispute must leave the payout flagged, got has_dispute=${payout.has_dispute}`);
      },
    },
    {
      name: 'AC4 (guest money): dispute WON — the held refund closes WITHOUT paying the guest a second time',
      run: async () => {
        requireFixtures();
        const entry = ctx.bookings.wonCancel;
        await closeDisputeWon(entry.disputeId);
        // The provider ruled for the host. Per the 2026-09-01 decision recorded
        // at payment_dispute.go's `resolveDisputeOutcome` the parked policy
        // refund is NOT then paid on top — see this file's header before
        // changing this.
        const req = await pollRefundRequest(
          entry,
          ['rejected', 'refunded', 'settled_by_chargeback'],
          `refund_request for ${entry.id} to leave held_dispute after the dispute was WON`
        );
        assert(
          req.status === 'rejected',
          `a WON dispute is the provider's final word for this charge: the held policy refund must be closed unpaid ` +
            `('rejected'), not paid on top of it — got '${req.status}'`
        );
        const { viaGateway, viaFirestore } = await refundRows(entry.id);
        assert(viaGateway.length === 1, `expected the ONE held refund row to be closed in place, got ${viaGateway.length} refund rows`);
        assert(
          viaGateway[0].status === 'cancelled',
          `the guest's on-hold refund row must resolve to 'cancelled' (no money moved) on a won dispute, got '${viaGateway[0].status}'`
        );
        assert(
          Math.abs(viaGateway[0].amount) < 0.005,
          `a won dispute pays the guest nothing — expected the closed refund row at 0, got ${viaGateway[0].amount}`
        );
        assert(
          !viaFirestore.refund_id,
          `a won dispute issues no refund at all — the ledger row must carry no refund_id, got '${viaFirestore.refund_id}'`
        );
      },
    },
    {
      name: 'AC4 (host money): dispute WON — the payout is released',
      run: async () => {
        requireFixtures();
        const entry = ctx.bookings.wonComplete;
        await closeDisputeWon(entry.disputeId);
        const payout = await pollPayout(
          entry.id,
          (p) => p.dispute_info?.status === 'won' || p.has_dispute === false,
          `payout for ${entry.id} to record the WON outcome`
        );
        console.log(
          `    · wonComplete: payout ${payout.id} status=${payout.status} has_dispute=${payout.has_dispute} ` +
            `last_error=${JSON.stringify(payout.last_error || '')}`
        );
        assert(
          payout.has_dispute === false,
          `a won dispute must stop blocking the payout — expected has_dispute=false, got ${payout.has_dispute}`
        );
        assert(
          payout.dispute_info?.status === 'won',
          `expected the payout's dispute_info to record the won outcome, got ${JSON.stringify(payout.dispute_info)}`
        );
        assert(
          !/[Dd]ispute/.test(payout.last_error || ''),
          `the dispute must no longer be the reason the payout is held — last_error=${JSON.stringify(payout.last_error)}`
        );
        // The strong form, available because the fixture host HAS a payout
        // method. `ready` is where the dispute's responsibility ends: actually
        // dispatching it is the nightly daily-payout-processing job's job, and
        // asserting the dispatch would spend PayPal sandbox balance.
        const method = ctx.hostPayoutMethods.wonComplete;
        if (method && method !== '(none)' && method !== 'not_specified') {
          assert(
            payout.status === 'ready',
            `the host has a payout method (${method}) and the dispute was won, so nothing is holding this payout — ` +
              `expected status='ready', got '${payout.status}' (last_error=${JSON.stringify(payout.last_error || '')})`
          );
        } else {
          // The inverse fence: a method-less payout must NOT be released by a
          // won dispute — the no-method block has to survive it.
          assert(
            payout.status !== 'ready',
            `the host has NO payout method (${method}), so winning the dispute must NOT make the payout payable — ` +
              `it must stay blocked on the no-method reason, got status='ready'`
          );
        }
      },
    },
    {
      // Cleanup owns every booking this flow created, in whatever state the run
      // reached — including when an earlier case threw (lib/runner.mjs keeps
      // going past a failure precisely so this runs).
      name: 'cleanup: tear down every booking this flow created, and prove each ended terminal',
      run: async () => {
        if (!ctx.guest) skip('nothing to clean up — the flow skipped before creating any booking');
        const left = [];
        for (const key of ['lostCancel', 'wonCancel']) {
          const entry = ctx.bookings[key];
          if (!entry?.id) continue;
          await teardownBooking(ctx.guest.tokens, entry.id);
          const final = await getBooking(ctx.guest.tokens, entry.id).catch(() => null);
          if (!final) continue; // draft deleted outright
          assert(
            final.status === 'cancelled',
            `LEAK: booking ${entry.id} was left at status='${final.status}' instead of 'cancelled' — it is still ` +
              `holding its listing's dates on staging`
          );
        }
        // The complete-track stays are terminal ONCE COMPLETED — but if AC2
        // never ran (skip, abort, Ctrl-C) they are still Confirmed, 300-600
        // days out, holding dates on a shared bot listing forever. Tear those
        // down. Cancelling one under an open dispute parks a held refund; that
        // residue is accepted, and it is far cheaper than a permanently blocked
        // fixture.
        for (const key of ['lostComplete', 'wonComplete']) {
          const entry = ctx.bookings[key];
          if (!entry?.id) continue;
          const booking = await getBooking(ctx.guest.tokens, entry.id).catch(() => null);
          if (!booking) continue;
          if (booking.status === 'completed') {
            console.log(`    · ${key}: booking ${entry.id} left 'completed' (terminal by design, dates are in the past)`);
            continue;
          }
          await teardownBooking(ctx.guest.tokens, entry.id);
          const final = await getBooking(ctx.guest.tokens, entry.id).catch(() => null);
          left.push(`${key}=${entry.id} was '${booking.status}' (not completed) → torn down to '${final?.status}'`);
        }
        if (left.length) {
          console.log(`    · complete-track stays that never completed, cleaned up: ${left.join('; ')}`);
          console.log(`    · (cancelling under an open dispute parks a held refund — accepted residue)`);
        }
      },
    },
  ],
};
