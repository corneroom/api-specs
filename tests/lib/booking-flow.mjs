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
//
// 429 is retried too, and much more patiently: user-service rate-limits its
// whole auth group (register / confirm / login / refresh / password reset) to
// **10 requests per minute per IP** (`httprate.LimitByIP(10, 1*time.Minute)`,
// user-service internal/rest/controller.go:93). Every registerFreshUser call
// costs TWO of those, so several write flows registering throwaway accounts
// back to back will trip it from a single CI runner IP — as this suite did on
// 2026-09-12 (8 cases failed with "register/confirm failed 429"). The limiter
// is a one-minute window, so back off past it rather than working around a
// real product protection.
const RATE_LIMIT_BACKOFF_MS = 30000;

async function gwFetch(url, opts, { retries = 1, delayMs = 3000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    const retryable = res.status === 429 || [502, 503, 504].includes(res.status);
    if (!retryable || attempt >= retries) return res;
    await new Promise((r) => setTimeout(r, res.status === 429 ? RATE_LIMIT_BACKOFF_MS : delayMs));
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
  // Two extra attempts each: these are the auth-group calls the 10/min/IP
  // limiter guards, and a whole flow should wait it out rather than fail.
  await gwFetch(
    `${config.gwUrl}/users/register/email`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    { retries: 2 }
  );
  const confirmRes = await gwFetch(
    `${config.gwUrl}/users/register/email/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: email, otp: OTP_BYPASS }),
    },
    { retries: 2 }
  );
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

// ─── Fixture selection: BOT HOSTS ONLY ──────────────────────────────────────
//
// Every booking and cancellation this suite makes notifies the listing's HOST
// for real — push to their phone, email, the lot (messaging-service reacts to
// booking-events). Until 2026-09-12 the pickers below returned whatever the
// feed happened to list first at a given price, and on staging that was
// `UaoXDcGpcjVP2z0BauQY` ($5 "Reserved Parking Spot"), hosted by a genuine
// signed-in account — so the 6-hourly CI run was paging a real person a
// dozen times a night. Seeded QA/bot hosts have no device and no inbox, so
// every fixture used here MUST be bot-hosted.
//
// HOW "is this host a bot?" IS DERIVED — this is the fiddly part:
//   - `GET /listings` (the feed) does NOT tell you. Its mapper builds the host
//     object from the listing's denormalised snapshot and simply omits the
//     field (listing-service internal/rest/util.go:346-353), and the response
//     struct has `json:"is_bot,omitempty"`, so it is absent, not false.
//   - `GET /listings/{id}` DOES tell you: the detail path loads the live host
//     via listingService.GetHost and copies IsBot through
//     (listing-service internal/rest/controller.go:862), reading the user
//     doc's `bot` flag (user-service internal/data/user.go:52).
// So the pool is built the only honest way available over the gateway: list,
// then one detail fetch per candidate. Hard-coding known bot host ids would be
// brittle the moment staging is reseeded — the flag is re-derived every run.
//
// The pool is deliberately restricted to `usd` fixtures: coupons are USD, and
// `calcPricing`/`createPaymentIntent` default to usd, so a non-USD fixture
// silently mixes currencies into money assertions. That keeps the pool small
// enough (13 USD instant-book listings on staging today) that verifying every
// one of them costs ~13 requests, cached for the whole process.
const FIXTURE_CURRENCY = 'usd';

// The feed caps `limit` at 100 and pages by `cursor` = the last doc id it
// returned (listing-service internal/rest/controller.go:624-634), so the full
// instant-bookable set needs several passes.
async function listAllInstantBookListings(tokens) {
  const out = [];
  const seen = new Set();
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const url = `${config.gwUrl}/listings?limit=100&instant_book=true${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await gwFetch(url, { headers: authHeaders(tokens, 'full') });
    const batch = (await res.json()).data ?? [];
    if (batch.length === 0) break;
    const before = seen.size;
    for (const l of batch) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l);
    }
    if (seen.size === before) break; // cursor stopped advancing — we've seen it all
    cursor = batch[batch.length - 1].id;
  }
  return out;
}

