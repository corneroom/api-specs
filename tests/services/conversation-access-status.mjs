// chat-service — the STATUS CODE a conversation or message read returns when
// the caller may not see it, or when it does not exist.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// Access control here was always correct — nothing leaked, and
// `services/conversation-flow.mjs` asserts that live — but until 2026-09-15
// every conversation and message path except the attachment one refused a
// non-participant with **500 Internal Server Error** instead of 403, and
// returned 500 for a conversation that does not exist instead of 404:
//
//   GET  /conversations/{id}           -> 500 {"error":"Unauthorized access"}
//   GET  /conversations/{id}/messages  -> 500 "Unauthorized access\n"
//   POST /conversations/{id}/messages  -> 500 {"error":"Unauthorized access"}
//   GET  /messages/{id}                -> 500 "Unauthorized access\n"
//   GET  /messages/{id}/attachment     -> 403 "forbidden"          <- correct
//
// Worse, a missing conversation echoed the raw Firestore error back to the
// client, project id and document path included:
//
//   GET /conversations/00000000-0000-4000-8000-000000000000
//   -> 500 {"error":"rpc error: code = NotFound desc = \"projects/corneroom-82fbb/
//           databases/(default)/documents/conversations/0000...\" not found"}
//
// The handlers now map the service-layer sentinels the way
// `GetMessageAttachmentHandler` always did — `ErrUnauthorized` -> 403,
// `ErrConversationNotFound` / `ErrMessageNotFound` -> 404 — and the
// repository classifies not-found by gRPC status code instead of by an error
// string that never matched, so the path never reaches a response body.
//
// Why it matters beyond tidiness: 500s are what alerting and error budgets
// count. A user tapping a stale push notification for a conversation they
// were removed from used to register as a server fault, and the mobile client
// could not tell "you may not see this" from "we broke". 403/404 is what
// chat-service's own spec documents for these operations (chat-service
// docs/api.yaml, /conversations/{conversationId} and
// /conversations/{conversationId}/messages).
//
// This file asserts ONLY the status codes and that no datastore internals
// appear in the body — the security property itself is covered, live and
// always-on, by `services/conversation-flow.mjs`.
import { login, loginHost, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';
import { registerFreshUser } from '../lib/booking-flow.mjs';

const ctx = { conversationId: null, messageId: null, guest: null, outsider: null };

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// The missing-conversation body used to be the raw Firestore error, which
// names the GCP project and the full document path.
function assertNoDatastoreLeak(body) {
  for (const marker of ['projects/', 'databases/', 'rpc error']) {
    assert(!body.includes(marker), `response body leaks datastore internals ("${marker}"): ${body}`);
  }
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

// Reuses the same deduped guest↔host thread services/conversation-flow.mjs
// drives, so enabling this file costs one extra conversation-open and one
// throwaway account, not a second fixture.
async function setup() {
  ctx.guest = await login();
  const host = await loginHost();
  const guestId = await fetchMeId(ctx.guest);
  const hostId = await fetchMeId(host);
  const mine = await gw(host, '/listings/user');
  const listing = (mine.data ?? [])[0];
  assert(listing, 'TEST_HOST_EMAIL owns no listing to anchor the conversation to');

  const conv = await gw(ctx.guest, '/conversations', {
    method: 'POST',
    body: { participants: [guestId, hostId], type: 'direct', metadata: { listing_id: listing.ID } },
  });
  assert(conv.status === 201, `POST /conversations expected 201, got ${conv.status}: ${conv.text}`);
  ctx.conversationId = conv.data.id;
  if (conv.data.status === 'archived') {
    await gw(ctx.guest, `/conversations/${ctx.conversationId}`, { method: 'PUT', body: { status: 'active' } });
  }

  const msg = await gw(ctx.guest, `/conversations/${ctx.conversationId}/messages`, {
    method: 'POST',
    body: { content: 'Gateway suite: access-status fixture message.', message_type: 'text' },
  });
  assert(msg.status === 201, `seed message expected 201, got ${msg.status}: ${msg.text}`);
  ctx.messageId = msg.data.id;

  ctx.outsider = await registerFreshUser('Outsider');
}

export default {
  name: 'chat-service (non-participant access returns the DOCUMENTED status: 403 / 404, never 500)',
  cases: [
    {
      name: 'GET /conversations/{id} — a non-participant gets 403, not 500',
      run: async () => {
        await setup();
        const res = await gw(ctx.outsider.tokens, `/conversations/${ctx.conversationId}`);
        assert(res.status === 403, `expected 403, got ${res.status}: ${res.text}`);
        assertNoDatastoreLeak(res.text);
      },
    },
    {
      name: 'GET /conversations/{id}/messages — a non-participant gets 403, not 500',
      run: async () => {
        const res = await gw(ctx.outsider.tokens, `/conversations/${ctx.conversationId}/messages`);
        assert(res.status === 403, `expected 403, got ${res.status}: ${res.text}`);
        assertNoDatastoreLeak(res.text);
      },
    },
    {
      name: 'POST /conversations/{id}/messages — a non-participant gets 403, not 500',
      run: async () => {
        const res = await gw(ctx.outsider.tokens, `/conversations/${ctx.conversationId}/messages`, {
          method: 'POST',
          body: { content: 'Gateway suite: this must be refused.', message_type: 'text' },
        });
        assert(res.status === 403, `expected 403, got ${res.status}: ${res.text}`);
        assertNoDatastoreLeak(res.text);
      },
    },
    {
      name: 'GET /messages/{id} — a non-participant gets 403, not 500',
      run: async () => {
        const res = await gw(ctx.outsider.tokens, `/messages/${ctx.messageId}`);
        assert(res.status === 403, `expected 403, got ${res.status}: ${res.text}`);
        assertNoDatastoreLeak(res.text);
      },
    },
    {
      name: 'GET /conversations/{id} — a conversation that does not exist is 404, not 500',
      run: async () => {
        const res = await gw(ctx.guest, '/conversations/00000000-0000-4000-8000-000000000000');
        assert(res.status === 404, `expected 404 for a missing conversation, got ${res.status}: ${res.text}`);
        assertNoDatastoreLeak(res.text);
      },
    },
    {
      name: 'cleanup — archive the fixture thread',
      run: async () => {
        if (!ctx.conversationId) return;
        const del = await gw(ctx.guest, `/conversations/${ctx.conversationId}`, { method: 'DELETE' });
        assert(del.status === 204, `DELETE /conversations/{id} expected 204, got ${del.status}`);
        const after = await gw(ctx.guest, `/conversations/${ctx.conversationId}`);
        assert(after.data?.status === 'archived', `cleanup did not archive the thread: ${after.data?.status}`);
      },
    },
  ],
};
