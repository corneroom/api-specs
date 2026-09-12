// payment-service × reward-service — one coupon can only ever discount ONE
// booking at a time. reward-service takes an exclusive hold on a coupon at
// validate time, keyed on the booking id (`held_by`), and payment-service is
// the side responsible for RELEASING that hold when a booking stops needing it
// (open_intent.go `reconcileCouponHold` / `releaseCouponOnBookingCancel`).
// Three real money bugs have come out of this pair — a re-hold of an already
// redeemed coupon, stale intent metadata redeeming a removed coupon, and an
// A→B swap stranding A's hold forever (CR-645/CR-652, Aug 2026; the Sep-07
// Stripe reconciliation incident stranded another). The invariant worth
// guarding from outside is simple and money-shaped: **the same coupon must
// never be simultaneously applied to two unconfirmed checkouts.**
//
// What this proves, end to end against staging:
//   1. booking A applies the coupon      -> discounted, wallet says held_by=A
//   2. booking B quotes the same coupon  -> valid:false, reason in_use
//   3. booking B applies the same coupon -> NO discount, reason in_use,
//                                           and A still holds it (no swap,
//                                           no double discount)
//   4. booking A drops the coupon        -> hold released, wallet free again
//   5. booking B applies it now          -> discounted, wallet says held_by=B
// Step 3 is the one that matters: a regression there is a guest paying twice
// with the same $5.
//
// This is a deliberate WRITE-path flow (see tests/README.md) and a heavy one:
// minting a coupon at all requires a real referral pair plus a real
// Stripe-sandbox paid booking, because there is no API to hand a user a
// coupon. Each `run` case is one step, sharing state via closure — see
// lib/runner.mjs's `run:` case type.
//
// LEAK DISCIPLINE (learned the hard way in rewards-referral-flow.mjs — read
// its header): every booking created here is torn down at the end of the run.
// The two checkout bookings are never paid, so they stay `draft` and are
// DELETED (a draft is not cancellable); the qualifying booking is paid, so it
// is CANCELLED. Without this, the 6h-cadence CI run piles up bookings on a
// handful of shared staging listings until date collisions make
// POST /bookings/initiate start 400ing. When adding a scenario here, add its
// cleanup in the same change.
//
// Fixtures: the qualifying booking needs the $5 USD listing (a $5 coupon must
// leave a non-zero, above-Stripe-minimum balance). Bookings A and B must be on
// two DIFFERENT listings — booking-service keeps one draft per (user, listing),
// so initiating twice on one listing returns the same booking and proves
// nothing.
import {
  registerFreshUser,
  pickListing,
  listListings,
  futureDates,
  initiateBooking,
  calcPricing,
  createPaymentIntent,
  bookAndConfirm,
  deleteDraftBooking,
  teardownBooking,
} from '../lib/booking-flow.mjs';
import { getWallet, getMyReferral, applyReferralCode } from '../lib/reward-helpers.mjs';
import { quoteCoupon } from '../lib/payment-helpers.mjs';
import { poll } from '../lib/poll.mjs';

const ctx = {};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// The single wallet coupon, as reward-service currently sees it.
async function walletCoupon() {
  const wallet = await getWallet(ctx.referred.tokens);
  assert(wallet.length === 1, `expected exactly 1 coupon in the wallet, got ${JSON.stringify(wallet)}`);
  return wallet[0];
}

// held_by is only eventually consistent with a create-intent call that
// released a hold (payment-service releases best-effort, after responding).
async function waitForHeldBy(expected, desc) {
  return poll(
    async () => {
      const c = await walletCoupon();
      return { done: (c.held_by ?? '') === expected, value: c.held_by ?? '' };
    },
    { timeoutMs: 30000, intervalMs: 3000, desc }
  );
}

// Everything a checkout needs for one of the two draft bookings.
async function openCheckout(listing) {
  const booking = await initiateBooking(ctx.referred.tokens, listing.id, futureDates());
  const pricing = await calcPricing(ctx.referred.tokens, listing.price);
  return { id: booking.id, listing, total: pricing.total, currency: listing.currency };
}

