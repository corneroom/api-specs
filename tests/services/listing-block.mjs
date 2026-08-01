// listing-service — GET /listings excludes blocked hosts for authenticated
// callers (block-scope filtering, deployed 2026-08-01).
//
// Reuses a REAL host already present in the caller's own browse results
// (same pattern as tests/services/community-feed-block.mjs): pick any
// listing whose host.id != caller, block that host, and assert the next
// authenticated GET /listings has zero items from that host. Unauthenticated
// browse is intentionally NOT filtered (no identity to filter against), so we
// also assert the blocked host's listing is still visible there.
//
// RESOLVED (2026-08-01): the filter is confirmed live — `GET /listings`
// (authenticated) no longer returns a blocked host's listings, verified via
// this suite passing on live staging. (Earlier same-day runs briefly caught
// this unfiltered; that was a genuine pre-deploy gap, not a test bug.)
import { login, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { dataOf } from '../lib/assert.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';

// Find a real listing (id + host id) whose host isn't the caller, to use as
// a block/unblock fixture without seeding a second account.
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
        name: 'GET /listings (authed) — read-only sanity, no other host found for a block-filter test',
        path: '/listings?limit=10',
        expect: 200,
        check: (json) => (Array.isArray(dataOf(json)) ? null : 'expected data to be an array of listings'),
      },
    ];
  }

  const { hostId } = target;

  return [
    {
      name: `POST /users/blocks (seed: block listing host ${hostId})`,
      method: 'POST',
      path: '/users/blocks',
      body: { blocked_user_id: hostId },
      expect: 200,
    },
    {
      name: `GET /listings (authed) excludes blocked host ${hostId}`,
      path: '/listings?limit=50',
      expect: 200,
      check: (json) => {
        const leaked = (dataOf(json) ?? []).filter((l) => l.host?.id === hostId);
        return leaked.length
          ? `listings still contains ${leaked.length} item(s) from blocked host ${hostId}: ${JSON.stringify(
              leaked.map((l) => l.id)
            )}`
          : null;
      },
    },
    {
      name: `GET /listings (unauthenticated) still shows blocked host ${hostId} (browse without identity is not filtered)`,
      path: '/listings?limit=50',
      auth: 'none',
      expect: 200,
      check: (json) => {
        const present = (dataOf(json) ?? []).some((l) => l.host?.id === hostId);
        return present
          ? null
          : `expected unauthenticated browse to still include host ${hostId}'s listing(s) — got none (filtering should not apply without caller identity)`;
      },
    },
    {
      name: `DELETE /users/blocks/${hostId} (cleanup: unblock)`,
      method: 'DELETE',
      path: `/users/blocks/${hostId}`,
      expect: 200,
    },
    {
      name: `GET /listings (authed) shows host ${hostId} again after unblock`,
      path: '/listings?limit=50',
      expect: 200,
      check: (json) => {
        const present = (dataOf(json) ?? []).some((l) => l.host?.id === hostId);
        return present ? null : `expected host ${hostId}'s listing(s) to reappear after unblock, found none`;
      },
    },
  ];
}

export default {
  name: 'listing-service (browse excludes blocked hosts)',
  cases: await buildCases(),
};
