// Reusable mechanics for scripting a REAL, end-to-end paid booking against
// staging — no mobile app, no Maestro, just fetch against GW_URL + Stripe's
// REST API with a test-mode publishable key. Extracted while building
// tests/services/rewards-referral-flow.mjs (CR-588); reuse this for any
// future write-flow test that needs a genuine confirmed (or cancelled)
// booking rather than mocking one.
//
// STAGING ONLY. Every booking here uses a far-future, randomized date range
// so concurrent suite runs don't collide on the same popular seeded listing
// (availability is overlap-only, not a calendar — see tests/README.md /
// service auth notes).
import { config } from './env.mjs';
import { authHeaders } from './auth.mjs';
import { poll } from './poll.mjs';

const OTP_BYPASS = '264801'; // user-service test-OTP bypass, gated to qa+<digits>@bot.com

function randDigits() {
  return Date.now().toString().slice(-6) + Math.floor(Math.random() * 900 + 100);
}

// Cold-start-tolerant fetch for gateway calls: staging Cloud Run revisions
// occasionally 502/503/504 on the first request after scaling from zero
// (see the startup-probe drift history in tests/README.md's sibling notes) —
// retry once after a short delay before giving up, rather than failing a
// whole multi-minute flow over a single transient upstream timeout.
async function gwFetch(url, opts, { retries = 1, delayMs = 3000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    if (![502, 503, 504].includes(res.status) || attempt >= retries) return res;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

// Registers a throwaway qa+<digits>@bot.com account, confirms it with the
// test-OTP bypass, and sets a name (booking/initiate 400s on an empty
// first_name — CR-521). Returns { email, tokens, id } — tokens are shaped
// exactly like lib/auth.mjs's `login()` output, so `authHeaders(tokens, ...)`
// works unchanged. These are real, non-bot accounts (bot:true is only ever
// set by test-data/scripts/* seeding), which matters for reward-service:
// its referral completion rules skip bot parties entirely.
export async function registerFreshUser(firstName = 'GwTest') {
  const email = `qa+${randDigits()}@bot.com`;
  const password = `Aa1!${randDigits()}zz`;
  await gwFetch(`${config.gwUrl}/users/register/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const confirmRes = await gwFetch(`${config.gwUrl}/users/register/email/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact: email, otp: OTP_BYPASS }),
  });
  if (confirmRes.status !== 200) {
    throw new Error(`register/confirm failed ${confirmRes.status}: ${await confirmRes.text()}`);
  }
  const tokens = { raw: confirmRes.headers.get('x-corneroom-access'), refresh: confirmRes.headers.get('x-corneroom-refresh') };
  if (!tokens.raw) throw new Error('register/confirm ok but no X-Corneroom-Access header returned');

  await gwFetch(`${config.gwUrl}/users/me`, {
    method: 'PATCH',
    headers: { ...authHeaders(tokens, 'full'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ basic_info: { first_name: firstName, last_name: 'Runner' } }),
  });
  const meRes = await gwFetch(`${config.gwUrl}/users/me`, { headers: authHeaders(tokens, 'full') });
  const me = (await meRes.json()).data;
  return { email, tokens, id: me.id };
}

// Finds a real, currently instant-bookable listing. `price` pins an exact
// listing price (e.g. 5 for the usual $5 seeded fixtures so a $5 referral
// coupon leaves a non-zero balance to charge — see the coupon-vs-minimum
// gotcha in tests/README.md); `price: 0` finds a free listing (SetupIntent
// path). Falls back to the cheapest paid listing if no exact match exists.
export async function pickListing(tokens, { price } = {}) {
  const res = await gwFetch(`${config.gwUrl}/listings?limit=100&instant_book=true`, { headers: authHeaders(tokens, 'full') });
  const listings = (await res.json()).data ?? [];
  if (price === 0) return listings.find((l) => l.price === 0) ?? null;
  if (price) return listings.find((l) => l.price === price) ?? listings.find((l) => l.price > 0) ?? null;
  return listings.find((l) => typeof l.price === 'number' && l.price > 0) ?? null;
}

// A far-future, semi-randomized 1-night date range (avoids booking-overlap
// collisions with other concurrent runs on shared staging listings).
export function futureDates() {
  const now = Date.now();
  const offsetDays = 300 + Math.floor(Math.random() * 300);
  return {
    checkIn: new Date(now + offsetDays * 86400000).toISOString(),
    checkOut: new Date(now + (offsetDays + 1) * 86400000).toISOString(),
  };
}