// The single listing read that exposes `host.is_bot` (see the note above).
export async function getListingDetail(tokens, id) {
  const res = await gwFetch(`${config.gwUrl}/listings/${id}`, { headers: authHeaders(tokens, 'full') });
  if (res.status !== 200) throw new Error(`GET /listings/${id} failed ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

// Built once per process — it's public, read-only data and every flow wants
// the same answer, so paying for ~13 detail fetches per test file would be
// pure waste. A failed build is not cached, so a transient 502 mid-pool
// doesn't poison the whole run.
let botPoolPromise;
async function botFixturePool(tokens) {
  if (!botPoolPromise) {
    botPoolPromise = buildBotFixturePool(tokens).catch((e) => {
      botPoolPromise = undefined;
      throw e;
    });
  }
  return botPoolPromise;
}

async function buildBotFixturePool(tokens) {
  const candidates = (await listAllInstantBookListings(tokens))
    .filter((l) => l.currency === FIXTURE_CURRENCY && typeof l.price === 'number')
    .sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  const pool = [];
  for (const l of candidates) {
    const detail = await getListingDetail(tokens, l.id);
    if (detail?.host?.is_bot === true) pool.push({ ...l, host: { ...l.host, is_bot: true } });
  }
  if (pool.length === 0) {
    throw new Error(
      `no bot-hosted ${FIXTURE_CURRENCY.toUpperCase()} instant-book listing found among ${candidates.length} candidates — ` +
        'this suite must never book a real host (they get a push notification per booking); reseed staging bot listings'
    );
  }
  console.log(`    · bot fixture pool: ${pool.length} ${FIXTURE_CURRENCY} instant-book listings (${pool.map((l) => l.price).join(', ')})`);
  return pool;
}

function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Picks `count` DISTINCT bot-hosted USD fixtures, at random across everything
// that qualifies rather than always the cheapest. Spreading bookings over the
// whole pool is the cheap defence against the date-crowding flake that a
// single shared fixture kept causing ("listing is not available for these
// dates" — see tests/README.md's leak-discipline note): `futureDates()` picks
// from a ~300-day window, so ten listings means ten times the room.
//
// Throws (rather than returning null) when staging can't satisfy the request —
// a missing fixture is an environment problem and the message should say which
// constraint failed, not surface as a bare "listing is undefined" later.
export async function pickListings(tokens, count, { minPrice = 1, maxPrice = Infinity, policy, exclude = [] } = {}) {
  const pool = await botFixturePool(tokens);
  const qualifying = pool.filter(
    (l) => l.price >= minPrice && l.price <= maxPrice && !exclude.includes(l.id) && (!policy || l.cancellation_policy === policy)
  );
  if (qualifying.length < count) {
    throw new Error(
      `need ${count} bot-hosted ${FIXTURE_CURRENCY} listing(s) priced ${minPrice}-${maxPrice}` +
        `${policy ? ` with cancellation_policy=${policy}` : ''}, found ${qualifying.length} in a pool of ${pool.length}`
    );
  }
  const chosen = shuffled(qualifying).slice(0, count);
  for (const l of chosen) {
    console.log(`    · fixture ${l.id} — ${l.price} ${l.currency}, ${l.cancellation_policy}, bot host ${l.host.id}`);
  }
  return chosen;
}

// One bot-hosted USD fixture. `minPrice` is what the money flows actually care
// about: a referral coupon is worth $5, so a qualifying booking has to cost at
// least that much for the discount to leave a real, above-Stripe-minimum
// balance to charge (the coupon-vs-minimum gotcha in tests/README.md). There
// is no bot-hosted $5 listing on staging — the only $5 one is the real host's
// — hence ">= 5", not "== 5".
export async function pickListing(tokens, opts = {}) {
  const [listing] = await pickListings(tokens, 1, opts);
  return listing;
}

// A bot-hosted free fixture — the SetupIntent path, no charge.
export async function pickFreeListing(tokens) {
  return pickListing(tokens, { minPrice: 0, maxPrice: 0 });
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

// NOTE: booking-service keeps ONE draft per (user, listing) — initiating twice
// for the same listing returns the SAME booking id with the new dates, it does
// not create a second booking. A flow that needs two concurrent drafts for one
// user must use two DIFFERENT listings (see pickListings).
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
// Raw form: returns { status, data } without throwing, for flows that assert
// on a REFUSAL (payment-service refuses a second intent once the booking is
// already authorized — see open_intent.go `errIntentAlreadyAuthorized`).
// `currency` defaults to usd; pass the listing's own currency when the fixture
// isn't a USD listing.
export async function createPaymentIntentRaw(tokens, { bookingId, guestId, hostId, listingId, amount, currency = 'usd', couponCode }) {
  const body = { booking_id: bookingId, guest_id: guestId, host_id: hostId, listing_id: listingId, amount, currency };
  if (couponCode) body.coupon_code = couponCode;
  const res = await gwFetch(`${config.gwUrl}/payments/intents`, {
    method: 'POST',
    headers: { ...authHeaders(tokens, 'full'), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data };
}

export async function createPaymentIntent(tokens, opts) {
  const { status, data } = await createPaymentIntentRaw(tokens, opts);
  if (status !== 201) throw new Error(`POST /payments/intents failed ${status}: ${JSON.stringify(data)}`);
  return data;
}

// Tokenizes a Stripe TEST TOKEN (raw-card tokenization is disabled for this
// Stripe sandbox's publishable key) and confirms directly against Stripe —
// exactly what the mobile PaymentSheet does client-side, publishable key only,
// no backend secret involved.
//
// `cardToken` defaults to the plain success card. Pass another documented test
// token to drive a different outcome — e.g. `tok_createDispute` (card
// 4000 0000 0000 0259), which succeeds and is then disputed as fraudulent by
// Stripe a few seconds after capture. See https://docs.stripe.com/testing.
async function confirmWithTestCard(kind, intent, cardToken = 'tok_visa') {
  const auth = 'Basic ' + Buffer.from(`${intent.publishable_key}:`).toString('base64');
  const pmRes = await fetch('https://api.stripe.com/v1/payment_methods', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `type=card&card[token]=${cardToken}`,
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
export const payWithTestCard = (intent, cardToken) => confirmWithTestCard('payment_intents', intent, cardToken);

// Free ($0) bookings route through a SetupIntent instead (no charge).
export const confirmSetupIntent = (intent) => confirmWithTestCard('setup_intents', intent);

// Reads a PaymentIntent back from Stripe with the PUBLISHABLE key + the
// intent's client_secret — the only Stripe read a client is allowed to make,
// and the same one the mobile SDK does. Returns Stripe's (client-scoped)
// object: `status` and `amount` are present, secret-key-only fields are not.
// Use it to prove what actually happened on Stripe's side rather than
// trusting our own API's echo of it.
export async function getStripeIntent(intent) {
  const auth = 'Basic ' + Buffer.from(`${intent.publishable_key}:`).toString('base64');
  const res = await fetch(
    `https://api.stripe.com/v1/payment_intents/${intent.id}?client_secret=${encodeURIComponent(intent.client_secret)}`,
    { headers: { Authorization: auth } }
  );
  const json = await res.json();
  if (json.error) throw new Error(`Stripe payment_intents retrieve failed: ${JSON.stringify(json.error)}`);
  return json;
}

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