function intentFor(checkout, couponCode) {
  return createPaymentIntent(ctx.referred.tokens, {
    bookingId: checkout.id,
    guestId: ctx.referred.id,
    hostId: checkout.listing.host.id,
    listingId: checkout.listing.id,
    amount: checkout.total,
    currency: checkout.currency,
    couponCode,
  });
}

export default {
  name: 'payment-service × reward-service (coupon hold is exclusive across bookings)',
  cases: [
    {
      name: 'setup: referral pair earns a real $5 coupon, and two checkouts are opened on two different listings',
      run: async () => {
        ctx.referrer = await registerFreshUser('CouponHoldRef');
        ctx.referred = await registerFreshUser('CouponHoldGuest');
        const code = (await getMyReferral(ctx.referrer.tokens)).code;
        await applyReferralCode(ctx.referred.tokens, code);

        const qualifyingListing = await pickListing(ctx.referred.tokens, { price: 5 });
        assert(qualifyingListing, 'no $5 instant-book listing found on staging to mint a coupon with');
        ctx.qualifying = await bookAndConfirm(ctx.referred.tokens, qualifyingListing, {
          guestId: ctx.referred.id,
          hostId: qualifyingListing.host.id,
          onDraft: (id) => {
            ctx.qualifyingId = id;
          },
        });
        const wallet = await poll(
          async () => {
            const w = await getWallet(ctx.referred.tokens);
            return { done: w.length > 0, value: w };
          },
          { desc: 'referred wallet to receive the referral coupon' }
        );
        ctx.coupon = wallet[0].code;
        assert(ctx.coupon, `expected a coupon code in the wallet, got ${JSON.stringify(wallet)}`);
        assert(!wallet[0].held_by, `a freshly issued coupon must be unheld, got held_by=${wallet[0].held_by}`);

        // Two DIFFERENT listings, deterministically chosen: cheapest first,
        // excluding the $5 fixture. Priced 6-30 so the ~$5 discount always
        // leaves a chargeable remainder above Stripe's minimum.
        const candidates = (await listListings(ctx.referred.tokens))
          .filter((l) => l.id !== qualifyingListing.id && l.price >= 6 && l.price <= 30)
          .sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
        assert(candidates.length >= 2, `need 2 bookable listings priced 6-30 on staging, found ${candidates.length}`);
        ctx.a = await openCheckout(candidates[0]);
        ctx.b = await openCheckout(candidates[1]);
        assert(ctx.a.id !== ctx.b.id, 'checkouts A and B must be two distinct bookings');
      },
    },
    {
      name: 'booking A applies the coupon: discount lands on the intent and the wallet records the hold as A',
      run: async () => {
        const intent = await intentFor(ctx.a, ctx.coupon);
        assert(intent.coupon_code === ctx.coupon, `expected coupon ${ctx.coupon} applied to A, got ${JSON.stringify(intent)}`);
        assert(intent.coupon_discount > 0, `expected a non-zero discount on A, got ${intent.coupon_discount}`);
        assert(
          intent.amount < ctx.a.total,
          `expected A's intent to be charged less than the ${ctx.a.total} pre-discount total, got ${intent.amount}`
        );
        ctx.aIntentId = intent.id;

        const coupon = await walletCoupon();
        assert(coupon.held_by === ctx.a.id, `expected wallet held_by=${ctx.a.id} (booking A), got ${JSON.stringify(coupon)}`);
      },
    },
    {
      name: 'booking B quoting the SAME coupon is rejected in_use (read-only quote agrees with the hold)',
      run: async () => {
        const quote = await quoteCoupon(ctx.referred.tokens, {
          bookingId: ctx.b.id,
          couponCode: ctx.coupon,
          amount: ctx.b.total,
          currency: ctx.b.currency,
        });
        assert(quote.valid === false, `a coupon held by another booking must not quote as valid, got ${JSON.stringify(quote)}`);
        assert(quote.coupon_reason_code === 'in_use', `expected coupon_reason_code=in_use, got ${JSON.stringify(quote)}`);
        assert(quote.coupon_discount === 0, `expected no discount quoted for B, got ${quote.coupon_discount}`);
        assert(
          quote.discounted_total === ctx.b.total,
          `expected B's quoted total to stay at the full ${ctx.b.total}, got ${quote.discounted_total}`
        );

        // A quote must never move the hold — it takes none by contract.
        const coupon = await walletCoupon();
        assert(coupon.held_by === ctx.a.id, `quoting must not change the hold; expected held_by=${ctx.a.id}, got ${coupon.held_by}`);
      },
    },
    {
      // THE assertion in this file: two live checkouts, one coupon, no double
      // discount — and A's hold is not silently stolen by B either.
      name: 'THE GUARD: booking B applying the SAME coupon gets NO discount (in_use) and A keeps the hold — never a double discount',
      run: async () => {
        const intent = await intentFor(ctx.b, ctx.coupon);
        assert(
          !intent.coupon_code,
          `double-discount regression: coupon ${ctx.coupon} is held by booking A but was ALSO applied to booking B (${JSON.stringify(intent)})`
        );
        assert(!intent.coupon_discount, `expected no discount on B, got ${intent.coupon_discount}`);
        assert(intent.coupon_reason_code === 'in_use', `expected coupon_reason_code=in_use on B's intent, got ${JSON.stringify(intent)}`);
        assert(
          Math.abs(intent.amount - ctx.b.total) < 0.005,
          `expected B to be charged the full ${ctx.b.total}, got ${intent.amount}`
        );
        assert(intent.id !== ctx.aIntentId, "B's intent must be its own, not A's");
        ctx.bIntentId = intent.id;

        const coupon = await walletCoupon();
        assert(
          coupon.held_by === ctx.a.id,
          `a rejected apply must leave the hold with booking A; expected held_by=${ctx.a.id}, got ${JSON.stringify(coupon)}`
        );
      },
    },
    {
      name: 'booking A dropping the coupon releases the hold (a re-priced intent with no coupon_code is a genuine removal)',
      run: async () => {
        const intent = await intentFor(ctx.a);
        assert(!intent.coupon_code, `expected A's intent to carry no coupon after removal, got ${JSON.stringify(intent)}`);
        assert(
          Math.abs(intent.amount - ctx.a.total) < 0.005,
          `expected A back at the full ${ctx.a.total} after dropping the coupon, got ${intent.amount}`
        );
        const heldBy = await waitForHeldBy('', "booking A's coupon hold to be released");
        assert(heldBy === '', `expected the coupon to be free again, still held by ${heldBy}`);
      },
    },
    {
      name: 'booking B can now apply the coupon: the hold moves to B and the discount lands',
      run: async () => {
        const intent = await intentFor(ctx.b, ctx.coupon);
        assert(intent.coupon_code === ctx.coupon, `expected coupon ${ctx.coupon} applied to B once free, got ${JSON.stringify(intent)}`);
        assert(intent.coupon_discount > 0, `expected a non-zero discount on B, got ${intent.coupon_discount}`);
        assert(intent.amount < ctx.b.total, `expected B discounted below ${ctx.b.total}, got ${intent.amount}`);

        const coupon = await walletCoupon();
        assert(coupon.held_by === ctx.b.id, `expected wallet held_by=${ctx.b.id} (booking B), got ${JSON.stringify(coupon)}`);
      },
    },
    {
      // Cleanup + one last assertion: deleting the draft that holds the coupon
      // must hand it back (a guest who abandons a checkout keeps their reward).
      name: "cleanup: delete both draft checkouts — deleting B's draft releases its coupon hold",
      run: async () => {
        if (!ctx.a || !ctx.b) return; // setup never got that far; nothing to delete
        await deleteDraftBooking(ctx.referred.tokens, ctx.a.id);
        await deleteDraftBooking(ctx.referred.tokens, ctx.b.id);
        const heldBy = await waitForHeldBy('', 'the coupon hold to be released when its draft checkout is deleted');
        assert(heldBy === '', `abandoning a checkout must free the coupon, still held by ${heldBy}`);
      },
    },
    {
      // Cleanup only. Cancelling the qualifying booking claws the coupon back
      // (CR-588 — covered by rewards-referral-flow.mjs, not re-asserted here);
      // it must therefore run last, after every wallet assertion above.
      // Tolerant of any state: setup may have failed before the booking was
      // ever paid, and it still must not be left on the shared $5 listing.
      name: 'cleanup: cancel the qualifying paid booking',
      run: async () => {
        await teardownBooking(ctx.referred.tokens, ctx.qualifyingId);
      },
    },
  ],
};
