import { config } from './env.mjs';
import { authHeaders } from './auth.mjs';

// Resolve the caller's own user id (fresh call — not cached like runner.mjs's
// internal getMeId, since these helpers are used from top-level await in
// services/*.mjs modules before the runner exists).
export async function fetchMeId(tokens) {
  const res = await fetch(`${config.gwUrl}/users/me`, { headers: authHeaders(tokens, 'full') });
  const body = await res.json().catch(() => ({}));
  const u = body.data ?? body;
  return u.id ?? u.user_id ?? null;
}

// Find a real feed author (user_id) that isn't the caller, to use as a
// block/unblock fixture without seeding a second account. Returns null if
// the caller's feed currently has no items from other authors.
export async function pickOtherFeedAuthor(tokens, meId) {
  const res = await fetch(`${config.gwUrl}/community/feed?limit=25`, { headers: authHeaders(tokens, 'full') });
  if (res.status !== 200) return null;
  const body = await res.json().catch(() => ({}));
  const items = body.feed ?? [];
  for (const item of items) {
    const uid = (item.data ?? item).user_id;
    if (uid && uid !== meId) return uid;
  }
  return null;
}
