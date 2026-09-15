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
// FIXTURE LIMITATION — NO BOT HOST HAS A PAYOUT METHOD
//
// Checked against staging Firestore on 2026-09-15: exactly three users have
// `payout_method` set (all `stripe`), and all three are REAL accounts —
// including the owner's. Every seeded bot host has none. This suite may only
// book bot hosts (every booking, payment and cancellation pushes the host a
// real notification — see lib/booking-flow.mjs), so a payout created here
// always takes payment-service's unconfigured-host branch
// (payment.go:582 → `CreatePayoutForUnconfiguredHost`), which records the row
// `blocked` with `last_error: host_payout_method_not_configured`.
//
// Consequences, stated plainly rather than worked around:
//   · AC2 asserts the DISPUTE flags, not `status: blocked` (which is true for
//     the wrong reason on this fixture).
//   · AC4's payout half asserts that the dispute stops blocking the payout
//     (has_dispute false, dispute_info.status won) and NOT that it reaches
//     `ready` — for a method-less host, staying blocked on the no-method reason
//     is correct. Proving the full release needs a bot host with a payout
//     method seeded on staging; that is the one thing this flow cannot do for
//     itself.
//
// ─────────────────────────────────────────────────────────────────────────────
// EXPECTED-RED (measured on staging 2026-09-15, payment-service-00251-jfp)
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
//      `GetPayoutsByPaymentIntentID` (blockPayoutsForDispute AND
//      resolvePayoutsForDispute), so this payout is permanently invisible to
//      every dispute webhook — before and after the close. The auto-complete
//      sweep's booking_completed event simply does not carry payment_intent_id
//      or transaction_id (booking-service
//      internal/service/booking_completion.go:276-285).
//   2. the unconfigured-host creation path never consults the charge's dispute
//      state at all — `blockPayoutIfTransactionDisputed` is called only on the
//      configured-host branch (payment-service internal/service/payment.go:703).
//
// This is NOT a fresh diagnosis: payment-service commits `1a91473` + `1370b00`
// (local, unpushed as of 2026-09-15) already fix it by resolving the intent from
// the booking's own transaction before the payout is created. Staging was still
// serving `payment-service-00251-jfp` (built from `3434171`, pre-fix) when the
// numbers above were measured — so these three cases ARE the verification
// vehicle for that fix. Re-run this flow once it deploys; they should go green
// without touching a single assertion. Do NOT loosen them to get there.
//
// ─────────────────────────────────────────────────────────────────────────────
// RESIDUE (deliberate, documented)
//   · 4 Stripe sandbox disputed charges per run — 2 closed won, 2 closed lost.
//   · 2 cancelled bookings (torn down and verified) + 2 COMPLETED bookings that
//     cannot be torn down by design. Their dates are in the past, so they block
//     no availability; they leave one payouts row each.
//   · one throwaway qa+<digits>@bot.com guest.
// Because of that cost, and the secret key, this file is expected to run
// locally on demand, not on the 6-hourly CI cadence.
import {
  registerFreshUser,
  pickListings,
  futureDates,
  initiateBooking,
  calcPricing,
  createPaymentIntent,
  payWithTestCard,
  finalizeBooking,
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
  getPayoutsByBookingId,
  getRefundRequestsByBookingId,
  getUserPayoutMethod,
} from '../lib/firestore.mjs';
import { runAutoCompleteSweep } from '../lib/staging-jobs.mjs';

const ctx = { bookings: {} };

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Every case after setup depends on the four fixtures existing. If setup
// itself skipped (no Stripe secret, no Firestore) or blew up, the dependents
// must say WHY rather than cascade into "cannot read properties of undefined".
function requireFixtures() {
  requireStripeSecret();
  for (const key of ['lostCancel', 'wonCancel', 'lostComplete', 'wonComplete']) {
    if (!ctx.bookings[key]?.disputeId) {
      skip(`setup did not produce the ${key} fixture — see the setup case above for the reason`);
    }
  }
}

const OPEN_DISPUTE_STATUSES = ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review'];

