// user-service — UGC BLOCK feature (App Store Guideline 1.2).
//
// DEPLOY GATE (2026-07-31): block/unblock handlers are implemented in
// user-service but the Cloud Run revision behind the app gateway does not
// have them yet. `make gateway` was just run and the deployed spec (gateway/
// app-swagger.yaml, api-config corneroom-api-app-staging-fe2f7a2-20260731114105,
// created 2026-07-31T15:42Z) DOES define POST/GET /users/blocks and DELETE
// /users/blocks/{blockedUserId} with `security: [{jwtAuth: []}]`.
//
// Empirically, though, an UNAUTHENTICATED request right now returns 404
// "page not found" (the backend's own default-route text, forwarded verbatim
// by ESPv2) instead of the expected 401 — compare GET /users/me unauth, which
// correctly 401s with "Invalid token". That means ESPv2 is NOT yet enforcing
// jwtAuth on the new /users/blocks operations (the request reaches the
// backend without an auth check, and the backend 404s because the handler
// isn't deployed). This is a DIFFERENT failure mode than "authed 404, missing
// handler" — it's a routing/policy gap, not just a missing handler. Flagged
// here, not root-caused; re-check gateway propagation / the compiled service
// config before assuming it's purely a backend deploy problem.
//
// All `expect` values below are the FINAL intended behavior. Do not weaken
// them to accept today's 404s — let them fail loudly until user-service ships
// the block handlers and the gateway is confirmed enforcing jwtAuth on them.
import { login } from '../lib/auth.mjs';
import { dataOf } from '../lib/assert.mjs';
import { pickOtherFeedAuthor, fetchMeId } from '../lib/feed-helpers.mjs';

const FAKE_TARGET = 'usr_gwtest_doesnotexist';

async function buildCases() {
  const tokens = await login();
  const meId = await fetchMeId(tokens);
  const target = meId ? await pickOtherFeedAuthor(tokens, meId) : null;

  const cases = [
    // --- routing guard: /users/blocks must require auth like every other
    // protected route. Currently FAILS (gets 404, not 401) — see deploy-gate
    // note above.
    {
      name: 'POST /users/blocks unauth -> 401 (routing guard)',
      method: 'POST',
      path: '/users/blocks',
      body: { blocked_user_id: FAKE_TARGET },
      auth: 'none',
      expect: 401,
    },
    { name: 'GET /users/blocks unauth -> 401 (routing guard)', path: '/users/blocks', auth: 'none', expect: 401 },
    {
      name: 'DELETE /users/blocks/{id} unauth -> 401 (routing guard)',
      method: 'DELETE',
      path: `/users/blocks/${FAKE_TARGET}`,
      auth: 'none',
      expect: 401,
    },

    // --- validation (authed) ---
    {
      name: 'POST /users/blocks self-block rejected',
      method: 'POST',
      path: '/users/blocks',
      body: { blocked_user_id: meId ?? 'could-not-resolve-self-id' },
      expect: 400,
    },
    {
      name: 'POST /users/blocks unknown target rejected',
      method: 'POST',
      path: '/users/blocks',
      body: { blocked_user_id: FAKE_TARGET },
      expect: 404,
    },
  ];

  if (!target) {
    // No other author currently visible in the caller's feed to use as a
    // real block/unblock fixture — fall back to a read-only shape check.
    cases.push({
      name: 'GET /users/blocks (read-only — no other feed author found for a block fixture)',
      path: '/users/blocks',
      expect: 200,
      check: (json) =>
        Array.isArray(dataOf(json).blocked_user_ids) ? null : 'expected data.blocked_user_ids array',
    });
    return cases;
  }

  // --- write-path flow (seed -> assert -> cleanup), same real-request
  // pattern as tests/services/wishlist.mjs. `target` is a real user id
  // (a feed author != caller), so this exercises the real Firestore path.
  cases.push(
    {
      name: `POST /users/blocks (seed: block ${target})`,
      method: 'POST',
      path: '/users/blocks',
      body: { blocked_user_id: target },
      expect: 200,
    },
    {
      name: 'POST /users/blocks (idempotent re-block)',
      method: 'POST',
      path: '/users/blocks',
      body: { blocked_user_id: target },
      expect: 200,
    },
    {
      name: 'GET /users/blocks reflects the block',
      path: '/users/blocks',
      expect: 200,
      check: (json) => {
        const ids = dataOf(json).blocked_user_ids ?? [];
        return ids.includes(target) ? null : `expected ${target} in blocked_user_ids, got ${JSON.stringify(ids)}`;
      },
    },
    {
      name: `DELETE /users/blocks/${target} (cleanup: unblock)`,
      method: 'DELETE',
      path: `/users/blocks/${target}`,
      expect: 200,
    },
    {
      name: 'GET /users/blocks no longer contains the unblocked id',
      path: '/users/blocks',
      expect: 200,
      check: (json) => {
        const ids = dataOf(json).blocked_user_ids ?? [];
        return ids.includes(target) ? `${target} still present after unblock` : null;
      },
    }
  );
  return cases;
}

export default {
  name: 'user-service (UGC blocks)',
  cases: await buildCases(),
};
