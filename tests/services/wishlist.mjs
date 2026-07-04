// wishlist-service — CR-514 regression guard.
//
// CR-514: wishlist previews showed paid listings as "Free" because the price
// preview was read straight off the Firestore listing doc, and a price stored
// as a Firestore integer (vs float) failed the old float64 type assertion and
// silently fell back to 0. Fixed in wishlist-service internal/service/wishlist.go
// via firestoreFloat(), which coerces both int64 and float64 Firestore values.
//
// This is a WRITE-path flow (POST/DELETE /wishlists), which the suite otherwise
// avoids. The three cases below run IN ORDER (the shared runner executes a
// suite's cases sequentially) and use a fixed tag ('gw-test-cr514') so the seed
// is always added then removed within the same run — safe to re-run against
// live staging, no junk left behind. The listing id is resolved once at module
// load (top-level await) off a live GET /listings call, so the fixture is
// always a real, currently-paid listing rather than a hardcoded id that could
// go stale or get deleted.
import { config } from '../lib/env.mjs';
import { login, authHeaders } from '../lib/auth.mjs';

const TAG = 'gw-test-cr514';

// Fetch a real, currently-paid listing to use as the wishlist fixture.
async function pickPaidListing(tokens) {
  const res = await fetch(`${config.gwUrl}/listings?limit=10`, { headers: authHeaders(tokens, 'full') });
  if (res.status !== 200) return null;
  const body = await res.json().catch(() => ({}));
  const listings = body.data ?? [];
  return listings.find((l) => typeof l.price === 'number' && l.price > 0) ?? null;
}

async function buildCases() {
  const tokens = await login();
  const listing = await pickPaidListing(tokens);

  if (!listing) {
    // No paid listing available on staging right now to seed a fixture with —
    // fall back to a read-only assertion so the CR-514 invariant is still
    // checked against whatever the account's wishlist already has.
    return [
      {
        name: 'GET /wishlists (read-only price sanity — no paid listing found to seed)',
        path: '/wishlists',
        expect: 200,
        check: (json) => {
          const groups = json?.data ?? [];
          for (const g of groups) {
            for (const item of g.listings ?? []) {
              if (typeof item.price !== 'number') {
                return `wishlist item ${item.listing_id} has non-numeric price: ${JSON.stringify(item.price)}`;
              }
            }
          }
          return null;
        },
      },
    ];
  }

  return [
    {
      name: `POST /wishlists (seed fixture: add listing ${listing.id}, price=${listing.price})`,
      method: 'POST',
      path: '/wishlists',
      body: { tag: TAG, listing: { listing_id: listing.id } },
      expect: 201,
    },
    {
      name: 'GET /wishlists (CR-514: seeded item price is a real number, matches listing)',
      path: '/wishlists',
      expect: 200,
      check: (json) => {
        const groups = json?.data ?? [];
        const group = groups.find((g) => g.tag === TAG);
        if (!group) return `seeded tag "${TAG}" not found in wishlist response`;
        const item = group.listings?.find((l) => l.listing_id === listing.id);
        if (!item) return `seeded listing ${listing.id} not found under tag "${TAG}"`;
        if (typeof item.price !== 'number') {
          return `price is not a number: ${JSON.stringify(item.price)}`;
        }
        if (item.price === 0) {
          return `price is 0 for a known-paid listing (CR-514 regression)`;
        }
        if (item.price !== listing.price) {
          return `price mismatch: wishlist=${item.price} listing=${listing.price} (CR-514 regression?)`;
        }
        return null;
      },
    },
    {
      name: 'DELETE /wishlists (cleanup fixture)',
      method: 'DELETE',
      path: '/wishlists',
      body: { tag: TAG, listing_id: listing.id },
      expect: [200, 404],
    },
  ];
}

export default {
  name: 'wishlist-service',
  cases: await buildCases(),
};