export async function initiateBooking(tokens, listingId, dates) {
  const res = await gwFetch(`${config.gwUrl}/bookings/initiate`, {
    method: 'POST',
    headers: { ...authHeaders(tokens, 'full'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ listing_id: listingId, check_in: dates.checkIn, check_out: dates.checkOut, guests: 1 }),
  });
  if (res.status !== 201) throw new Error(`POST /bookings/initiate failed ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

// NOTE: the response is the pricing breakdown object directly — NOT wrapped
// in the usual { success, data } envelope. Reading `.data.total` silently
// gives undefined.
export async function calcPricing(tokens, subtotal, regionCode = 'US') {
  const res = await gwFetch(`${config.gwUrl}/pricing/calculate?subtotal=${subtotal}&region_code=${regionCode}`, {
    headers: authHeaders(tokens, 'full'),
  });
  if (res.status !== 200) throw new Error(`GET /pricing/calculate failed ${res.status}: ${await res.text()}`);
  return res.json();
}

// amount must be the pricing breakdown's TOTAL (post-fees/tax), not the raw
// subtotal — a coupon is checked against the pre-discount total.
export async function createPaymentIntent(tokens, { bookingId, guestId, hostId, listingId, amount, couponCode }) {
  const body = { booking_id: bookingId, guest_id: guestId, host_id: hostId, listing_id: listingId, amount, currency: 'usd' };
  if (couponCode) body.coupon_code = couponCode;
  const res = await gwFetch(`${config.gwUrl}/payments/intents`, {
    method: 'POST',
    headers: { ...authHeaders(tokens, 'full'), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`POST /payments/intents failed ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

// Tokenizes tok_visa (raw-card tokenization is disabled for this Stripe
// sandbox's publishable key) and confirms directly against Stripe — exactly
// what the mobile PaymentSheet does client-side, publishable key only, no
// backend secret involved.
async function confirmWithTestCard(kind, intent) {
  const auth = 'Basic ' + Buffer.from(`${intent.publishable_key}:`).toString('base64');
  const pmRes = await fetch('https://api.stripe.com/v1/payment_methods', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'type=card&card[token]=tok_visa',
  });
  const pm = await pmRes.json();
  if (!pm.id) throw new Error(`Stripe payment_methods tokenize failed: ${JSON.stringify(pm)}`);

  const confirmRes = await fetch(`https://api.stripe.com/v1/${kind}/${intent.id}/confirm`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `payment_method=${pm.id}&return_url=https://corneroom.com/return&client_secret=${intent.client_secret}`,
  });
  const confirmed = await confirmRes.json();
  if (confirmed.error) throw new Error(`Stripe ${kind} confirm failed: ${JSON.stringify(confirmed.error)}`);
  return confirmed;
}

// Paid bookings use a manual-capture PaymentIntent (moves to
// requires_capture; payment-service auto-captures on the
// amount_capturable_updated webhook).
export const payWithTestCard = (intent) => confirmWithTestCard('payment_intents', intent);

// Free ($0) bookings route through a SetupIntent instead (no charge).
export const confirmSetupIntent = (intent) => confirmWithTestCard('setup_intents', intent);

export async function finalizeBooking(tokens, bookingId, { dates, paymentReference, amount }) {
  const res = await gwFetch(`${config.gwUrl}/bookings/${bookingId}/finalize`, {
    method: 'PATCH',
    headers: { ...authHeaders(tokens, 'full'), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      check_in: dates.checkIn,
      check_out: dates.checkOut,
      guests: 1,
      payment_reference: paymentReference,
      provider: 'stripe',
      amount,
      arrival_window: 'evening',
    }),
  });
  if (res.status !== 200) throw new Error(`PATCH /bookings/${bookingId}/finalize failed ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

export async function getBooking(tokens, bookingId) {
  const res = await gwFetch(`${config.gwUrl}/bookings/${bookingId}`, { headers: authHeaders(tokens, 'full') });
  if (res.status !== 200) throw new Error(`GET /bookings/${bookingId} failed ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

export async function cancelBooking(tokens, bookingId, reasonLabel = 'gateway test cleanup') {
  const res = await gwFetch(`${config.gwUrl}/bookings/${bookingId}/cancel`, {
    method: 'PATCH',
    headers: { ...authHeaders(tokens, 'full'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: 'guest', reason: 'change_of_plans', reason_label: reasonLabel }),
  });
  if (![200, 202].includes(res.status)) throw new Error(`PATCH /bookings/${bookingId}/cancel failed ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

// Runs the full initiate -> price -> intent -> Stripe confirm -> finalize ->
// poll-until-confirmed dance for a real paid (or free, if listing.price===0)
// booking. Returns { bookingId, total } once the gateway reports the booking
// as confirmed.
export async function bookAndConfirm(tokens, listing, { guestId, hostId, couponCode } = {}) {
  const dates = futureDates();
  const draft = await initiateBooking(tokens, listing.id, dates);
  const pricing = await calcPricing(tokens, listing.price);
  const intent = await createPaymentIntent(tokens, {
    bookingId: draft.id,
    guestId,
    hostId,
    listingId: listing.id,
    amount: pricing.total,
    couponCode,
  });
  if (intent.intent_type === 'setup_intent') {
    await confirmSetupIntent(intent);
  } else {
    await payWithTestCard(intent);
  }
  await finalizeBooking(tokens, draft.id, { dates, paymentReference: intent.id, amount: pricing.total });
  await poll(
    async () => {
      const b = await getBooking(tokens, draft.id);
      return { done: b.status === 'confirmed', value: b.status };
    },
    { timeoutMs: 45000, intervalMs: 4000, desc: `booking ${draft.id} to reach status=confirmed` }
  );
  return { bookingId: draft.id, total: pricing.total };
}
