// payment-service × booking-service — CR-650 / CR-678: the PayPal half of
// dispute resolution. The Stripe twin is services/payment-dispute-resolution-flow.mjs.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FLOW STARTS WITH A HUMAN, AND ONLY THIS FLOW
//
// PayPal gives us no way to do the two things Stripe hands over for free:
//   1. PAY as the buyer. Order creation returns an `approval_url`
//      (`sandbox.paypal.com/checkoutnow`) the BUYER must open and log into
//      (payment-service internal/service/paypal_service.go ~356-374). There is
//      no API to approve an order on someone else's behalf. The vault
//      (`vault_id`) path is not a way out either — our own comment at
//      paypal_service.go:278-281 records that a vaulted buyer-initiated charge
//      "may still return an approval link (true off-session/no-redirect needs
//      Reference Transactions)", and creating the vault token needs the same
//      browser approval once.
//   2. FILE the dispute. `POST /v1/customer/disputes` is limited-release only;
//      in the sandbox a dispute is filed by the buyer in the Resolution Center.
// Everything AFTER those two steps is automated here — that is the agreed
// option 3 (2026-09-15), chosen over enabling Reference Transactions or driving
// the sandbox login with Playwright.
//
// So: a human pays and reports a problem; this flow observes, drives the state
// machine, decides the dispute through PayPal's API and asserts the money.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO RUN IT (the human recipe is also printed by the SKIP message)
//
//   PAYPAL_DISPUTE_BOOKING=CR-ABC123 make test-gateway
//
// Optional, so the four ACs can be driven one at a time from separate
// human-filed bookings (one dispute can only be decided once):
//   PAYPAL_DISPUTE_TRACK=cancel|complete    (default cancel)
//   PAYPAL_DISPUTE_OUTCOME=buyer|seller     (default buyer)
//   PAYPAL_DISPUTE_GUEST_EMAIL / _PASSWORD  (default: the suite's own guest)
//
// The four combinations map onto the ACs exactly as the Stripe flow's cases do:
//   cancel   + buyer  → AC1 hold, then AC3 guest money (settled_by_chargeback)
//   cancel   + seller → AC1 hold, then AC4 guest money (rejected, nothing paid)
//   complete + buyer  → AC2 payout flagged, then AC3 host money (stays blocked)
//   complete + seller → AC2 payout flagged, then AC4 host money (no longer held)
//
// Gated twice, both by design: `DISPUTE_FLOW=1` (shared with the Stripe flow —
// these are irreversible, slow flows that must be run deliberately) and
// `PAYPAL_DISPUTE_BOOKING`. Missing either → every case SKIPS (lib/skip.mjs),
// and the human recipe is printed once. That is the CI state, permanently.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROVIDER GAP THIS EXISTS TO GUARD
//
// A PayPal charge's `payment_intent_id` is a PayPal ORDER id — no `pi_` prefix,
// no prefix at all. payment-service's `disputeTransaction` selector filters on
// a `pi_`/`seti_` prefix for webhook callers, so before the fix every
// money-movement guard that went through it returned nil for EVERY PayPal
// charge — i.e. the guards silently did not apply to PayPal at all. The fix
// routes money guards through `chargeTransactionForIntent` (no prefix filter).
// The "no pi_ prefix" assertion below is the regression guard for that: it
// pins the shape of the id the guards have to cope with.
//
// Also observed and depended on (staging sandbox, 2026-09-15): a real sandbox
// dispute carries NO `reference_id` on `disputed_transactions[0]`, only
// `seller_transaction_id`. payment-service therefore maps a PayPal dispute to
// our booking via the capture-id fallback (payment.go ~5352-5360), and this
// flow asserts the charge row carries that `capture_id` so the fallback has
// something to match.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT ASSERTS, AND ON WHAT
//
// On OUR normalized state, not PayPal's labels: the charge row's
// `dispute_status` uses Stripe's vocabulary for both providers
// (`needs_response` / `under_review` / `won` / `lost`), and on PayPal's side it
// asserts `dispute_outcome.outcome_code` — never `status`/`outcome`, because
// the mapping that matters is outcome_code → internal status
// (`paypalDisputeOutcomeStatus`). The FAVOR/FAVOUR spelling split between the
// adjudicate REQUEST and the resulting outcome_code is handled in
// lib/paypal-dispute.mjs and is the reason that mapping is asserted rather than
// assumed.
//
// ─────────────────────────────────────────────────────────────────────────────
// SAME FIXTURE CEILING AS THE STRIPE FLOW
//
// No seeded bot host on staging has a `payout_method`, so any payout created on
// the `complete` track is ALSO blocked for `host_payout_method_not_configured`.
// The `complete` track therefore asserts the DISPUTE dimension (`has_dispute`,
// `dispute_info`) and not `status: blocked` — which would be true for the wrong
// reason — and a seller win asserts "the dispute is no longer what holds it"
// rather than `ready`.
//
// LEAK DISCIPLINE: this flow does not create the booking, so it does not own
// it. The `cancel` track cancels it (which is the behaviour under test) and
// the `complete` track completes it; neither is torn down, because the human
// created it for exactly this purpose and the decided dispute is not reusable.
// It creates nothing on PayPal's side beyond deciding the one dispute named.
import { config } from '../lib/env.mjs';
import { loginAs } from '../lib/auth.mjs';
import { cancelBooking, getBooking } from '../lib/booking-flow.mjs';
import { getBookingTransactions } from '../lib/payment-helpers.mjs';
import { poll } from '../lib/poll.mjs';
import { skip } from '../lib/skip.mjs';
import {
  firestore,
  resolveBooking,
  getTransactionsByBookingId,
  getRefundRequestsByBookingId,
  getPayoutsByBookingId,
  getUserPayoutMethod,
  fastForwardBookingToCompletion,
} from '../lib/firestore.mjs';
import { runAutoCompleteSweep } from '../lib/staging-jobs.mjs';
import {
  requirePayPalCreds,
  getDispute,
  findDisputesForCapture,
  decideDispute,
  outcomeCode,
  expectedInternalStatus,
  disputeActions,
} from '../lib/paypal-dispute.mjs';

