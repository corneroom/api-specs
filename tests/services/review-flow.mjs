// review-service — who may leave a review, when, and what a refusal must not do.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// `services/reviews.mjs` covers three read cases. Nothing covered the WRITE
// path at all, which is the half that decides whether a rating can be
// fabricated: reviews feed a listing's public rating and a host's profile, so
// "a review can only come from someone who actually stayed, after they
// stayed" is a marketplace-integrity rule, not a nicety.
//
// ── CAN A REAL REVIEW BE SUBMITTED ON STAGING? NO — HERE IS THE PROOF ──────
//
// The brief for this file asked for a review on a COMPLETED stay if any path
// to one exists. There is none reachable from the app gateway, and the reason
// is worth writing down so nobody re-derives it:
//
//   1. review-service gates a space review on DATES, not on booking status:
//      the check-in must have passed (`validate_check_in_date`,
//      review-service app/utils/data_helpers.py:128-153, `now >= check_in`)
//      and the review window closes 14 days after check-out
//      (`_review_window_open`, app/service/review_service.py:229-254).
//   2. Every booking this suite can create is 300-600 days in the FUTURE.
//      That is forced: `futureDates()` spreads bookings far out because the
//      suite runs every 6 hours against a handful of shared staging listings
//      and near dates collide (see tests/README.md), and
//      `POST /bookings/initiate` refuses a past check-in outright
//      (booking-service ErrTypeCheckInPast).
//   3. Completing the booking does not help. `PATCH /bookings/{id}/complete`
//      exists and a guest may call it (booking-service
//      internal/rest/controller.go:749-785), but it only moves `status` —
//      `check_in` is untouched (internal/service/booking.go:3942-4010), so the
//      date gate still refuses.
//   4. The experience path is gated on status instead
//      (`create_experience_review` requires `status == "completed"`,
//      review_service.py:668), and no reservation this suite can create is
//      completed either.
//
// So what is drivable — and what this file therefore asserts — is the
// REFUSAL, the authorization, the validation, and, most importantly, that a
// refused review leaves nothing behind. When staging grows a way to produce a
// past-dated stay, the "submit → it appears on the listing → stats move" half
// belongs here.
//
// ── BUGS FOUND WHILE WRITING THIS, NOT FIXED (no backend changes here) ─────
//
// 1. **A refused review answers HTTP 201 Created.** Every business refusal —
//    "You cannot review before the check-in date", "Rating must be between 1
//    and 5", "Only the guest can leave a review" — comes back as
//    `201 {"success":false,"error":...}`. The router only re-raises for
//    "Booking not found" and "already reviewed" (app/routers/review.py:180-186);
//    every other branch returns the error ENVELOPE as a normal return value,
//    so FastAPI stamps it with the route's `status_code=201`
//    (review.py:130-133). Live on staging, confirmed for four distinct
//    refusals. The cases below therefore assert the ENVELOPE (`success:false`,
//    the message, and that nothing was persisted) and deliberately do NOT
//    assert the status code — pinning 201 would cement the bug, and asserting
//    403 would leave the suite permanently red. Fix the router and these cases
//    keep passing unchanged; then add the status assertions.
// 2. **A guest can mark a far-future stay "completed" at will.**
//    `PATCH /bookings/{id}/complete` is routed on the app gateway
//    (gateway/app-swagger.yaml `/bookings/{id}/complete`), accepts either the
//    host OR the guest (controller.go:777-780), and checks only that the
//    booking is `confirmed` — no date check (booking.go:3955-3958). It then
//    publishes `booking_completed` carrying the host's payout method and email
//    (booking.go:3990-4004), which is the event the payout pipeline keys off.
//    NOT exercised here — this file will not move money state on a bot host to
//    prove a point — and reported as a code read, not a live finding.
// 3. **The seeded listings' review counts are not backed by review documents.**
//    The bot host's fixture reports `rating 4.17` / `review_count 21`, while
//    `GET /reviews?target=<that listing>` returns `[]`. The denormalized stats
//    were seeded without the underlying docs. That is seed data, not service
//    behaviour, but it is why nothing here asserts a NON-EMPTY review list.
//
// ── LEAK DISCIPLINE ────────────────────────────────────────────────────────
// One DRAFT booking on a bot-hosted fixture — never paid, so no Stripe object
// and no money at all (the date gate fires long before any status check, so a
// draft is enough to prove every refusal). Its id is recorded before anything
// throwable and the trailing cleanup deletes it and verifies it is gone, so it
// stops occupying its listing's dates.
import { login, loginHost, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';
import { pickListing, initiateBooking, futureDates, deleteDraftBooking, getBooking } from '../lib/booking-flow.mjs';

// The exact metric shapes review-service validates against
// (review-service app/models/review.py:114-134). A wrong shape 422s at the
// FastAPI layer and never reaches the business rules these cases are about.
const SPACE_METRICS = { cleanliness: 5, check_in: 5, accuracy: 5, location: 5, value: 5 };
const GUEST_REVIEWS_HOST_METRICS = { hospitality: 5, communication: 5, cleanliness: 5, respectfulness: 5, would_visit_again: true };
const HOST_REVIEWS_GUEST_METRICS = { communication: 5, cleanliness: 5, respectfulness: 5, would_host_again: true };

const ctx = { guest: null, host: null, guestId: null, listingId: null, bookingId: null };

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function gw(tokens, path, { method = 'GET', body } = {}) {
  const headers = { ...authHeaders(tokens, 'full') };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${config.gwUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, data: json?.data, text };
}

// Reviews actually stored against the fixture booking. The whole point of
// every refusal case is that this stays empty.
async function reviewsForBooking() {
  const res = await gw(ctx.guest, `/reviews?booking_id=${ctx.bookingId}`);
  assert(res.status === 200, `GET /reviews?booking_id expected 200, got ${res.status}: ${res.text}`);
  const rows = Array.isArray(res.data) ? res.data : res.data?.reviews ?? [];
  return rows;
}

export default {
  name: 'review-service (a review can only come from someone who stayed, after they stayed)',
  cases: [
    {
      name: 'setup — a bot-hosted fixture and an unpaid DRAFT booking, 300-600 days out',
      run: async () => {
        ctx.guest = await login();
        ctx.host = await loginHost();
        ctx.guestId = await fetchMeId(ctx.guest);
        assert(ctx.guestId, 'could not resolve the guest id from GET /users/me');

        const listing = await pickListing(ctx.guest, { minPrice: 1 });
        ctx.listingId = listing.id;
        const draft = await initiateBooking(ctx.guest, listing.id, futureDates());
        ctx.bookingId = draft.id; // recorded before anything that can throw
        assert(draft.status === 'draft', `expected a draft booking, got status=${draft.status}`);
        assert((await reviewsForBooking()).length === 0, 'the fixture booking already has reviews — pick a fresh one');
        console.log(`    · draft booking ${ctx.bookingId} on bot listing ${ctx.listingId}`);
      },
    },

    {
      name: 'a guest cannot review a stay that has not started — and the refusal persists nothing',
      run: async () => {
        assert(ctx.bookingId, 'no fixture booking');

        for (const [label, body] of [
          ['type=listing (the space)', { booking_id: ctx.bookingId, type: 'listing', metrics: SPACE_METRICS, comment: 'Gateway suite: this review must be refused.' }],
          ['type=user (the host)', { booking_id: ctx.bookingId, type: 'user', metrics: GUEST_REVIEWS_HOST_METRICS, comment: 'Gateway suite: this review must be refused.' }],
        ]) {
          const res = await gw(ctx.guest, '/reviews', { method: 'POST', body });
          // See header bug 1: the status is 201 today. The claim being made is
          // about the envelope and the absence of a stored review.
          assert(res.json?.success === false, `${label}: a review before check-in must be refused, got ${res.status}: ${res.text}`);
          assert(
            `${res.json?.error ?? ''}`.includes('cannot review before the check-in date'),
            `${label}: expected the check-in date gate to refuse this, got: ${res.json?.error}`
          );
          assert(!res.data, `${label}: a refused review must not return a review body: ${res.text}`);
        }

        const stored = await reviewsForBooking();
        assert(stored.length === 0, `a refused review was persisted anyway: ${JSON.stringify(stored)}`);
      },
    },

    {
      name: 'someone who is not a party to the booking cannot review it either',
      run: async () => {
        assert(ctx.bookingId, 'no fixture booking');
        // The bot HOST account owns a different listing entirely, so it is
        // neither the guest nor the host of this booking.
        for (const [label, body] of [
          ['as a listing review', { booking_id: ctx.bookingId, type: 'listing', metrics: SPACE_METRICS }],
          ['as a user review', { booking_id: ctx.bookingId, type: 'user', metrics: HOST_REVIEWS_GUEST_METRICS }],
        ]) {
          const res = await gw(ctx.host, '/reviews', { method: 'POST', body });
          assert(res.json?.success === false, `${label}: a stranger's review must be refused, got ${res.status}: ${res.text}`);
          assert(!res.data, `${label}: a refused review must not return a review body: ${res.text}`);
        }
        const stored = await reviewsForBooking();
        assert(stored.length === 0, `a stranger's review was persisted: ${JSON.stringify(stored)}`);
      },
    },

    {
      name: 'a review for a booking that does not exist is 404 (and says so properly)',
      run: async () => {
        const res = await gw(ctx.guest, '/reviews', {
          method: 'POST',
          body: { booking_id: 'gateway-suite-no-such-booking', type: 'listing', metrics: SPACE_METRICS },
        });
        assert(res.status === 404, `an unknown booking must 404, got ${res.status}: ${res.text}`);
      },
    },

    {
      name: 'POST /reviews validates its body before it validates anything else',
      run: async () => {
        assert(ctx.bookingId, 'no fixture booking');
        const bad = [
          ['no booking_id', { type: 'listing', metrics: SPACE_METRICS }],
          ['no metrics', { booking_id: ctx.bookingId, type: 'listing' }],
          ['a type that is not user|listing', { booking_id: ctx.bookingId, type: 'nonsense', metrics: SPACE_METRICS }],
          ['metrics that match no review shape', { booking_id: ctx.bookingId, type: 'listing', metrics: { vibes: 5 } }],
        ];
        for (const [label, body] of bad) {
          const res = await gw(ctx.guest, '/reviews', { method: 'POST', body });
          assert(res.status === 422, `${label}: expected 422, got ${res.status}: ${res.text}`);
        }
        assert((await reviewsForBooking()).length === 0, 'a malformed review was persisted');
      },
    },

    {
      name: 'POST /reviews/experience — a space booking is not an experience reservation',
      run: async () => {
        assert(ctx.bookingId, 'no fixture booking');

        // The experience path reads the SAME `bookings` collection but requires
        // type="experience" (review_service.py:658-660), so pointing it at a
        // space booking must 404 rather than cross-write a space review.
        const wrongType = await gw(ctx.guest, '/reviews/experience', {
          method: 'POST',
          body: { booking_id: ctx.bookingId, rating: 5, comment: 'Gateway suite: wrong reservation type.' },
        });
        assert(wrongType.status === 404, `an experience review on a space booking must 404, got ${wrongType.status}: ${wrongType.text}`);

        const noRating = await gw(ctx.guest, '/reviews/experience', { method: 'POST', body: { booking_id: ctx.bookingId } });
        assert(noRating.status === 422, `an experience review with no rating must 422, got ${noRating.status}: ${noRating.text}`);

        // Out of range is a business refusal, so it carries the 201 envelope
        // described in this file's header — assert the envelope.
        const outOfRange = await gw(ctx.guest, '/reviews/experience', {
          method: 'POST',
          body: { booking_id: ctx.bookingId, rating: 9 },
        });
        assert(outOfRange.json?.success === false, `a rating of 9 must be refused, got ${outOfRange.status}: ${outOfRange.text}`);
        assert(
          `${outOfRange.json?.error ?? ''}`.includes('between 1 and 5'),
          `expected the rating range to be what refused this, got: ${outOfRange.json?.error}`
        );

        assert((await reviewsForBooking()).length === 0, 'an experience review was written against a space booking');
      },
    },

    {
      name: 'reads: filters are enforced, and every /reviews/{id} verb 404s on an unknown id',
      run: async () => {
        // A listing with no reviews returns an empty list, not an error — the
        // shape the app renders "no reviews yet" from.
        const byListing = await gw(ctx.guest, `/reviews?target=${ctx.listingId}&type=listing&limit=5`);
        assert(byListing.status === 200, `GET /reviews?target= expected 200, got ${byListing.status}: ${byListing.text}`);
        const rows = Array.isArray(byListing.data) ? byListing.data : byListing.data?.reviews;
        assert(Array.isArray(rows), `GET /reviews must return an array, got: ${byListing.text}`);

        const unknown = 'gateway-suite-no-such-review';
        const verbs = [
          ['GET', `/reviews/${unknown}`, undefined],
          ['PATCH', `/reviews/${unknown}`, { comment: 'Gateway suite: editing a review that does not exist.' }],
          ['DELETE', `/reviews/${unknown}`, undefined],
          ['POST', `/reviews/${unknown}/report`, { reason: 'SPAM', reported_by: ctx.guestId }],
          ['POST', `/reviews/${unknown}/respond`, { comment: 'Gateway suite: responding to a review that does not exist.' }],
        ];
        for (const [method, path, body] of verbs) {
          const res = await gw(ctx.guest, path, { method, body });
          assert(res.status === 404, `${method} ${path} must 404 on an unknown review, got ${res.status}: ${res.text}`);
        }
      },
    },

    {
      name: 'every review write path rejects an anonymous caller',
      run: async () => {
        const paths = [
          ['POST', '/reviews'],
          ['POST', '/reviews/experience'],
          ['GET', '/reviews/gateway-suite-no-such-review'],
          ['PATCH', '/reviews/gateway-suite-no-such-review'],
          ['DELETE', '/reviews/gateway-suite-no-such-review'],
          ['POST', '/reviews/gateway-suite-no-such-review/report'],
          ['POST', '/reviews/gateway-suite-no-such-review/respond'],
        ];
        for (const [method, path] of paths) {
          const res = await fetch(`${config.gwUrl}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
          });
          assert(res.status === 401, `anonymous ${method} ${path} must be 401, got ${res.status}`);
        }
      },
    },

    {
      name: 'cleanup — the draft booking is deleted and verified gone',
      run: async () => {
        if (!ctx.bookingId) return;
        await deleteDraftBooking(ctx.guest, ctx.bookingId);
        let gone = false;
        try {
          const b = await getBooking(ctx.guest, ctx.bookingId);
          gone = b?.status === 'cancelled' || b?.deleted === true;
        } catch (e) {
          gone = /404/.test(e.message); // getBooking throws on a non-200
        }
        assert(gone, `cleanup failed: draft booking ${ctx.bookingId} is still live and holding its listing's dates`);
        console.log(`    · deleted draft booking ${ctx.bookingId}`);
        ctx.bookingId = null;
      },
    },
  ],
};
