// community-service × user-service × listing-service — a real feed post's
// whole life: published, seen by someone else, liked, viewed, reported,
// filtered out by a block, and deleted.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// The community feed is the one surface where a user publishes content to
// strangers, and it had 2 of 45 paths covered. `community-feed-block.mjs`
// already guards the block filter, but it has to borrow whatever author the
// caller's feed happens to contain that day — if the feed is quiet, it
// degrades to a read-only sanity check and guards nothing. This file owns its
// fixture: it publishes a post as the suite's own account, so every assertion
// (it appears, it is liked, it is filtered by a block, it disappears when
// deleted) is about a known item and is deterministic on every run.
//
// ── IDENTITIES ─────────────────────────────────────────────────────────────
//   author — TEST_EMAIL (`login()`), publishes the post
//   reader — TEST_HOST_EMAIL (`loginHost()`), the second bot account, used as
//            "somebody else": likes, views and blocks
// Both are bots. Nothing here touches another user's content.
//
// ── WHAT IS DESCOPED, AND WHY ──────────────────────────────────────────────
//
// 1. **Comments.** `POST /community/stories/{id}/comments` and
//    `GET .../comments` are routed and reachable but return
//    **501 "AddStoryComment not implemented" / "GetStoryComments not
//    implemented"** on staging. They are generated router stubs
//    (community-service internal/rest/api/server.gen.go:2000-2003), so there
//    is nothing to assert that would not just be pinning a stub in place.
//    Same for `GET /community/stories/my` ("GetUserStories not implemented")
//    and `GET /community/reels/my` ("GetUserReels not implemented"). Reported
//    below, deliberately uncovered.
// 2. **Reporting the POST itself.** `POST /reports` has no `story`/`reel`/
//    feed-item type — its enum is listing | user | review | profile | message
//    (listing-service docs/api.yaml `/reports`). So the app's feed viewer
//    reports the AUTHOR instead (`reportType: ReportType.user`,
//    app/mobile lib/features/community-feed/presentation/pages/
//    community_feed_viewer_page.dart:570), and this file mirrors exactly that
//    call rather than inventing a type the API does not accept.
// 3. **Hangouts** are covered for auth guards only, on purpose: hangouts are
//    deliberately held back from launch (instant-messaging is never tagged to
//    prod), so driving them would be testing a surface that is not shipping.
//
// ── BUGS / GAPS FOUND WHILE WRITING THIS, NOT FIXED ────────────────────────
//
// * The four 501 stubs above are reachable through the app gateway. A client
//   calling them gets a 501 rendered as "An internal server error occurred".
// * `POST /reports` persists a moderation record that cannot be withdrawn
//   over the gateway (the dashboard is the only way to close one), so the
//   report this file files says so in its `details` — see the case.
//
// ── LEAK DISCIPLINE ────────────────────────────────────────────────────────
// One story (deleted, and its absence from the feed verified), one moderation
// report (staging-only, self-labelled), and one block that MUST come off
// again — a leaked block would silently break `user-blocks.mjs` and
// `community-feed-block.mjs` on the next run, so the cleanup case removes it
// unconditionally and verifies the author is visible again.
import { login, loginHost, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';

// A travel image from the same verified pool the staging seeder uses
// (test-data/scripts/lib/feed-media.js — every id in it is HEAD-checked 200),
// so this post looks like every other item in the feed rather than a
// placeholder.
const SEED_IMAGE = 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=1200&q=80';

const ctx = { author: null, reader: null, authorId: null, storyId: null, blocked: false, reportId: null };

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

// Feed items are wrapped per item: { data: {...}, success, toast }. The feed
// array itself is at the TOP level (`feed`), not inside `data`.
const feedItems = (json) => (json?.feed ?? []).map((it) => it.data ?? it);

async function fetchFeed(tokens, limit = 50) {
  const res = await gw(tokens, `/community/feed?limit=${limit}`);
  assert(res.status === 200, `GET /community/feed expected 200, got ${res.status}: ${res.text}`);
  return feedItems(res.json);
}

export default {
  name: 'community-service (a feed post: publish → seen → liked → reported → blocked out → deleted)',
  cases: [
    {
      name: 'POST /community/stories — the post is published public, owned by the caller',
      run: async () => {
        ctx.author = await login();
        ctx.reader = await loginHost();
        ctx.authorId = await fetchMeId(ctx.author);
        assert(ctx.authorId, 'could not resolve the author id from GET /users/me');

        const res = await gw(ctx.author, '/community/stories', {
          method: 'POST',
          body: {
            author: 'Gateway suite',
            author_avatar: '',
            content: 'Gateway integration suite: automated feed post. Deleted at the end of the run.',
            country_code: 'GR',
            image_url: SEED_IMAGE,
            location: 'Oia, Santorini',
            title: 'Gateway suite test post',
          },
        });
        // The create response double-wraps: data.data is the story.
        const story = res.data?.data ?? res.data;
        ctx.storyId = story?.id ?? null; // recorded before any assertion
        assert(res.status === 201, `POST /community/stories expected 201, got ${res.status}: ${res.text}`);
        assert(ctx.storyId, `the created story has no id: ${res.text}`);

        assert(story.user_id === ctx.authorId, `the post must be owned by the caller, got ${story.user_id}`);
        assert(story.public === true, `a story must be published public to reach the feed, got public=${story.public}`);
        assert(story.image_url === SEED_IMAGE, `image_url did not round-trip: ${story.image_url}`);
        assert(story.likes === 0 && story.views === 0, `a new post must start with no likes or views: ${JSON.stringify({ likes: story.likes, views: story.views })}`);
        assert(story.expires_at, 'a story must carry an expiry — the feed relies on it to age items out');
        console.log(`    · story ${ctx.storyId} (expires ${story.expires_at})`);
      },
    },

    {
      name: 'the post is in the author\'s feed, on their public profile feed, and visible to another user',
      run: async () => {
        assert(ctx.storyId, 'no story was created');

        const own = await fetchFeed(ctx.author);
        assert(own.some((i) => i.id === ctx.storyId), "the author cannot see their own new post in /community/feed");

        const reader = await fetchFeed(ctx.reader);
        assert(reader.some((i) => i.id === ctx.storyId), 'another user cannot see the new post in their feed');

        // The profile feed is public by design — a signed-out visitor
        // following a shared profile link must see published posts.
        const res = await fetch(`${config.gwUrl}/community/public/users/${ctx.authorId}/feed?limit=25`);
        assert(res.status === 200, `anonymous GET /community/public/users/{id}/feed expected 200, got ${res.status}`);
        const anon = feedItems(await res.json());
        assert(anon.some((i) => i.id === ctx.storyId), 'the post is missing from the public profile feed');
      },
    },

    {
      name: 'PUT/DELETE /community/stories/{id}/like + /view — likes are idempotent and reversible, views count up',
      run: async () => {
        assert(ctx.storyId, 'no story was created');

        const like = await gw(ctx.reader, `/community/stories/${ctx.storyId}/like`, { method: 'PUT' });
        assert(like.status === 200, `PUT like expected 200, got ${like.status}: ${like.text}`);
        assert(like.data?.liked === true && like.data?.likes === 1, `a first like must register once: ${like.text}`);

        // Double-tap must not inflate the count.
        const again = await gw(ctx.reader, `/community/stories/${ctx.storyId}/like`, { method: 'PUT' });
        assert(again.status === 200, `a repeat like expected 200, got ${again.status}: ${again.text}`);
        assert(again.data?.likes === 1, `liking twice inflated the count to ${again.data?.likes}`);

        const unlike = await gw(ctx.reader, `/community/stories/${ctx.storyId}/like`, { method: 'DELETE' });
        assert(unlike.status === 200, `DELETE like expected 200, got ${unlike.status}: ${unlike.text}`);
        assert(unlike.data?.liked === false && unlike.data?.likes === 0, `unliking must take the count back to zero: ${unlike.text}`);

        const view = await gw(ctx.reader, `/community/stories/${ctx.storyId}/view`, { method: 'PUT' });
        assert(view.status === 200, `PUT view expected 200, got ${view.status}: ${view.text}`);
        assert(view.data?.views >= 1, `a view must be counted, got ${view.data?.views}`);
      },
    },

    {
      name: 'POST /reports — the feed viewer\'s report reaches moderation',
      run: async () => {
        assert(ctx.authorId, 'no author id');
        // Mirrors app/mobile's feed viewer exactly: it reports the AUTHOR
        // (type "user"), because /reports has no feed-item type. Reason codes
        // come from the app's ReportReason enum.
        const res = await gw(ctx.reader, '/reports', {
          method: 'POST',
          body: {
            type: 'user',
            target_id: ctx.authorId,
            reason: 'spam_or_misleading',
            details: 'Gateway integration suite — automated staging test report, safe to dismiss.',
          },
        });
        assert(res.status === 201, `POST /reports expected 201, got ${res.status}: ${res.text}`);
        ctx.reportId = res.json?.report_id ?? null;
        assert(ctx.reportId, `a report must come back with an id for the dashboard to key on: ${res.text}`);
        assert(res.json?.status === 'open', `a new report must land open for moderation, got ${res.json?.status}`);

        // A report is a moderation record, not a body-echo — it must not be
        // possible to file one for somebody else as the reporter (the
        // reporter is taken from the token, so there is nothing to spoof).
        const bad = await gw(ctx.reader, '/reports', { method: 'POST', body: { type: 'user', target_id: ctx.authorId } });
        assert(bad.status === 400, `a report with no reason must be refused with 400, got ${bad.status}: ${bad.text}`);
      },
    },

    {
      name: 'blocking the author removes THEIR posts from the feed and nothing else; unblocking restores them',
      run: async () => {
        assert(ctx.storyId, 'no story was created');

        const before = await fetchFeed(ctx.reader);
        assert(before.some((i) => i.id === ctx.storyId), 'the post must be visible before the block for this case to mean anything');
        const otherAuthorsBefore = before.filter((i) => i.user_id !== ctx.authorId).map((i) => i.id);

        const block = await gw(ctx.reader, '/users/blocks', { method: 'POST', body: { blocked_user_id: ctx.authorId } });
        assert(block.status === 200, `POST /users/blocks expected 200, got ${block.status}: ${block.text}`);
        ctx.blocked = true;

        const during = await fetchFeed(ctx.reader);
        assert(!during.some((i) => i.id === ctx.storyId), 'a blocked author\'s post is still in the feed');
        assert(
          !during.some((i) => i.user_id === ctx.authorId),
          `the feed still carries items from the blocked author: ${JSON.stringify(during.filter((i) => i.user_id === ctx.authorId).map((i) => i.id))}`
        );
        // The filter must be surgical: everyone else's items are untouched.
        const stillThere = new Set(during.map((i) => i.id));
        const collateral = otherAuthorsBefore.filter((id) => !stillThere.has(id));
        assert(
          collateral.length === 0,
          `blocking one author also hid ${collateral.length} other author(s)' item(s): ${JSON.stringify(collateral)}`
        );

        const unblock = await gw(ctx.reader, `/users/blocks/${ctx.authorId}`, { method: 'DELETE' });
        assert(unblock.status === 200, `DELETE /users/blocks/{id} expected 200, got ${unblock.status}: ${unblock.text}`);
        ctx.blocked = false;

        const after = await fetchFeed(ctx.reader);
        assert(after.some((i) => i.id === ctx.storyId), 'unblocking did not bring the author\'s post back to the feed');
      },
    },

    {
      name: 'DELETE /community/stories/{id} — only the author can delete, and the post leaves the feed',
      run: async () => {
        assert(ctx.storyId, 'no story was created');

        const notMine = await gw(ctx.reader, `/community/stories/${ctx.storyId}`, { method: 'DELETE' });
        assert(notMine.status === 403, `a non-author DELETE must be 403, got ${notMine.status}: ${notMine.text}`);
        const survived = await fetchFeed(ctx.author);
        assert(survived.some((i) => i.id === ctx.storyId), 'a refused delete removed the post anyway');

        const mine = await gw(ctx.author, `/community/stories/${ctx.storyId}`, { method: 'DELETE' });
        assert(mine.status === 204, `the author's DELETE expected 204, got ${mine.status}: ${mine.text}`);

        const gone = await fetchFeed(ctx.author);
        assert(!gone.some((i) => i.id === ctx.storyId), 'the deleted post is still in the feed');

        const readerFeed = await fetchFeed(ctx.reader);
        assert(!readerFeed.some((i) => i.id === ctx.storyId), "the deleted post is still in another user's feed");

        const repeat = await gw(ctx.author, `/community/stories/${ctx.storyId}`, { method: 'DELETE' });
        assert(repeat.status === 404, `a repeat DELETE must 404, got ${repeat.status}: ${repeat.text}`);

        ctx.storyId = null; // deleted cleanly
      },
    },

    {
      name: 'every community path — feed, stories, travel plans and hangouts — rejects an anonymous caller',
      run: async () => {
        const paths = [
          ['GET', '/community/feed'],
          ['POST', '/community/stories'],
          ['GET', '/community/travel-plans'],
          ['GET', '/community/hangouts'],
          ['POST', '/community/hangouts'],
          ['GET', '/community/hangouts/my'],
          ['POST', '/reports'],
        ];
        for (const [method, path] of paths) {
          const res = await fetch(`${config.gwUrl}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'POST' ? '{}' : undefined,
          });
          assert(res.status === 401, `anonymous ${method} ${path} must be 401, got ${res.status}`);
        }

        // Hangouts are otherwise out of scope (held back from launch), but the
        // list must still answer an authenticated caller — a 5xx here would
        // mean the service is down, not that the feature is unreleased.
        const authed = await gw(ctx.author, '/community/hangouts?limit=3');
        assert(authed.status === 200, `GET /community/hangouts (authed) expected 200, got ${authed.status}: ${authed.text}`);
      },
    },

    {
      name: 'cleanup — no post left behind, and no block left on the author',
      run: async () => {
        if (ctx.storyId) {
          await gw(ctx.author, `/community/stories/${ctx.storyId}`, { method: 'DELETE' });
          const feed = await fetchFeed(ctx.author);
          assert(!feed.some((i) => i.id === ctx.storyId), `cleanup failed: story ${ctx.storyId} is still in the feed`);
          console.log(`    · cleanup deleted leftover story ${ctx.storyId}`);
          ctx.storyId = null;
        }

        // Unconditional: a block left behind by a mid-flow failure would break
        // user-blocks.mjs and community-feed-block.mjs on the next run.
        if (ctx.reader && ctx.authorId) {
          await gw(ctx.reader, `/users/blocks/${ctx.authorId}`, { method: 'DELETE' });
          const blocks = await gw(ctx.reader, '/users/blocks');
          if (blocks.status === 200) {
            // GET /users/blocks answers { data: { blocked_user_ids: [...] } }.
            const ids = blocks.data?.blocked_user_ids ?? [];
            assert(
              !ids.includes(ctx.authorId),
              `cleanup failed: the reader still blocks the author — this WILL break the other block flows`
            );
          }
          ctx.blocked = false;
        }

        if (ctx.reportId) {
          console.log(`    · left a staging moderation report ${ctx.reportId} (cannot be withdrawn over the gateway)`);
        }
      },
    },
  ],
};