// Printed verbatim when the flow has no booking to work on. Kept as the FIRST
// thing in the skip message so it can be handed to whoever does the manual
// half without editing.
const HUMAN_RECIPE = [
  '1. Log into the STAGING Corneroom app as the gateway-suite guest (tests/.env TEST_EMAIL).',
  '2. Book any bot-hosted listing and choose PayPal at checkout, then approve the payment as the PayPal SANDBOX BUYER.',
  '3. In the PayPal sandbox Resolution Center, open that transaction as the buyer and file a dispute via "Report a Problem".',
  '4. Send back the booking code (CR-XXXXXX); the suite then runs: PAYPAL_DISPUTE_BOOKING=CR-XXXXXX make test-gateway',
].join('\n     ');

const TRACK = (process.env.PAYPAL_DISPUTE_TRACK || 'cancel').toLowerCase();
const OUTCOME = (process.env.PAYPAL_DISPUTE_OUTCOME || 'buyer').toLowerCase();

const ctx = {};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const OPEN_DISPUTE_STATUSES = ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review'];

// The recipe is worth printing once per run, not once per case — six copies of
// it buries every other line in the output.
let recipeShown = false;

// Gate every case: no booking named → skip with the recipe; a bad TRACK/OUTCOME
// is a usage error and fails loudly rather than silently running the default.
function requireSubject() {
  // Same opt-in gate as the Stripe flow: this one cancels or completes a real
  // booking and closes a real sandbox dispute irreversibly, so it must never
  // ride along on a plain `make test-gateway`.
  if (process.env.DISPUTE_FLOW !== '1') {
    skip('DISPUTE_FLOW=1 not set — run the dispute flows deliberately: `make test-gateway-dispute`');
  }
  const booking = process.env.PAYPAL_DISPUTE_BOOKING || '';
  if (!booking) {
    if (recipeShown) skip('PAYPAL_DISPUTE_BOOKING not set (human recipe printed above)');
    recipeShown = true;
    skip(
      `PAYPAL_DISPUTE_BOOKING not set. A human must pay and file the dispute first — PayPal has no API for either.\n` +
        `     ── HUMAN RECIPE ──\n     ${HUMAN_RECIPE}\n` +
        `     Optional: PAYPAL_DISPUTE_TRACK=cancel|complete (default cancel), ` +
        `PAYPAL_DISPUTE_OUTCOME=buyer|seller (default buyer).`
    );
  }
  if (!['cancel', 'complete'].includes(TRACK)) {
    throw new Error(`PAYPAL_DISPUTE_TRACK must be 'cancel' or 'complete', got '${TRACK}'`);
  }
  if (!['buyer', 'seller'].includes(OUTCOME)) {
    throw new Error(`PAYPAL_DISPUTE_OUTCOME must be 'buyer' or 'seller', got '${OUTCOME}'`);
  }
  return booking;
}

