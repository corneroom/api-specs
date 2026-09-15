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
// ── WHAT GATES A REVIEW (and why a real one still isn't reachable) ─────────
//
// A space review has to clear, in this order (review-service
// app/service/review_service.py `create_review`):
//
//   1. WHO — only the guest may review the space; only the guest or the host
//      may review each other. Checked first, so a stranger is refused 403
//      without learning anything about the booking's state.
//   2. STATUS — the booking must be `Confirmed` or `Completed`. A draft,
//      pending, rejected, unpaid or cancelled booking is refused 400 however
//      its dates read.
//   3. DATES — the check-in must have passed (`validate_check_in_date`,
//      app/utils/data_helpers.py, `now >= check_in`) and the 14-day window
//      after check-out must still be open (`_review_window_open`). The 14 days
//      are the same window booking-service stamps on the booking as
//      `review_create_deadline` (internal/service/review_reminder.go:20-23).
//
// The brief for this file asked for a review on a COMPLETED stay if any path
// to one exists. There is none reachable from the app gateway, and the reason
// is worth writing down so nobody re-derives it:
//
//   · Every booking this suite can create is 300-600 days in the FUTURE.
//     That is forced: `futureDates()` spreads bookings far out because the
//     suite runs every 6 hours against a handful of shared staging listings
//     and near dates collide (see tests/README.md), and
//     `POST /bookings/initiate` refuses a past check-in outright
//     (booking-service ErrTypeCheckInPast).
//   · Completing the booking does not help. `PATCH /bookings/{id}/complete`
//     exists and a guest may call it (booking-service
//     internal/rest/controller.go:749-785), but it only moves `status` —
//     `check_in` is untouched (internal/service/booking.go:3942-4010), so gate
//     3 still refuses.
//   · The experience path is gated on status instead
//     (`create_experience_review` requires `status == "completed"`), and no
//     reservation this suite can create is completed either.
//
// So what is drivable — and what this file therefore asserts — is the
// REFUSAL, the authorization, the validation, and, most importantly, that a
// refused review leaves nothing behind. When staging grows a way to produce a
// past-dated stay, the "submit → it appears on the listing → stats move" half
// belongs here.
//
// ── ONE REFUSAL IS NOT REACHABLE FROM HERE ────────────────────────────────
// A `cancelled` booking cannot be produced without first confirming one:
// `PATCH /bookings/{id}/cancel` accepts only Pending/Accepted/Unpaid/Confirmed
// (booking-service internal/service/booking.go:185-187) and DELETE of a draft
// hard-deletes the document (booking.go:2142), which would 404 rather than
// refuse. So the cancelled case below uses a FREE bot fixture — confirmed via
// the SetupIntent path, no charge, then cancelled. It is the only booking here
// that ever leaves `draft`.
//
// ── BUGS FOUND WHILE WRITING THIS, NOT FIXED (no backend changes here) ─────
//
// 1. **A guest can mark a far-future stay "completed" at will.**
//    `PATCH /bookings/{id}/complete` is routed on the app gateway
//    (gateway/app-swagger.yaml `/bookings/{id}/complete`), accepts either the
//    host OR the guest (controller.go:777-780), and checks only that the
//    booking is `confirmed` — no date check (booking.go:3955-3958). It then
//    publishes `booking_completed` carrying the host's payout method and email
//    (booking.go:3990-4004), which is the event the payout pipeline keys off.
//    NOT exercised here — this file will not move money state on a bot host to
//    prove a point — and reported as a code read, not a live finding. It no
//    longer buys a review, though: gate 3 refuses a future check-in whatever
//    the status says.
// 2. **The seeded listings' review counts are not backed by review documents.**
//    The bot host's fixture reports `rating 4.17` / `review_count 21`, while
//    `GET /reviews?target=<that listing>` returns `[]`. The denormalized stats
//    were seeded without the underlying docs. That is seed data, not service
//    behaviour, but it is why nothing here asserts a NON-EMPTY review list.
//
// ── FIXED SINCE THIS FILE WAS WRITTEN ─────────────────────────────────────
// Every business refusal used to answer `201 Created` with `success:false`,
// so these cases could only assert the envelope. Refusals now carry the status
// they mean (403 who, 400 when, 404 unknown, 409 duplicate, 422 body) and the
// cases below assert both the status AND the envelope the app renders from.
//
// ── LEAK DISCIPLINE ────────────────────────────────────────────────────────
// Two bookings on bot-hosted fixtures, both money-free: a DRAFT that is never
// paid (no Stripe object at all), and one FREE listing booked through the
// SetupIntent path purely so it can be cancelled. Both ids are recorded before
// anything throwable; the trailing cleanup deletes the draft and verifies it is
// gone, and the free one is left cancelled — neither occupies its listing's
// dates afterwards.
import { login, loginHost, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';
import {
  pickListing,
  pickFreeListing,
  initiateBooking,
  futureDates,
  deleteDraftBooking,
  getBooking,
  bookAndConfirm,
  cancelBooking,
  teardownBooking,
} from '../lib/booking-flow.mjs';

// The exact metric shapes review-service validates against
// (review-service app/models/review.py:114-134). A wrong shape 422s at the
// FastAPI layer and never reaches the business rules these cases are about.
const SPACE_METRICS = { cleanliness: 5, check_in: 5, accuracy: 5, location: 5, value: 5 };
const GUEST_REVIEWS_HOST_METRICS = { hospitality: 5, communication: 5, cleanliness: 5, respectfulness: 5, would_visit_again: true };
const HOST_REVIEWS_GUEST_METRICS = { communication: 5, cleanliness: 5, respectfulness: 5, would_host_again: true };

const ctx = {
  guest: null,
  host: null,
  guestId: null,
  listingId: null,
  bookingId: null,
  freeBookingId: null,
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Every refusal must carry the status it means AND the envelope the mobile app
// renders from — its ErrorHandler reads `toast` first, then `error`
// (app/mobile/lib/core/network/error_handler.dart), so a bare FastAPI
// {"detail": …} would silently downgrade the user to generic copy.
function assertRefused(res, status, fragment, label) {
  assert(res.status === status, `${label}: expected ${status}, got ${res.status}: ${res.text}`);
  assert(res.json?.success === false, `${label}: a refusal must carry success:false — ${res.text}`);
  assert(
    `${res.json?.error ?? ''}`.toLowerCase().includes(fragment.toLowerCase()),
    `${label}: expected ${JSON.stringify(fragment)} to be the reason, got: ${res.json?.error}`
  );
  assert(res.json?.toast, `${label}: the app renders \`toast\` first — it must be present: ${res.text}`);
  assert(!res.data, `${label}: a refused review must not return a review body: ${res.text}`);
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
async function reviewsForBooking(bookingId = ctx.bookingId) {
  const res = await gw(ctx.guest, `/reviews?booking_id=${bookingId}`);
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
      name: 'a booking that was never paid for cannot be reviewed — and the refusal persists nothing',
      run: async () => {
        assert(ctx.bookingId, 'no fixture booking');

        for (const [label, body] of [
          ['type=listing (the space)', { booking_id: ctx.bookingId, type: 'listing', metrics: SPACE_METRICS, comment: 'Gateway suite: this review must be refused.' }],
          ['type=user (the host)', { booking_id: ctx.bookingId, type: 'user', metrics: GUEST_REVIEWS_HOST_METRICS, comment: 'Gateway suite: this review must be refused.' }],
        ]) {
          const res = await gw(ctx.guest, '/reviews', { method: 'POST', body });
          // A draft is stopped by the STATUS gate, which runs before the dates
          // are ever looked at. Nothing about a stay you did not pay for is
          // reviewable, however its dates read.
          assertRefused(res, 400, 'confirmed or completed', label);
        }

        const stored = await reviewsForBooking();
        assert(stored.length === 0, `a refused review was persisted anyway: ${JSON.stringify(stored)}`);
      },
    },

    {
      name: 'someone who is not a party to the booking is refused 403, and told nothing about it',
      run: async () => {
        assert(ctx.bookingId, 'no fixture booking');
        // The bot HOST account owns a different listing entirely, so it is
        // neither the guest nor the host of this booking. It must get the
        // ownership refusal, NOT the state one the real guest gets above —
        // that ordering is what stops /reviews being a booking-state oracle.
        for (const [label, body, reason] of [
          ['as a listing review', { booking_id: ctx.bookingId, type: 'listing', metrics: SPACE_METRICS }, 'only the guest'],
          ['as a user review', { booking_id: ctx.bookingId, type: 'user', metrics: HOST_REVIEWS_GUEST_METRICS }, 'participants'],
        ]) {
          const res = await gw(ctx.host, '/reviews', { method: 'POST', body });
          assertRefused(res, 403, reason, label);
        }
        const stored = await reviewsForBooking();
        assert(stored.length === 0, `a stranger's review was persisted: ${JSON.stringify(stored)}`);
      },
    },

    {
      name: 'a confirmed stay that has not started yet cannot be reviewed, and neither can it once cancelled',
      run: async () => {
        // The one booking in this file that leaves `draft`. A FREE bot fixture,
        // so this is the SetupIntent path — no charge, no money state — and it
        // is the only way to reach a `cancelled` booking at all (see header).
        const listing = await pickFreeListing(ctx.guest);
        const { bookingId } = await bookAndConfirm(ctx.guest, listing, {
          guestId: ctx.guestId,
          hostId: listing.host.id,
          onDraft: (id) => {
            ctx.freeBookingId = id; // recorded before anything that can throw
          },
        });
        ctx.freeBookingId = bookingId;
        console.log(`    · free confirmed booking ${bookingId} on bot listing ${listing.id}`);

        // Confirmed clears the status gate, so now the DATE gate is what
        // refuses: the stay is 300-600 days out.
        const beforeCheckIn = await gw(ctx.guest, '/reviews', {
          method: 'POST',
          body: { booking_id: bookingId, type: 'listing', metrics: SPACE_METRICS },
        });
        assertRefused(beforeCheckIn, 400, 'before the check-in date', 'confirmed but not started');

        await cancelBooking(ctx.guest, bookingId, 'gateway suite: review refusal fixture');
        const cancelled = await getBooking(ctx.guest, bookingId);
        assert(cancelled.status === 'cancelled', `expected the fixture to be cancelled, got status=${cancelled.status}`);

        const afterCancel = await gw(ctx.guest, '/reviews', {
          method: 'POST',
          body: { booking_id: bookingId, type: 'listing', metrics: SPACE_METRICS },
        });
        assertRefused(afterCancel, 400, 'confirmed or completed', 'cancelled booking');

        const stored = await reviewsForBooking(bookingId);
        assert(stored.length === 0, `a review survived on a cancelled booking: ${JSON.stringify(stored)}`);
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

        // A rating outside 1-5 is a body problem, same as a missing one.
        const outOfRange = await gw(ctx.guest, '/reviews/experience', {
          method: 'POST',
          body: { booking_id: ctx.bookingId, rating: 9 },
        });
        assertRefused(outOfRange, 422, 'between 1 and 5', 'a rating of 9');

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
        // The free fixture should already be cancelled; teardownBooking is a
        // no-op then, and cancels it if this flow failed before it got there.
        if (ctx.freeBookingId) {
          await teardownBooking(ctx.guest, ctx.freeBookingId);
          ctx.freeBookingId = null;
        }
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
