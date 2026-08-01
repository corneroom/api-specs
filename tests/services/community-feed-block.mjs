// community-service — feed excludes blocked authors (UGC BLOCK feature).
//
// DEPLOY GATE: see tests/services/user-blocks.mjs for the block/unblock
// route status. The block step here (POST /users/blocks) is expected to 404
// until user-service ships the handler, and even once it does, the "feed
// excludes blocked author" assertion also needs the community-service
// in-memory filter deployed. GET /community/feed itself is an existing,
// already-deployed endpoint — only the filtering behavior is new.
//
// Rather than seeding a second account, this reuses a REAL author already
// present in the caller's own feed: pick any item whose user_id != caller,
// block them, and assert the next feed page has zero items from that author.
// See tests/lib/feed-helpers.mjs.
import { login } from '../lib/auth.mjs';
import { pickOtherFeedAuthor, fetchMeId } from '../lib/feed-helpers.mjs';

async function buildCases() {
  const tokens = await login();
  const meId = await fetchMeId(tokens);
  const target = meId ? await pickOtherFeedAuthor(tokens, meId) : null;

  if (!target) {
    return [
      {
        name: 'GET /community/feed (authed) — read-only sanity, no other author found for a block-filter test',
        path: '/community/feed?limit=10',
        expect: 200,
        check: (json) => (Array.isArray(json?.feed) ? null : 'expected a feed array'),
      },
    ];
  }

  return [
    {
      name: `POST /users/blocks (seed: block feed author ${target})`,
      method: 'POST',
      path: '/users/blocks',
      body: { blocked_user_id: target },
      expect: 200,
    },
    {
      name: `GET /community/feed excludes blocked author ${target}`,
      path: '/community/feed?limit=25',
      expect: 200,
      check: (json) => {
        const items = json?.feed ?? [];
        const leaked = items.filter((it) => (it.data ?? it).user_id === target);
        return leaked.length
          ? `feed still contains ${leaked.length} item(s) from blocked author ${target}`
          : null;
      },
    },
    {
      name: `DELETE /users/blocks/${target} (cleanup: unblock)`,
      method: 'DELETE',
      path: `/users/blocks/${target}`,
      expect: 200,
    },
  ];
}

export default {
  name: 'community-service (feed excludes blocked authors)',
  cases: await buildCases(),
};