// One paid, confirmed, disputed booking. Recorded in ctx.bookings[key] the
// moment the draft exists, so cleanup can always find it.
async function bookDisputedStay(key, listing) {
  const dates = futureDates();
  const draft = await initiateBooking(ctx.guest.tokens, listing.id, dates);
  const entry = { id: draft.id, listing, total: 0, intentId: null, disputeId: null };
  ctx.bookings[key] = entry;

  const pricing = await calcPricing(ctx.guest.tokens, listing.price);
  entry.total = pricing.total;
  const intent = await createPaymentIntent(ctx.guest.tokens, {
    bookingId: draft.id,
    guestId: ctx.guest.id,
    hostId: listing.host.id,
    listingId: listing.id,
    amount: pricing.total,
    currency: listing.currency,
  });
  entry.intentId = intent.id;
  await payWithTestCard(intent, 'tok_createDispute');
  await finalizeBooking(ctx.guest.tokens, draft.id, { dates, paymentReference: intent.id, amount: pricing.total });

  await poll(
    async () => {
      const b = await getBooking(ctx.guest.tokens, draft.id);
      return { done: b.status === 'confirmed', value: b.status };
    },
    { timeoutMs: 120000, intervalMs: 4000, desc: `booking ${draft.id} to reach status=confirmed` }
  );
  // The dispute is raised by Stripe a few seconds after capture; wait for OUR
  // side to have recorded it before doing anything that depends on it.
  await poll(
    async () => {
      const b = await getBooking(ctx.guest.tokens, draft.id);
      return { done: b.has_dispute === true, value: b.has_dispute };
    },
    { timeoutMs: 180000, intervalMs: 5000, desc: `booking ${draft.id} to be flagged has_dispute` }
  );
  const dispute = await poll(
    async () => {
      const d = await findDisputeForIntent(intent.id);
      return { done: !!d, value: d };
    },
    { timeoutMs: 120000, intervalMs: 5000, desc: `Stripe to raise a dispute on ${intent.id}` }
  );
  entry.disputeId = dispute.id;
  console.log(`    · ${key}: booking ${draft.id}, intent ${intent.id}, dispute ${dispute.id} (${dispute.status})`);
  return entry;
}

// Cancel while the dispute is open → the refund must be PARKED, not sent.
// (AC1's rule; asserted here as the precondition the outcome cases resolve.)
async function cancelAndExpectHold(key) {
  const entry = ctx.bookings[key];
  await cancelBooking(ctx.guest.tokens, entry.id);
  entry.cancelled = true;
  const held = await poll(
    async () => {
      const rows = await getRefundRequestsByBookingId(entry.id);
      const r = rows.find((x) => x.status === 'held_dispute');
      return { done: !!r, value: r ?? rows };
    },
    { timeoutMs: 120000, intervalMs: 5000, desc: `a held_dispute refund_request for booking ${entry.id}` }
  );
  entry.refundRequestId = held.id;
  return held;
}

// Complete a confirmed booking for real: move its stay into the past, then run
// booking-service's own sweep. Returns the payout row once it appears.
async function completeAndAwaitPayout(keys) {
  for (const key of keys) {
    const entry = ctx.bookings[key];
    const { checkOut } = await fastForwardBookingToCompletion(entry.id);
    console.log(`    · ${key}: booking ${entry.id} fast-forwarded, check_out=${checkOut.toISOString()}`);
  }
  await runAutoCompleteSweep();
  const payouts = {};
  for (const key of keys) {
    const entry = ctx.bookings[key];
    payouts[key] = await poll(
      async () => {
        const rows = await getPayoutsByBookingId(entry.id);
        return { done: rows.length > 0, value: rows[0] };
      },
      { timeoutMs: 180000, intervalMs: 6000, desc: `a payouts row for completed booking ${entry.id}` }
    );
    entry.payoutId = payouts[key].id;
  }
  return payouts;
}

// The dispute close is a webhook round-trip; poll our own state, not Stripe's.
const pollRefundRequest = (bookingId, want, desc) =>
  poll(
    async () => {
      const rows = await getRefundRequestsByBookingId(bookingId);
      const r = rows[0];
      return { done: !!r && want.includes(r.status), value: r };
    },
    { timeoutMs: 150000, intervalMs: 5000, desc }
  );

// Shorter than the refund poll on purpose: charge.dispute.closed reaches
// payment-service within seconds, and these three cases are expected-red today
// (see EXPECTED-RED above) — a long timeout would just add five minutes to
// every run to reach the same answer.
const pollPayout = (bookingId, done, desc) =>
  poll(
    async () => {
      const rows = await getPayoutsByBookingId(bookingId);
      const p = rows[0];
      return { done: !!p && done(p), value: p };
    },
    { timeoutMs: 90000, intervalMs: 5000, desc }
  );