// Dependents must not cascade into "cannot read properties of undefined" when
// setup skipped or failed — they must say which step did not happen.
function requireSubjectResolved() {
  requireSubject();
  if (!ctx.booking || !ctx.charge) skip('setup did not resolve the booking and its PayPal charge — see the setup case above');
}

const chargeRow = async (bookingId) => {
  const rows = await getTransactionsByBookingId(bookingId);
  return rows.find((t) => t.type === 'booking') || null;
};

export default {
  name: 'payment-service × booking-service (CR-650/CR-678 PayPal dispute resolution — human pays + files, suite decides)',
  cases: [
    {
      name: 'setup: resolve the human-filed booking, prove it was paid with PayPal, and find its dispute',
      run: async () => {
        const subject = requireSubject();
        firestore();

        const booking = await resolveBooking(subject);
        assert(booking, `no staging booking matches PAYPAL_DISPUTE_BOOKING='${subject}' (tried document id, then booking_code)`);
        ctx.booking = booking;

        const charge = await chargeRow(booking.id);
        assert(
          charge,
          `booking ${booking.id} (${booking.booking_code}) has no charge transaction — was it actually paid? ` +
            'The recipe requires an approved PayPal payment, not just a draft.'
        );
        assert(
          charge.provider === 'paypal',
          `booking ${booking.id} was paid with '${charge.provider}', not PayPal — this flow needs a PayPal charge ` +
            '(use services/payment-dispute-resolution-flow.mjs for Stripe)'
        );
        ctx.charge = charge;

        // THE PROVIDER-GAP GUARD. A PayPal order id has no prefix at all, and a
        // prefix-filtered selector therefore returned nil for every PayPal
        // charge — so every money guard behind it silently skipped PayPal.
        assert(
          !!charge.payment_intent_id,
          `the PayPal charge row carries no payment_intent_id — nothing can tie a dispute to it`
        );
        assert(
          !/^(pi_|seti_)/.test(charge.payment_intent_id),
          `expected a bare PayPal ORDER id on the charge row (no pi_/seti_ prefix — that is exactly what broke the ` +
            `PayPal money guards), got '${charge.payment_intent_id}'`
        );
        assert(
          !!charge.capture_id,
          `the PayPal charge row carries no capture_id. A real sandbox dispute has NO reference_id on ` +
            `disputed_transactions[0], so payment-service can only map it to this booking via the capture-id ` +
            `fallback (payment.go ~5352-5360) — without capture_id the dispute is unmappable.`
        );

        ctx.guestEmail = process.env.PAYPAL_DISPUTE_GUEST_EMAIL || config.email;
        ctx.guestPassword = process.env.PAYPAL_DISPUTE_GUEST_PASSWORD || config.password;
        ctx.tokens = await loginAs(ctx.guestEmail, ctx.guestPassword, 'PayPal dispute guest');
        const viaGateway = await getBooking(ctx.tokens, booking.id);
        assert(
          viaGateway?.id === booking.id,
          `the account ${ctx.guestEmail} cannot read booking ${booking.id} over the gateway — set ` +
            'PAYPAL_DISPUTE_GUEST_EMAIL/_PASSWORD to the guest who actually made this booking'
        );
        ctx.gatewayBooking = viaGateway;

        console.log(
          `    · subject: booking ${booking.id} (${booking.booking_code}) status=${viaGateway.status} ` +
            `order=${charge.payment_intent_id} capture=${charge.capture_id} guest=${ctx.guestEmail}`
        );
        console.log(`    · track=${TRACK} outcome=${OUTCOME}`);
      },
    },
    {
      name: 'the buyer-filed dispute is recorded on our PayPal charge row, with an OPEN normalized status',
      run: async () => {
        requireSubjectResolved();
        let charge;
        try {
          charge = await poll(
            async () => {
              const row = await chargeRow(ctx.booking.id);
              return { done: row?.has_dispute === true && !!row?.dispute_status, value: row };
            },
            {
              timeoutMs: 180000,
              intervalMs: 6000,
              desc: `the CUSTOMER.DISPUTE.CREATED webhook to land on booking ${ctx.booking.id}'s charge row`,
            }
          );
        } catch (e) {
          // A bare timeout here is ambiguous in a way that matters: either the
          // human has not filed the dispute yet, or they have and OUR webhook
          // failed to map it to the booking. Ask PayPal directly and say which
          // — the second case is a product bug, the first is just "wait".
          let verdict = 'could not ask PayPal (see the error above this line)';
          try {
            requirePayPalCreds();
            const found = await findDisputesForCapture(ctx.charge.capture_id);
            verdict = found.length
              ? `PayPal DOES have ${found.length} dispute(s) against capture ${ctx.charge.capture_id} ` +
                `(${found.map((d) => `${d.dispute_id}:${d.status}`).join(', ')}) — so the dispute was filed and ` +
                `payment-service did NOT map it onto this booking. That is a product bug, not a missing manual step.`
              : `PayPal has NO dispute against capture ${ctx.charge.capture_id} — step 3 of the human recipe has not ` +
                `been done yet (file it as the sandbox buyer via "Report a Problem"), or it is still propagating.`
          } catch (inner) {
            verdict = `could not ask PayPal: ${inner.message}`;
          }
          throw new Error(`${e.message}\n     DIAGNOSIS: ${verdict}`);
        }
        ctx.charge = charge;
        assert(charge.has_dispute === true, `expected has_dispute=true on the charge row, got ${charge.has_dispute}`);
        assert(
          OPEN_DISPUTE_STATUSES.includes(charge.dispute_status),
          `expected an OPEN normalized dispute_status (PayPal INQUIRY → 'needs_response', escalated → ` +
            `'under_review'), got '${charge.dispute_status}'`
        );
        assert(!!charge.dispute_id, `expected the PayPal dispute id recorded on the charge row, got '${charge.dispute_id}'`);
        assert(
          charge.status === 'disputed',
          `the charge row must read 'disputed' while the dispute is open (the shared shouldCompleteTransaction rule ` +
            `applies to PayPal too), got '${charge.status}'`
        );
        ctx.disputeId = charge.dispute_id;

        // Cross-check the id we are about to act on really is PayPal's, and
        // really belongs to this capture — deciding the wrong dispute would be
        // an irreversible action on someone else's sandbox data.
        requirePayPalCreds();
        const dispute = await getDispute(ctx.disputeId);
        const captures = (dispute.disputed_transactions || []).map((t) => t.seller_transaction_id);
        assert(
          captures.includes(ctx.charge.capture_id),
          `PayPal dispute ${ctx.disputeId} is against capture(s) ${JSON.stringify(captures)}, not this booking's ` +
            `capture ${ctx.charge.capture_id} — refusing to decide a dispute that is not this booking's`
        );
        console.log(
          `    · PayPal dispute ${ctx.disputeId}: status=${dispute.status} state=${dispute.dispute_state} ` +
            `stage=${dispute.dispute_life_cycle_stage} actions=[${disputeActions(dispute).join(', ')}]`
        );
      },
    },
    {
      name: `track '${TRACK}': the money is frozen while the dispute is open`,
      run: async () => {
        requireSubjectResolved();

        if (TRACK === 'cancel') {
          // AC1 for PayPal: cancelling during an open dispute must PARK the
          // refund. PayPal will not refund a disputed capture, and the dispute
          // may yet pay the buyer — refunding too pays them twice.
          const current = await getBooking(ctx.tokens, ctx.booking.id);
          if (current.status !== 'cancelled') await cancelBooking(ctx.tokens, ctx.booking.id, 'gateway suite: PayPal dispute flow');
          const held = await poll(
            async () => {
              const rows = await getRefundRequestsByBookingId(ctx.booking.id);
              const r = rows.find((x) => x.status === 'held_dispute');
              return { done: !!r, value: r ?? rows };
            },
            { timeoutMs: 150000, intervalMs: 6000, desc: `a held_dispute refund_request for booking ${ctx.booking.id}` }
          );
          assert(
            held.provider === 'paypal',
            `the held refund request must record the PayPal provider (the refund, if ever sent, goes back through ` +
              `PayPal), got '${held.provider}'`
          );
          assert(
            !!held.ledger_transaction_id,
            `a held_dispute request MUST carry ledger_transaction_id — without it closeHeldRow returns early and the ` +
              `guest's history shows nothing when the dispute resolves`
          );
          ctx.refundRequestId = held.id;

          const refunds = (await getBookingTransactions(ctx.tokens, ctx.booking.id)).filter((t) => t.type === 'refund');
          assert(refunds.length === 1, `expected exactly one refund ledger row, got ${JSON.stringify(refunds.map((r) => r.status))}`);
          assert(
            refunds[0].status === 'on_hold',
            `the guest-visible refund row must be 'on_hold' while the PayPal dispute is open, got '${refunds[0].status}'`
          );
          console.log(`    · refund parked: request ${held.id} held_dispute, ledger row on_hold at ${refunds[0].amount}`);
          return;
        }

        // complete track: drive the booking to completion so a payout exists,
        // then assert the open dispute is carried onto it.
        const current = await getBooking(ctx.tokens, ctx.booking.id);
        assert(
          current.status === 'confirmed',
          `the complete track needs a CONFIRMED booking to fast-forward (the sweep only selects Confirmed), ` +
            `got '${current.status}'`
        );
        const { checkOut } = await fastForwardBookingToCompletion(ctx.booking.id);
        console.log(`    · booking ${ctx.booking.id} fast-forwarded, check_out=${checkOut.toISOString()}`);
        await runAutoCompleteSweep();
        const payout = await poll(
          async () => {
            const rows = await getPayoutsByBookingId(ctx.booking.id);
            return { done: rows.length > 0, value: rows[0] };
          },
          { timeoutMs: 180000, intervalMs: 6000, desc: `a payouts row for completed booking ${ctx.booking.id}` }
        );
        ctx.hostPayoutMethod = (await getUserPayoutMethod(payout.host_id)) || '(none)';
        console.log(
          `    · payout ${payout.id} status=${payout.status} has_dispute=${payout.has_dispute} ` +
            `payment_intent_id=${JSON.stringify(payout.payment_intent_id)} ` +
            `host payout_method=${ctx.hostPayoutMethod} last_error=${JSON.stringify(payout.last_error || '')}`
        );
        assert(
          !!payout.payment_intent_id,
          `payout ${payout.id} was created with an EMPTY payment_intent_id (charge order ${ctx.charge.payment_intent_id}). ` +
            'Every dispute↔payout lookup goes through GetPayoutsByPaymentIntentID, so this payout can never be ' +
            'blocked or released by a dispute webhook.'
        );
        assert(
          payout.has_dispute === true,
          `a payout created while the charge is disputed must be flagged — expected has_dispute=true, got ${payout.has_dispute}`
        );
        assert(
          payout.dispute_info?.dispute_id === ctx.disputeId,
          `expected dispute_info.dispute_id=${ctx.disputeId} on the payout (resolvePayoutsForDispute skips any payout ` +
            `whose dispute id does not match), got ${JSON.stringify(payout.dispute_info)}`
        );
        // NOT asserting status==='blocked' as evidence: see the fixture ceiling
        // in this file's header — a method-less bot host is blocked anyway.
        ctx.payoutId = payout.id;
      },
    },
    {
      name: `decide the dispute in the ${OUTCOME === 'buyer' ? 'BUYER' : 'SELLER'}'s favour through the PayPal sandbox API`,
      run: async () => {
        requireSubjectResolved();
        requirePayPalCreds();
        assert(ctx.disputeId, 'no PayPal dispute id resolved — the previous case must run first');

        const decided = await decideDispute(ctx.disputeId, OUTCOME);
        const code = outcomeCode(decided);
        ctx.outcomeCode = code;
        console.log(
          `    · PayPal reports dispute ${ctx.disputeId} terminal: state=${decided.dispute_state} ` +
            `outcome_code=${code} reason=${decided.dispute_outcome?.outcome_reason}`
        );
        assert(!!code, `PayPal closed the dispute without an outcome_code: ${JSON.stringify(decided.dispute_outcome)}`);

        // Assert on outcome_code, never the `status`/`outcome` label — the code
        // is what payment-service normalizes.
        const expectedCodes =
          OUTCOME === 'buyer'
            ? ['ACCEPTED', 'RESOLVED_BUYER_FAVOUR', 'RESOLVED_WITH_PAYOUT']
            : ['RESOLVED_SELLER_FAVOUR', 'DENIED', 'CANCELED_BY_BUYER'];
        assert(
          expectedCodes.includes(code),
          `asked PayPal for a ${OUTCOME} win but got outcome_code='${code}' (expected one of ${expectedCodes.join('/')}). ` +
            'Note the FAVOUR/FAVOR spelling split: the adjudicate REQUEST enum has no U, the outcome_code does.'
        );
        ctx.expectedInternal = expectedInternalStatus(code);
        assert(
          ctx.expectedInternal === (OUTCOME === 'buyer' ? 'lost' : 'won'),
          `outcome_code '${code}' maps to internal status '${ctx.expectedInternal}', which is not what a ${OUTCOME} ` +
            'win should mean — paypalDisputeOutcomeStatus and this flow disagree'
        );
      },
    },
    {
      name: 'our charge row normalizes the PayPal outcome onto the same vocabulary Stripe uses',
      run: async () => {
        requireSubjectResolved();
        assert(ctx.expectedInternal, 'no decided outcome — the previous case must run first');
        const charge = await poll(
          async () => {
            const row = await chargeRow(ctx.booking.id);
            return { done: ['won', 'lost', 'warning_closed'].includes(row?.dispute_status), value: row };
          },
          {
            timeoutMs: 180000,
            intervalMs: 6000,
            desc: `the CUSTOMER.DISPUTE.RESOLVED webhook to normalize outcome_code ${ctx.outcomeCode} onto the charge row`,
          }
        );
        assert(
          charge.dispute_status === ctx.expectedInternal,
          `outcome_code '${ctx.outcomeCode}' must normalize to dispute_status '${ctx.expectedInternal}' ` +
            `(paypalDisputeOutcomeStatus), got '${charge.dispute_status}'`
        );
        assert(
          charge.has_dispute === (ctx.expectedInternal !== 'won'),
          `has_dispute must clear only on a win — outcome '${ctx.expectedInternal}' but has_dispute=${charge.has_dispute}`
        );
        ctx.charge = charge;
      },
    },
    {
      name: `terminal money outcome for track '${TRACK}' / ${OUTCOME} win`,
      run: async () => {
        requireSubjectResolved();
        assert(ctx.expectedInternal, 'no decided outcome — the decide case must run first');
        const buyerWon = ctx.expectedInternal === 'lost';

        if (TRACK === 'cancel') {
          const req = await poll(
            async () => {
              const rows = await getRefundRequestsByBookingId(ctx.booking.id);
              const r = rows[0];
              return { done: !!r && r.status !== 'held_dispute', value: r };
            },
            { timeoutMs: 180000, intervalMs: 6000, desc: `refund_request for ${ctx.booking.id} to leave held_dispute` }
          );
          const refunds = (await getBookingTransactions(ctx.tokens, ctx.booking.id)).filter((t) => t.type === 'refund');
          assert(refunds.length === 1, `expected the ONE held refund row to be closed in place, got ${refunds.length}`);
          console.log(`    · refund_request ${req.id} → ${req.status}; ledger row → ${refunds[0].status} at ${refunds[0].amount}`);

          if (buyerWon) {
            // PayPal already returned the money to the buyer. We must never
            // also send a refund.
            assert(
              req.status === 'settled_by_chargeback',
              `a buyer win means PayPal already paid the guest — the held request must close as ` +
                `'settled_by_chargeback', never 'refunded' — got '${req.status}'`
            );
            assert(
              !req.refund_id || String(req.refund_id).startsWith('chargeback:'),
              `no provider refund may be issued when the buyer already won; refund_id=${req.refund_id}`
            );
            assert(refunds[0].status !== 'on_hold', `the held refund row must reach a terminal state, still 'on_hold'`);
          } else {
            // Seller win. Per the 2026-09-01 decision recorded at
            // payment-service payment_dispute.go:353-362 the parked policy
            // refund is NOT paid on top of a win — that would make disputing
            // risk-free. Same rule as the Stripe flow asserts.
            assert(
              req.status === 'rejected',
              `a seller win is the provider's final word for this charge: the held policy refund must be closed ` +
                `unpaid ('rejected'), not paid on top — got '${req.status}'`
            );
            assert(
              refunds[0].status === 'cancelled',
              `the guest's on-hold refund row must resolve to 'cancelled' (no money moved) on a seller win, got '${refunds[0].status}'`
            );
            assert(
              Math.abs(refunds[0].amount) < 0.005,
              `a seller win pays the guest nothing — expected the closed refund row at 0, got ${refunds[0].amount}`
            );
          }
          return;
        }

        // complete track — the host's money.
        const payout = await poll(
          async () => {
            const rows = await getPayoutsByBookingId(ctx.booking.id);
            const p = rows[0];
            const settled = p && (p.dispute_info?.status === ctx.expectedInternal || p.has_dispute === !buyerWon);
            return { done: !!settled, value: p };
          },
          {
            timeoutMs: 180000,
            intervalMs: 6000,
            desc: `payout for ${ctx.booking.id} to record the ${ctx.expectedInternal} outcome`,
          }
        );
        console.log(
          `    · payout ${payout.id} status=${payout.status} has_dispute=${payout.has_dispute} ` +
            `dispute_info.status=${payout.dispute_info?.status} last_error=${JSON.stringify(payout.last_error || '')}`
        );

        if (buyerWon) {
          assert(
            payout.status === 'blocked',
            `the buyer won, so the host is not paid from this charge — payout must stay 'blocked', got '${payout.status}'`
          );
          assert(payout.has_dispute === true, `a lost dispute must leave the payout flagged, got has_dispute=${payout.has_dispute}`);
        } else {
          assert(
            payout.has_dispute === false,
            `a seller win must stop the dispute blocking the payout — expected has_dispute=false, got ${payout.has_dispute}`
          );
          assert(
            payout.dispute_info?.status === 'won',
            `expected the payout's dispute_info to record the won outcome, got ${JSON.stringify(payout.dispute_info)}`
          );
          assert(
            !/[Dd]ispute/.test(payout.last_error || ''),
            `the dispute must no longer be the reason the payout is held — last_error=${JSON.stringify(payout.last_error)}`
          );
          if (payout.status === 'blocked') {
            // Correct for a method-less host, and only for that reason.
            assert(
              ['(none)', 'not_specified'].includes(ctx.hostPayoutMethod),
              `payout stayed blocked but the host's payout_method is '${ctx.hostPayoutMethod}' — that is not the ` +
                'no-method case, so a seller win left it stuck'
            );
            console.log(`    · payout remains blocked for host_payout_method_not_configured (fixture ceiling, see header)`);
          }
        }
      },
    },
  ],
};