// Removes a booking that never got paid (status `draft`). The cancel endpoint
// is for CONFIRMED bookings; a draft is deleted. Use this to clean up any
// draft a flow initiates, so it stops occupying its listing's dates and its
// coupon hold (payment-service releases the hold on draft delete).
export async function deleteDraftBooking(tokens, bookingId) {
  const res = await gwFetch(`${config.gwUrl}/bookings/${bookingId}`, {
    method: 'DELETE',
    headers: authHeaders(tokens, 'full'),
  });
  if (![200, 204, 404].includes(res.status)) {
    throw new Error(`DELETE /bookings/${bookingId} failed ${res.status}: ${await res.text()}`);
  }
}

// Leak-safe teardown for a booking in ANY state: a draft is deleted, an
// already-cancelled booking is left alone, anything else is cancelled. Use it
// from a flow's trailing cleanup case (lib/runner.mjs keeps running cases past
// a failure precisely so cleanup still executes) so a mid-flow failure can't
// leave a booking squatting on a shared staging listing's dates.
export async function teardownBooking(tokens, bookingId) {
  if (!bookingId) return;
  const booking = await getBooking(tokens, bookingId);
  if (booking.status === 'draft') await deleteDraftBooking(tokens, bookingId);
  else if (booking.status !== 'cancelled') await cancelBooking(tokens, bookingId);
}

// Runs the full initiate -> price -> intent -> Stripe confirm -> finalize ->
// poll-until-confirmed dance for a real paid (or free, if listing.price===0)
// booking. Returns { bookingId, total, currency, intentId } once the gateway
// reports the booking as confirmed.
//
// `currency` defaults to usd, which is also all the fixture pool contains
// (see FIXTURE_CURRENCY); pass the listing's own currency for anything else.
// `cardToken` is handed to Stripe — pass `tok_createDispute` to end up with a
// charge that Stripe disputes.
// `onDraft` is called with the booking id the instant it exists, BEFORE
// anything that can fail (payment, finalize, the confirm poll) — record it so
// a cleanup case can still tear the booking down if this throws half way.
export async function bookAndConfirm(tokens, listing, { guestId, hostId, couponCode, currency = 'usd', cardToken, onDraft } = {}) {
  const dates = futureDates();
  const draft = await initiateBooking(tokens, listing.id, dates);
  if (onDraft) onDraft(draft.id);
  const pricing = await calcPricing(tokens, listing.price);
  const intent = await createPaymentIntent(tokens, {
    bookingId: draft.id,
    guestId,
    hostId,
    listingId: listing.id,
    amount: pricing.total,
    currency,
    couponCode,
  });
  if (intent.intent_type === 'setup_intent') {
    await confirmSetupIntent(intent);
  } else {
    await payWithTestCard(intent, cardToken);
  }
  await finalizeBooking(tokens, draft.id, { dates, paymentReference: intent.id, amount: pricing.total });
  await poll(
    async () => {
      const b = await getBooking(tokens, draft.id);
      return { done: b.status === 'confirmed', value: b.status };
    },
    { timeoutMs: 45000, intervalMs: 4000, desc: `booking ${draft.id} to reach status=confirmed` }
  );
  return { bookingId: draft.id, total: pricing.total, currency, intentId: intent.id };
}
