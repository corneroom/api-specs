// payment-service — ONE live PaymentIntent per booking, never an orphan and
// never a second authorization.
//
// The app asks for a "fresh" intent on every Pay tap, coupon change and
// payment-method switch, and cannot cancel what it abandons. Before 2026-08-27
// every such request minted a NEW Stripe PaymentIntent and nothing killed the
// old one: a Stripe export for Aug 2-27 showed 125 of 251 intents abandoned in
// requires_payment_method (one booking had 38), 18 uncaptured holds, and —
// the expensive part — several bookings authorized TWICE, i.e. two real holds
// on one guest's card for one stay. The fix (internal/service/open_intent.go,
// `data.OpenIntent` keyed `booking:<id>`) gave the server a memory:
//   - reusable intent (requires_payment_method / requires_confirmation)
//     -> reuse it, re-pricing in place when the amount changed
//   - requires_action / canceled -> cancel it, then create a fresh one
//   - requires_capture / succeeded / processing -> REFUSE outright
//     (`errIntentAlreadyAuthorized`), rather than place a second hold
//
// This flow proves all of that from outside, against real Stripe sandbox
// objects, for a single booking:
//   1. first create                     -> a Stripe intent exists, unconfirmed
//   2. identical second create          -> the SAME intent id (no orphan)
//   3. create at a different amount     -> still the SAME id, re-priced on
//                                          Stripe itself (not just in our echo)
//   4. pay + finalize with that id      -> booking confirms normally
//   5. create again, now authorized     -> REFUSED, no second intent handed
//                                          out, Stripe's intent untouched
// Step 2/3 catch the orphan-intent regression; step 5 catches the
// double-authorization one.
//
// Stripe is read back with the PUBLISHABLE key + client_secret (lib/
// booking-flow.mjs `getStripeIntent`) — the same client-scoped read the mobile
// SDK does, no secret key anywhere in this suite.
//
// LEAK DISCIPLINE (see rewards-referral-flow.mjs's header): the one booking
// this file creates is paid, so it is CANCELLED at the end — otherwise the
// 6h-cadence CI run accumulates confirmed bookings on the shared $5 staging
// fixture until date collisions make POST /bookings/initiate start 400ing.
import {
  registerFreshUser,
  pickListing,
  futureDates,
  initiateBooking,
  calcPricing,
  createPaymentIntent,
  createPaymentIntentRaw,
  getStripeIntent,
  payWithTestCard,
  finalizeBooking,
  getBooking,
  teardownBooking,
} from '../lib/booking-flow.mjs';
import { poll } from '../lib/poll.mjs';

const ctx = {};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function createIntent(amount) {
  return createPaymentIntentRaw(ctx.guest.tokens, {
    bookingId: ctx.booking.id,
    guestId: ctx.guest.id,
    hostId: ctx.listing.host.id,
    listingId: ctx.listing.id,
    amount,
  });
}

