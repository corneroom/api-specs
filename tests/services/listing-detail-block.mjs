// listing-service — `GET /listings/{id}` now returns 404 for a listing whose
// host is blocked by the caller (deployed 2026-08-01), so a blocked host's
// listing detail leaks nothing (not even a 403/redacted body) once blocked.
//
// Reuses a real listing/host pair already visible in an authenticated browse
// (same "reuse real data" pattern as listing-block.mjs), instead of seeding
// a fixture. Detail is confirmed 200 before blocking (so the 404 afterward
// is provably caused by the block, not a bad/nonexistent listing id), then
// blocked -> 404, then unblocked -> 200 again.
import { login, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { dataOf } from '../lib/assert.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';

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

async function buildCases() {
  const tokens = await login();
  const meId = await fetchMeId(tokens);
  const target = meId ? await pickOtherHostListing(tokens, meId) : null;

  if (!target) {
    return [
      {
        name: 'GET /listings/{id} — read-only sanity, no other host found for a block-filter test',
        path: '/listings?limit=1',
        expect: 200,
      },
    ];
  }

  const { listingId, hostId } = target;

  return [
    {
      name: `GET /listings/${listingId} (authed, host ${hostId} not yet blocked) -> 200`,
      path: `/listings/${listingId}`,
      expect: 200,
    },
    {
      name: `POST /users/blocks (seed: block listing ${listingId}'s host ${hostId})`,
      method: 'POST',
      path: '/users/blocks',
      body: { blocked_user_id: hostId },
      expect: 200,
    },
    {
      name: `GET /listings/${listingId} (authed, host ${hostId} blocked) -> 404`,
      path: `/listings/${listingId}`,
      expect: 404,
    },
    {
      name: `DELETE /users/blocks/${hostId} (cleanup: unblock)`,
      method: 'DELETE',
      path: `/users/blocks/${hostId}`,
      expect: 200,
    },
    {
      name: `GET /listings/${listingId} (authed, host ${hostId} unblocked) -> 200 again`,
      path: `/listings/${listingId}`,
      expect: 200,
    },
  ];
}

export default {
  name: 'listing-service (detail hides blocked host listings)',
  cases: await buildCases(),
};