export default {
  name: 'payment-service × booking-service (CR-650/CR-679 dispute resolution: the held refund and the host payout)',
  cases: [
    {
      name: 'setup: four disputed, paid stays — two to cancel, two to complete',
      run: async () => {
        // Capability gates first: fail fast on a live key, skip on no key /
        // no Firestore, before creating anything on Stripe.
        requireStripeSecret();
        firestore();

        ctx.guest = await registerFreshUser('DisputeResolution');
        // full_refund_24h for the cancel track: the held amount must be the
        // FULL total, or "the refund was held" is a claim about nothing.
        const [lostCancelListing, wonCancelListing] = await pickListings(ctx.guest.tokens, 2, {
          minPrice: 1,
          policy: 'full_refund_24h',
        });
        const [lostCompleteListing, wonCompleteListing] = await pickListings(ctx.guest.tokens, 2, {
          minPrice: 1,
          exclude: [lostCancelListing.id, wonCancelListing.id],
        });

        await bookDisputedStay('lostCancel', lostCancelListing);
        await bookDisputedStay('wonCancel', wonCancelListing);
        await bookDisputedStay('lostComplete', lostCompleteListing);
        await bookDisputedStay('wonComplete', wonCompleteListing);

        // Record the fixture limitation as an observation rather than an
        // assumption: if a bot host ever DOES get a payout method, the AC4
        // payout case below can be tightened to assert `ready`.
        ctx.hostPayoutMethods = {};
        for (const key of ['lostComplete', 'wonComplete']) {
          const hostId = ctx.bookings[key].listing.host.id;
          ctx.hostPayoutMethods[key] = (await getUserPayoutMethod(hostId)) || '(none)';
          console.log(`    · ${key}: host ${hostId} payout_method=${ctx.hostPayoutMethods[key]}`);
        }
      },
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
          const refundRows = (await getBookingTransactions(ctx.guest.tokens, entry.id)).filter((t) => t.type === 'refund');
          assert(refundRows.length === 1, `${key}: expected exactly one refund ledger row, got ${JSON.stringify(refundRows)}`);
          assert(
            refundRows[0].status === 'on_hold',
            `${key}: the guest-visible refund row must be on_hold while the dispute is open, got '${refundRows[0].status}'`
          );
        }
      },
    },
    {
      // AC2. The dispute flags are the claim; `status: blocked` is not, on a
      // method-less bot host (see the FIXTURE LIMITATION note above).
      name: 'AC2: a stay that completes while its dispute is OPEN creates a payout linked to the charge and flagged with the dispute',
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
          assert(
            payout.status === 'blocked',
            `${key}: a payout created while the charge is disputed must not be payable — expected status='blocked', got '${payout.status}'`
          );
          // The linkage assertion comes FIRST because everything else depends
          // on it: every dispute↔payout lookup in payment-service is keyed on
          // payment_intent_id (`GetPayoutsByPaymentIntentID`, used by both
          // blockPayoutsForDispute and resolvePayoutsForDispute), so a payout
          // created without one can never be blocked or released by a dispute
          // webhook, no matter what the dispute handlers do.
          if (!payout.payment_intent_id) {
            problems.push(
              `${key}: payout ${payout.id} was created with an EMPTY payment_intent_id (charge was ${entry.intentId}). ` +
                'Nothing can ever tie a dispute to this payout: both blockPayoutsForDispute and resolvePayoutsForDispute ' +
                'look payouts up by payment_intent_id. The auto-complete sweep\'s booking_completed event does not carry ' +
                'payment_intent_id or transaction_id (booking-service internal/service/booking_completion.go:276-285).'
            );
            continue;
          }
          if (payout.has_dispute !== true) {
            problems.push(
              `${key}: payout ${payout.id} for disputed charge ${entry.intentId} was created with has_dispute=${payout.has_dispute}. ` +
                'The host must not be paid out of a charge the bank may claw back, and the dispute state must be carried onto ' +
                'the payout at CREATION regardless of which creation path made the row (the unconfigured-host branch, ' +
                'payment-service internal/service/payment.go:582, does not consult it today).'
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
        const cancelEntry = ctx.bookings.lostCancel;
        await closeDisputeLost(cancelEntry.disputeId);
        const req = await pollRefundRequest(
          cancelEntry.id,
          ['settled_by_chargeback', 'refunded', 'rejected'],
          `refund_request for ${cancelEntry.id} to leave held_dispute after the dispute was LOST`
        );
        assert(
          req.status === 'settled_by_chargeback',
          `a LOST dispute already returned the money via the card network — the held request must close as ` +
            `'settled_by_chargeback', never be paid again — got '${req.status}'`
        );
        assert(
          !req.refund_id || String(req.refund_id).startsWith('chargeback:'),
          `no provider refund may be issued on a lost dispute; refund_id=${req.refund_id}`
        );
        const refundRows = (await getBookingTransactions(ctx.guest.tokens, cancelEntry.id)).filter((t) => t.type === 'refund');
        assert(refundRows.length === 1, `expected the ONE held refund row to be closed in place, got ${refundRows.length} refund rows`);
        assert(
          refundRows[0].status !== 'on_hold',
          `the held refund row must reach a terminal state once the dispute closes, still '${refundRows[0].status}'`
        );
      },
    },
    {
      name: 'AC3 (host money): dispute LOST — the payout stays blocked and stays flagged',
      run: async () => {
        requireFixtures();
        const completeEntry = ctx.bookings.lostComplete;
        await closeDisputeLost(completeEntry.disputeId);
        const payout = await pollPayout(
          completeEntry.id,
          (p) => p.dispute_info?.status === 'lost' || /Dispute closed/i.test(p.last_error || ''),
          `payout for ${completeEntry.id} to record the LOST outcome`
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
        const cancelEntry = ctx.bookings.wonCancel;
        await closeDisputeWon(cancelEntry.disputeId);
        // The provider ruled for the host. Per the 2026-09-01 decision recorded
        // at payment_dispute.go:353-362 the parked policy refund is NOT then
        // paid on top — see this file's header before changing this.
        const req = await pollRefundRequest(
          cancelEntry.id,
          ['rejected', 'refunded', 'settled_by_chargeback'],
          `refund_request for ${cancelEntry.id} to leave held_dispute after the dispute was WON`
        );
        assert(
          req.status === 'rejected',
          `a WON dispute is the provider's final word for this charge: the held policy refund must be closed unpaid ` +
            `('rejected'), not paid on top of it — got '${req.status}'`
        );
        const refundRows = (await getBookingTransactions(ctx.guest.tokens, cancelEntry.id)).filter((t) => t.type === 'refund');
        assert(refundRows.length === 1, `expected the ONE held refund row to be closed in place, got ${refundRows.length} refund rows`);
        assert(
          refundRows[0].status === 'cancelled',
          `the guest's on-hold refund row must resolve to 'cancelled' (no money moved) on a won dispute, got '${refundRows[0].status}'`
        );
        assert(
          Math.abs(refundRows[0].amount) < 0.005,
          `a won dispute pays the guest nothing — expected the closed refund row at 0, got ${refundRows[0].amount}`
        );
      },
    },
    {
      name: 'AC4 (host money): dispute WON — the dispute stops blocking the payout',
      run: async () => {
        requireFixtures();
        const completeEntry = ctx.bookings.wonComplete;
        await closeDisputeWon(completeEntry.disputeId);
        const payout = await pollPayout(
          completeEntry.id,
          (p) => p.dispute_info?.status === 'won',
          `payout for ${completeEntry.id} to record the WON outcome`
        );
        console.log(
          `    · wonComplete: payout ${payout.id} status=${payout.status} has_dispute=${payout.has_dispute} ` +
            `last_error=${JSON.stringify(payout.last_error || '')}`
        );
        assert(
          payout.dispute_info?.status === 'won',
          `expected the payout's dispute_info to record the won outcome, got ${JSON.stringify(payout.dispute_info)}`
        );
        assert(
          payout.has_dispute === false,
          `a won dispute must stop blocking the payout — expected has_dispute=false, got ${payout.has_dispute}`
        );
        // Deliberately NOT asserting status==='ready': this fixture's bot host
        // has no payout method, and staying blocked for THAT reason is correct.
        // Assert only that the dispute is no longer the reason.
        assert(
          !/[Dd]ispute/.test(payout.last_error || ''),
          `the dispute must no longer be the reason the payout is held — last_error=${JSON.stringify(payout.last_error)}`
        );
        if (payout.status === 'blocked') {
          const why = ctx.hostPayoutMethods.wonComplete;
          assert(
            why === '(none)' || why === 'not_specified',
            `payout stayed blocked but host payout_method is '${why}' — that is not the no-method case, so a won dispute left it stuck`
          );
          console.log(`    · wonComplete: payout remains blocked for host_payout_method_not_configured (fixture limitation, see header)`);
        }
      },
    },
    {
      // Only the two CANCEL-track bookings can be torn down. The completed ones
      // are terminal by design; their dates were fast-forwarded into the past,
      // so they hold no future availability on the shared staging fixtures.
      name: 'cleanup: tear down the cancel-track bookings, and prove they ended cancelled',
      run: async () => {
        // Nothing was created when the flow skipped at setup — say so rather
        // than reporting a green cleanup that cleaned nothing.
        if (!ctx.guest) skip('nothing to clean up — the flow skipped before creating any booking');
        for (const key of ['lostCancel', 'wonCancel']) {
          const entry = ctx.bookings[key];
          if (!entry) continue;
          await teardownBooking(ctx.guest.tokens, entry.id);
          const final = await getBooking(ctx.guest.tokens, entry.id).catch(() => null);
          if (!final) continue; // draft deleted outright
          assert(
            final.status === 'cancelled',
            `LEAK: booking ${entry.id} was left at status='${final.status}' instead of 'cancelled' — it is still holding ` +
              `its listing's dates on staging`
          );
        }
        for (const key of ['lostComplete', 'wonComplete']) {
          const entry = ctx.bookings[key];
          if (!entry) continue;
          const final = await getBooking(ctx.guest.tokens, entry.id).catch(() => null);
          console.log(`    · ${key}: booking ${entry.id} left at status='${final?.status}' (completed stays are terminal, dates are in the past)`);
        }
      },
    },
  ],
};