export default {
  name: 'payment-service (one live PaymentIntent per booking — no orphans, no double authorization)',
  cases: [
    {
      name: 'setup: a fresh guest opens a checkout on the $5 listing',
      run: async () => {
        ctx.guest = await registerFreshUser('IntentReuse');
        ctx.listing = await pickListing(ctx.guest.tokens, { price: 5 });
        assert(ctx.listing, 'no $5 instant-book listing found on staging to open a checkout on');
        ctx.dates = futureDates();
        ctx.booking = await initiateBooking(ctx.guest.tokens, ctx.listing.id, ctx.dates);
        ctx.pricing = await calcPricing(ctx.guest.tokens, ctx.listing.price);
      },
    },
    {
      name: 'first POST /payments/intents creates an unconfirmed Stripe intent for the booking',
      run: async () => {
        const { status, data } = await createIntent(ctx.pricing.total);
        assert(status === 201, `expected 201 from the first create, got ${status}`);
        assert(data?.id?.startsWith('pi_'), `expected a Stripe PaymentIntent id, got ${JSON.stringify(data)}`);
        ctx.intent = data;

        const stripeIntent = await getStripeIntent(data);
        assert(
          stripeIntent.status === 'requires_payment_method',
          `expected a fresh, unconfirmed Stripe intent, got status=${stripeIntent.status}`
        );
      },
    },
    {
      // The orphan-prevention assertion: re-tapping Pay must not mint a second
      // Stripe object behind the guest's back.
      name: 'THE GUARD: an identical second request REUSES the same intent — no second Stripe object is minted',
      run: async () => {
        const { status, data } = await createIntent(ctx.pricing.total);
        assert(status === 201, `expected 201 from the repeat create, got ${status}`);
        assert(
          data.id === ctx.intent.id,
          `orphan-intent regression: a repeat create for booking ${ctx.booking.id} minted a NEW intent ${data.id} ` +
            `instead of reusing ${ctx.intent.id} — the abandoned one would sit in requires_payment_method forever`
        );
      },
    },
    {
      // Same guard, the path the app actually takes most often: the total
      // changed (coupon applied/removed, re-price). Stripe must show the
      // re-price on the ORIGINAL object.
      name: 'a request at a different amount re-prices the SAME intent in place (verified on Stripe, not just in our response)',
      run: async () => {
        const repriced = ctx.pricing.total + 1;
        const { status, data } = await createIntent(repriced);
        assert(status === 201, `expected 201 from the re-priced create, got ${status}`);
        assert(data.id === ctx.intent.id, `expected the same intent re-priced, got a new one: ${data.id}`);
        assert(Math.abs(data.amount - repriced) < 0.005, `expected our API to report ${repriced}, got ${data.amount}`);

        const stripeIntent = await getStripeIntent(data);
        assert(
          stripeIntent.amount === Math.round(repriced * 100),
          `expected Stripe's own intent to be re-priced to ${Math.round(repriced * 100)} minor units, got ${stripeIntent.amount}`
        );
        assert(stripeIntent.status === 'requires_payment_method', `expected still unconfirmed, got ${stripeIntent.status}`);
        ctx.intent = data;
        ctx.paidAmount = repriced;
      },
    },
    {
      name: 'the reused intent pays and finalizes the booking normally (reuse is not a dead end)',
      run: async () => {
        await payWithTestCard(ctx.intent);
        await finalizeBooking(ctx.guest.tokens, ctx.booking.id, {
          dates: ctx.dates,
          paymentReference: ctx.intent.id,
          amount: ctx.paidAmount,
        });
        const status = await poll(
          async () => {
            const b = await getBooking(ctx.guest.tokens, ctx.booking.id);
            return { done: b.status === 'confirmed', value: b.status };
          },
          { timeoutMs: 60000, intervalMs: 4000, desc: `booking ${ctx.booking.id} to reach status=confirmed` }
        );
        assert(status === 'confirmed', `expected the booking confirmed, got ${status}`);
      },
    },
    {
      // The double-authorization assertion. Today payment-service surfaces the
      // refusal as a generic 500 (the controller only special-cases
      // "amount too small"); what this test pins is the behaviour that costs
      // money — no second intent is ever handed back, and the authorized one
      // is left exactly as it was. If the status is ever tightened to a 4xx,
      // this case keeps passing.
      name: 'THE GUARD: once the booking is authorized, a further create is REFUSED — no second hold on the card',
      run: async () => {
        const { status, data } = await createIntent(ctx.pricing.total);
        assert(
          status !== 201,
          `double-authorization regression: booking ${ctx.booking.id} is already paid, but another intent was created (${JSON.stringify(data)})`
        );
        assert(status >= 400, `expected an error status for an already-authorized booking, got ${status}`);
        assert(!data?.id, `a refused create must not return an intent, got ${JSON.stringify(data)}`);

        const stripeIntent = await getStripeIntent(ctx.intent);
        assert(
          ['requires_capture', 'succeeded', 'processing'].includes(stripeIntent.status),
          `expected the original intent to still hold the authorization, got status=${stripeIntent.status}`
        );
      },
    },
    {
      // Cleanup only — see the LEAK DISCIPLINE note up top. Tolerant of any
      // state, so a failure earlier in the flow still can't leave a booking
      // squatting on the shared $5 listing's dates.
      name: 'cleanup: cancel the paid booking',
      run: async () => {
        await teardownBooking(ctx.guest.tokens, ctx.booking?.id);
      },
    },
  ],
};
