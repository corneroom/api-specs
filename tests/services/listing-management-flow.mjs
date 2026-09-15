// listing-service × booking-service — a HOST's own listing, end to end:
// create it, read it back the three different ways the app does, edit it,
// discover what a host may and may not do to it before moderation approves it,
// and delete it.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// `/listings` was the single biggest hole in this suite: every existing case
// READS the seeded marketplace (services/listing*.mjs, and the fixture pool in
// lib/booking-flow.mjs), so nothing covered the write half a host actually
// uses — create, edit, the pause toggle, delete — nor the authorization on it.
// That is also where the two most expensive listing regressions of the year
// lived: a resume writing "active"/"paused" into the moderation `status` field
// (which dropped the listing out of every discovery query), and a listing that
// was invisible in the feed still being bookable through a share link.
//
// This runs as the seeded bot HOST (TEST_HOST_EMAIL, lib/auth.mjs
// `loginHost()`) — the same second identity services/booking-host-flow.mjs
// introduced — because only a host can create a listing, and a real host would
// be emailed/pushed about every moderation transition this flow triggers.
//
// ── THE THREE-FLAG STATUS MODEL, WHICH THIS FILE PINS ──────────────────────
//
// A listing carries three independent flags and conflating them is the bug
// class above:
//   status   — MODERATION. `pending` on create (listing-service
//              internal/rest/controller.go:367), moved to `approved` by an
//              admin. Never written by a host's pause/resume.
//   active   — the HOST's own visibility toggle (PUT /listings/{id} with
//              `active`, or the legacy `status:"active"|"paused"` the mobile
//              app also sends; the service collapses BOTH onto the `active`
//              bool — internal/service/listing.go:1366-1405).
//   verified — DISCOVERY. False on create (controller.go:368). Both the feed
//              and booking read it, which is what makes the invariant
//              "hidden from discovery ⇒ not bookable" hold.
//
// ── WHAT IS DESCOPED, AND WHY (this is the important bit) ──────────────────
//
// **Pause → not bookable → resume → bookable again is NOT drivable here, and
// asserting it would have been a lie.** A host may not touch the visibility
// toggle at all until moderation approves the listing:
// `CanListingBeActivated` accepts only `approved`/`active`
// (listing-service internal/service/listing.go:667-674) and the update path
// returns "cannot change listing active state: not yet approved" → HTTP 409
// for anything else (listing.go:1380 and :1394, surfaced at
// internal/rest/controller.go:1155). A listing this suite creates is `pending`
// and stays `pending` — approval is an admin action on the dashboard, not an
// app-gateway endpoint. The only approved listing this account owns is the
// shared fixture `booking-host-flow.mjs` books against, and pausing THAT to
// satisfy a test would break every other flow's fixture and edit seeded data
// to suit a test. So what is asserted instead is the gate itself (409, twice,
// via both spellings) plus the *reason* a pending listing is unbookable, read
// from the guest side — see the next paragraph. If a staging listing ever
// becomes approvable over the gateway, the pause/resume/rebook half belongs
// here.
//
// The unbookable assertion is deliberately made on the MESSAGE, not just the
// 400. booking-service refuses this listing at the trust gate
// (`listingBookableByGuest`, internal/service/booking.go:39-47 → `ErrHostNotVerified`,
// internal/service/errors.go:88) with "this listing isn't available right now".
// The very next gate — a bot host with a non-allow-listed guest — also returns
// 400, but with "this host isn't accepting bookings right now"
// (errors.go:96). Both are "not bookable"; only the first one is the claim
// this case is making, so it checks which.
//
// ── LEAK DISCIPLINE ────────────────────────────────────────────────────────
// One listing is created, and its id is recorded the instant it exists,
// before anything that can throw. The trailing cleanup deletes it whatever
// state the flow reached and then VERIFIES it is gone (404 on the host's own
// read), because a leaked listing here is worse than a leaked booking: it
// would sit in the host's "my listings" forever and, once an admin approved
// it, join the real marketplace. That cleanup also re-reads the shared fixture
// and asserts this flow left it byte-for-byte untouched — this file reads it
// (for a geocodable address) and must never write to it.
import { login, loginHost, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';
import { futureDates } from '../lib/booking-flow.mjs';

const ctx = { listingId: null, hostTokens: null, fixtureBefore: null };

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

// `GET /listings/user` ("my listings") returns the RAW Firestore entity, so its
// keys are Go-PascalCase (ID/Title/Status/Deleted), NOT the lower_snake_case
// the spec documents for it. That divergence is long-standing and the mobile
// app decodes the PascalCase shape deliberately
// (app/mobile lib/features/listing/data/models/listing_preview_dto.dart:44),
// so these tests assert what the endpoint really returns. Do not "fix" this
// to match the spec without changing the service and the app together.
const myListingIds = (rows) => (rows ?? []).map((r) => r.ID);

// Build a valid create payload. Nothing is hardcoded: the category comes from
// `GET /listings/categories`, and the city/coordinates/timezone are copied from
// a listing this host already owns, so the address is genuinely geocodable and
// the currency matches the country (listing-service validates
// `currency == GetCurrencyForCountry(address.country)`, controller.go:346-351)
// without this file knowing anything about where staging's seed data lives.
// `location` is supplied in full so CreateListing takes the client-coordinate
// branch (controller.go:314) instead of calling out to the geocoder.
async function buildListingPayload(tokens) {
  const mine = await gw(tokens, '/listings/user');
  assert(mine.status === 200, `GET /listings/user failed ${mine.status}: ${mine.text}`);
  const source = (mine.data ?? [])[0];
  assert(source, 'TEST_HOST_EMAIL owns no listing to copy a geocodable address from — point it at a seeded host that does');
  ctx.fixtureBefore = source;

  const cats = await gw(tokens, '/listings/categories');
  assert(cats.status === 200, `GET /listings/categories failed ${cats.status}: ${cats.text}`);
  const codes = (cats.data ?? []).map((c) => c.code).filter(Boolean);
  assert(codes.length > 0, 'GET /listings/categories returned no usable category codes');

  const addr = source.Location.Address;
  return {
    payload: {
      title: 'Gateway suite temporary space (auto-deleted)',
      description: 'Created by the gateway integration suite to cover the host listing lifecycle. Deleted at the end of the run.',
      address: {
        street: addr.Street,
        city: addr.City,
        country: addr.Country,
        postal_code: addr.PostalCode,
        province: addr.Province,
        flag: addr.Flag,
      },
      location: {
        latitude: source.Location.Latitude,
        longitude: source.Location.Longitude,
        city: addr.City,
        country: addr.Country,
        flag: addr.Flag,
        timezone: source.Location.timezone,
      },
      // Well under the global affordability ceiling (listing_price_cap_usd,
      // enforced at controller.go:357-364) so this never fails on a Remote
      // Config change it isn't testing.
      price: 12,
      currency: source.Currency,
      thumbnail: source.Thumbnail,
      // `photos` is validated `min=3,dive,http_url` (internal/rest/listing.go:45).
      photos: source.Photos.slice(0, 3),
      // 1 guest is under every category's Remote Config capacity ceiling
      // (maxGuestsForCategory, controller.go:275).
      max_guests: 1,
      instant_book: false,
      cancellation_policy: 'fifty_percent_24h',
      category_code: codes[0],
      min_stay_days: 1,
      max_stay_days: 30,
      pricing_type: 'nightly',
    },
    categoryCode: codes[0],
  };
}

export default {
  name: 'listing-service (host listing lifecycle: create → read → edit → moderation gate → delete)',
  cases: [
    {
      name: 'POST /listings (host) creates a listing at status=pending, active=false, verified=false',
      run: async () => {
        ctx.hostTokens = await loginHost();
        const hostId = await fetchMeId(ctx.hostTokens);
        assert(hostId, 'could not resolve the bot host id from GET /users/me');
        const { payload, categoryCode } = await buildListingPayload(ctx.hostTokens);

        const res = await gw(ctx.hostTokens, '/listings', { method: 'POST', body: payload });
        // Record the id before ANY assertion, so cleanup can still delete it.
        ctx.listingId = res.data?.id ?? null;
        assert(res.status === 201, `POST /listings expected 201, got ${res.status}: ${res.text}`);
        assert(ctx.listingId, `POST /listings returned no listing id: ${res.text}`);

        const l = res.data;
        assert(l.status === 'pending', `a new listing must start in moderation: expected status=pending, got ${l.status}`);
        assert(l.verified === false, `a new listing must not be discovery-verified: verified=${l.verified}`);
        assert(l.active === false, `a new listing must not be live: active=${l.active}`);
        assert(l.host?.id === hostId, `listing host must be the authenticated caller, got ${l.host?.id} vs ${hostId}`);
        assert(l.category?.code === categoryCode, `category_code round-trip failed: sent ${categoryCode}, got ${l.category?.code}`);
        assert(l.price === payload.price, `price round-trip failed: sent ${payload.price}, got ${l.price}`);
        assert(l.currency === payload.currency, `currency round-trip failed: sent ${payload.currency}, got ${l.currency}`);
        console.log(`    · created listing ${ctx.listingId} (${l.status}, active=${l.active}, verified=${l.verified})`);
      },
    },

    {
      name: 'GET /listings/user + /listings/user/{id} + /listings/{id}/edit — the host reads back what they just created',
      run: async () => {
        assert(ctx.listingId, 'no listing was created');

        const mine = await gw(ctx.hostTokens, '/listings/user');
        assert(mine.status === 200, `GET /listings/user expected 200, got ${mine.status}`);
        assert(
          myListingIds(mine.data).includes(ctx.listingId),
          `the new listing is missing from "my listings": ${JSON.stringify(myListingIds(mine.data))}`
        );

        const own = await gw(ctx.hostTokens, `/listings/user/${ctx.listingId}`);
        assert(own.status === 200, `GET /listings/user/{id} expected 200 for the owner's own pending listing, got ${own.status}: ${own.text}`);
        assert(own.data?.id === ctx.listingId, 'GET /listings/user/{id} returned a different listing');

        // The host-only edit view exists specifically to expose operational
        // fields the guest detail response must never carry (CR-558): wifi
        // password, check-in/out instructions, emergency contact.
        const edit = await gw(ctx.hostTokens, `/listings/${ctx.listingId}/edit`);
        assert(edit.status === 200, `GET /listings/{id}/edit expected 200, got ${edit.status}: ${edit.text}`);
        for (const f of ['category_code', 'check_in_instructions', 'check_out_instructions', 'emergency_contact', 'photos', 'min_stay_days', 'max_stay_days']) {
          assert(f in (edit.data ?? {}), `the host edit view must prefill "${f}" — missing from GET /listings/{id}/edit`);
        }
        assert(edit.data.photos?.length === 3, `photos did not round-trip: ${JSON.stringify(edit.data.photos)}`);
      },
    },

    {
      name: 'GET /listings/{id} (guest) — a listing still in moderation is NOT reachable by a guest',
      run: async () => {
        assert(ctx.listingId, 'no listing was created');
        const guestTokens = await login();
        const res = await gw(guestTokens, `/listings/${ctx.listingId}`);
        assert(
          res.status === 404,
          `an unapproved listing must not be readable by a guest (share-link leak): expected 404, got ${res.status}: ${res.text}`
        );
      },
    },

    {
      name: 'PUT /listings/{id} — a pending listing\'s edits apply IMMEDIATELY (no pending_revision queued)',
      run: async () => {
        assert(ctx.listingId, 'no listing was created');
        const newTitle = 'Gateway suite temporary space, edited (auto-deleted)';
        const res = await gw(ctx.hostTokens, `/listings/${ctx.listingId}`, {
          method: 'PUT',
          body: { title: newTitle, price: 14, max_guests: 2 },
        });
        assert(res.status === 200, `PUT /listings/{id} expected 200, got ${res.status}: ${res.text}`);
        assert(res.data?.title === newTitle, `title edit was not applied: got ${res.data?.title}`);
        assert(res.data?.price === 14, `price edit was not applied: got ${res.data?.price}`);

        // Admin revision review is only for a LIVE, booked listing
        // (requiresRevisionReview, listing-service internal/service/listing.go:1803).
        // A pending listing must never queue one — if it did, the host's own
        // edit form would silently stop reflecting their edits.
        assert(
          !res.data?.pending_revision,
          `a pending listing's edit must apply directly, not queue an admin revision: ${JSON.stringify(res.data.pending_revision)}`
        );

        const edit = await gw(ctx.hostTokens, `/listings/${ctx.listingId}/edit`);
        assert(edit.data?.title === newTitle, `the edit did not persist: /edit still says ${edit.data?.title}`);
        assert(edit.data?.max_guests === 2, `max_guests did not persist: ${edit.data?.max_guests}`);
      },
    },

    {
      name: 'PUT /listings/{id} — the pause/resume toggle is refused (409) until moderation approves, and never moves `status`',
      run: async () => {
        assert(ctx.listingId, 'no listing was created');

        // Both spellings the mobile app sends for the same toggle.
        for (const [label, body] of [
          ['active:true (resume)', { active: true }],
          ['active:false (pause)', { active: false }],
          ['status:"active" (legacy resume)', { status: 'active' }],
          ['status:"paused" (legacy pause)', { status: 'paused' }],
        ]) {
          const res = await gw(ctx.hostTokens, `/listings/${ctx.listingId}`, { method: 'PUT', body });
          assert(
            res.status === 409,
            `${label} on an unapproved listing must be refused with 409 (CanListingBeActivated, listing.go:667), got ${res.status}: ${res.text}`
          );
        }

        // The decisive part: none of those four attempts may have moved the
        // MODERATION status or flipped the visibility flag. This is the exact
        // regression that made an approved listing vanish from discovery.
        const own = await gw(ctx.hostTokens, `/listings/user/${ctx.listingId}`);
        assert(own.status === 200, `GET /listings/user/{id} expected 200, got ${own.status}`);
        assert(own.data?.status === 'pending', `moderation status must be untouched by a pause/resume attempt, got "${own.data?.status}"`);
        assert(own.data?.active === false, `the visibility flag must be untouched by a refused toggle, got active=${own.data?.active}`);
      },
    },

    {
      name: 'POST /bookings/initiate (guest) — an unverified listing is unbookable, and for the RIGHT reason',
      run: async () => {
        assert(ctx.listingId, 'no listing was created');
        const guestTokens = await login();
        const dates = futureDates();
        const res = await gw(guestTokens, '/bookings/initiate', {
          method: 'POST',
          body: { listing_id: ctx.listingId, check_in: dates.checkIn, check_out: dates.checkOut, guests: 1 },
        });
        assert(res.status === 400, `booking an unverified listing must be refused with 400, got ${res.status}: ${res.text}`);
        const err = `${res.json?.error ?? ''}`;
        // See this file's header: the bot-host gate is the very next check and
        // also 400s, with a different message. Pin which gate fired.
        assert(
          err.includes("this listing isn't available right now"),
          `expected the discovery trust gate (ErrHostNotVerified, booking-service errors.go:88) to refuse this, got: ${err}`
        );
        assert(!res.data?.id, `a refused initiate must not have created a booking: ${res.text}`);
      },
    },

    {
      name: 'PUT + DELETE /listings/{id} — a non-owner can neither edit nor delete (403 IDOR guard)',
      run: async () => {
        assert(ctx.listingId, 'no listing was created');
        const guestTokens = await login();

        const upd = await gw(guestTokens, `/listings/${ctx.listingId}`, { method: 'PUT', body: { title: 'edited by somebody who does not own this' } });
        assert(upd.status === 403, `a non-owner PUT must be 403, got ${upd.status}: ${upd.text}`);

        const del = await gw(guestTokens, `/listings/${ctx.listingId}`, { method: 'DELETE' });
        assert(del.status === 403, `a non-owner DELETE must be 403, got ${del.status}: ${del.text}`);

        // Prove the refusals were refusals: the listing is still there, intact.
        const own = await gw(ctx.hostTokens, `/listings/user/${ctx.listingId}`);
        assert(own.status === 200, `the listing must survive a refused non-owner delete, got ${own.status}`);
        assert(own.data?.title?.includes('Gateway suite temporary space'), `a non-owner PUT changed the title: ${own.data?.title}`);
      },
    },

    {
      name: 'DELETE /listings/{id} (owner) — the listing is gone from every read, and a repeat delete 404s',
      run: async () => {
        assert(ctx.listingId, 'no listing was created');
        const del = await gw(ctx.hostTokens, `/listings/${ctx.listingId}`, { method: 'DELETE' });
        assert(del.status === 200, `owner DELETE expected 200, got ${del.status}: ${del.text}`);

        const own = await gw(ctx.hostTokens, `/listings/user/${ctx.listingId}`);
        assert(own.status === 404, `a deleted listing must 404 for its own host, got ${own.status}: ${own.text}`);

        const edit = await gw(ctx.hostTokens, `/listings/${ctx.listingId}/edit`);
        assert(edit.status === 404, `a deleted listing must 404 on the edit view, got ${edit.status}`);

        const mine = await gw(ctx.hostTokens, '/listings/user');
        assert(
          !myListingIds(mine.data).includes(ctx.listingId),
          `a deleted listing must drop out of "my listings": ${JSON.stringify(myListingIds(mine.data))}`
        );

        const again = await gw(ctx.hostTokens, `/listings/${ctx.listingId}`, { method: 'DELETE' });
        assert(again.status === 404, `a repeat DELETE must 404, not re-delete, got ${again.status}: ${again.text}`);

        ctx.listingId = null; // deleted cleanly — nothing left for cleanup
      },
    },

    {
      name: 'cleanup — no listing left behind, and the shared host fixture was never written to',
      run: async () => {
        if (ctx.listingId && ctx.hostTokens) {
          await gw(ctx.hostTokens, `/listings/${ctx.listingId}`, { method: 'DELETE' });
          const check = await gw(ctx.hostTokens, `/listings/user/${ctx.listingId}`);
          assert(check.status === 404, `cleanup failed: listing ${ctx.listingId} still exists (${check.status})`);
          console.log(`    · cleanup deleted leftover listing ${ctx.listingId}`);
          ctx.listingId = null;
        }

        // The fixture other flows book against is READ by this file (for a
        // geocodable address) and must never be written to.
        assert(ctx.fixtureBefore, 'the host fixture was never read — cannot verify it is untouched');
        const mine = await gw(ctx.hostTokens, '/listings/user');
        const after = (mine.data ?? []).find((l) => l.ID === ctx.fixtureBefore.ID);
        assert(after, `the shared host fixture ${ctx.fixtureBefore.ID} disappeared during this run`);
        for (const f of ['Title', 'Price', 'Status', 'Active', 'InstantBook', 'MaxGuests']) {
          assert(
            JSON.stringify(after[f]) === JSON.stringify(ctx.fixtureBefore[f]),
            `this flow modified the shared host fixture's ${f}: ${JSON.stringify(ctx.fixtureBefore[f])} → ${JSON.stringify(after[f])}`
          );
        }
      },
    },
  ],
};
