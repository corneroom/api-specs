// wishlist-service — GET /wishlists excludes saved items whose host is
// blocked (block-scope filtering, deployed 2026-08-01; host_id populated on
// wishlist items incl. backfilled legacy items).
//
// This is a write-path flow (POST/DELETE /wishlists, same pattern as
// tests/services/wishlist.mjs's CR-514 guard): seed a fixture item under a
// fixed tag, block its host, assert it disappears from GET /wishlists,
// unblock, assert it reappears, then always remove the fixture item —
// cleanup runs unconditionally so the suite stays idempotent even if an
// assertion above it fails (the shared runner doesn't stop on failure).
//
// KNOWN FAILURE (confirmed 2026-08-01, live staging) — this is a caching
// bug, not a propagation delay: the filter DOES work when `GET /wishlists`
// is called cold (no prior read this session) immediately after blocking.
// But as soon as `GET /wishlists` is read ONCE before the block (which is
// exactly what real usage looks like — a user opens their wishlist, then
// blocks someone from it — and is also what the "contains the seeded item
// before blocking" sanity case below does on purpose), every subsequent
// `GET /wishlists` keeps returning the stale pre-block list — verified
// unchanged after waiting up to 10s. wishlist-service appears to cache the
// list response and never invalidates that cache on a block/unblock event.
// Do not remove the "before blocking" read or add a delay to paper over
// this — the intermediate read is what exposes the real bug.
import { login, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { dataOf } from '../lib/assert.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';

const TAG = 'gw-test-blockfilter-wl';

// Find a real listing (id + host id) whose host isn't the caller, to use as
// the wishlist/block fixture.
async function pickOtherHostListing(tokens, meId) {
  const res = await fetch(`${config.gwUrl}/listings?limit=25`, { headers: authHeaders(tokens, 'full') });
  if (res.status !== 200) return null;
  const body = await res.json().catch(() => ({}));
  const listings = dataOf(body);
  if (!Array.isArray(listings)) return null;
  for (const l of listings) {
    const hostId = l.host?.id;
    if (hostId && hostId !== meId) return { listingId: l.id, hostId };
  }
  return null;
}

// True if the wishlist response has `listingId` present under any group.
function wishlistContains(json, listingId) {
  const groups = dataOf(json) ?? [];
  return groups.some((g) => (g.listings ?? []).some((item) => item.listing_id === listingId));
}

async function buildCases() {
  const tokens = await login();
  const meId = await fetchMeId(tokens);
  const target = meId ? await pickOtherHostListing(tokens, meId) : null;

  if (!target) {
    return [
      {
        name: 'GET /wishlists (read-only sanity — no other-host listing found for a block-filter fixture)',
        path: '/wishlists',
        expect: 200,
      },
    ];
  }

  const { listingId, hostId } = target;

  return [
    {
      name: `POST /wishlists (seed fixture: save listing ${listingId} from host ${hostId})`,
      method: 'POST',
      path: '/wishlists',
      body: { tag: TAG, listing: { listing_id: listingId } },
      expect: 201,
    },
    {
      name: `GET /wishlists contains the seeded item before blocking`,
      path: '/wishlists',
      expect: 200,
      check: (json) => (wishlistContains(json, listingId) ? null : `seeded listing ${listingId} not found under tag "${TAG}"`),
    },
    {
      name: `POST /users/blocks (block wishlist item's host ${hostId})`,
      method: 'POST',
      path: '/users/blocks',
      body: { blocked_user_id: hostId },
      expect: 200,
    },
    {
      name: `GET /wishlists excludes item ${listingId} whose host ${hostId} is blocked`,
      path: '/wishlists',
      expect: 200,
      check: (json) =>
        wishlistContains(json, listingId)
          ? `wishlist still contains listing ${listingId} from blocked host ${hostId}`
          : null,
    },
    {
      name: `DELETE /users/blocks/${hostId} (cleanup: unblock)`,
      method: 'DELETE',
      path: `/users/blocks/${hostId}`,
      expect: 200,
    },
    {
      name: `GET /wishlists shows item ${listingId} again after unblock`,
      path: '/wishlists',
      expect: 200,
      check: (json) =>
        wishlistContains(json, listingId) ? null : `expected listing ${listingId} to reappear after unblock`,
    },
    {
      name: `DELETE /wishlists (cleanup: remove fixture item)`,
      method: 'DELETE',
      path: '/wishlists',
      body: { tag: TAG, listing_id: listingId },
      expect: [200, 404],
    },
  ];
}

export default {
  name: 'wishlist-service (excludes items from blocked hosts)',
  cases: await buildCases(),
};
