// chat-service × document-service — a guest ↔ host thread about a listing,
// end to end: open it, send, read, reply, attach a file, and prove a third
// party can reach none of it.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// `/conversations` and `/messages` had ZERO coverage in this suite — 0 of the
// 12 conversation paths and 0 of the 4 message paths on the app gateway —
// despite being the only place two strangers exchange free text, and despite
// the attachment path (shipped 2026-08-28) moving real files through a
// PROTECTED bucket. A routing or auth regression here is a private-message
// leak, and nothing was watching for it.
//
// ── THE THREE IDENTITIES ───────────────────────────────────────────────────
//   guest    — TEST_EMAIL (`login()`), the one who messages a host about a space
//   host     — TEST_HOST_EMAIL (`loginHost()`), the seeded bot host
//   outsider — a throwaway `qa+<digits>@bot.com` (`registerFreshUser`), who
//              must be able to read exactly nothing
// Both named accounts are bots: chat-service publishes to messaging-events on
// every send, so a real participant would be pushed a notification per run.
//
// ── HOW THIS FLOW STAYS IDEMPOTENT ACROSS RUNS (read before editing) ───────
//
// 1. **The conversation is deduped, not recreated.** `CreateConversation`
//    matches an existing direct conversation on (participants, metadata
//    listing_id) and returns THAT one — with 201, not the 409 the spec
//    advertises (chat-service internal/service/chat_service.go:227-245). So
//    the 6-hourly suite reuses ONE conversation doc forever instead of
//    littering staging with a new thread per run. The file asserts that
//    dedupe explicitly, because it is what makes the flow safe to repeat.
// 2. **Teardown archives; setup un-archives.** `DELETE /conversations/{id}`
//    archives (204) and archiving drops it out of `GET /conversations` — but
//    a re-create returns the SAME id still `status:"archived"` (verified on
//    staging), so a naive next run would fail its "the host sees the thread"
//    assertion. Setup therefore re-activates via `PUT /conversations/{id}`
//    when it finds an archived thread. Don't remove one half without the other.
// 3. **Every message read is scoped with `after=<flow start>`.** Messages come
//    back OLDEST-first with a hard `Limit(limit)` applied before any cursor
//    (chat-service internal/repository/firestore/message.go:99-110), so once
//    this thread passes 50 messages an unscoped read would return the first
//    run's messages and never this one's. `after` keeps assertions about
//    THIS run's messages, forever. (That same ordering is a live product bug
//    for the app — see "BUGS FOUND" below.)
//
// ── WHAT IS DESCOPED, AND WHY ──────────────────────────────────────────────
//
// **No booking is created.** The obvious shape for this flow was "book the
// host's listing, then chat about it", but chat-service has no coupling to
// booking state at all: the only booking-flavoured thing it touches is
// passing `booking_code` straight through to the push payload
// (chat_service.go:634). A real request-to-book stay would add a Stripe
// authorization, a money teardown and two more failure modes to a file that
// asserts nothing about money — and `booking-lifecycle-flow.mjs` /
// `booking-host-flow.mjs` already own that state machine. The thread is
// opened with the listing metadata the mobile app sends when a guest taps
// "Message host" on a listing page, which is the same conversation shape.
//
// ── BUGS FOUND WHILE WRITING THIS, NOT FIXED (no backend changes here) ─────
//
// 1. **A non-participant is refused with 500, not 403/404.** Access IS
//    correctly denied — nothing leaks — but `GetConversationHandler`,
//    `GetMessagesHandler` and `SendMessageHandler` funnel every error,
//    including `ErrUnauthorized` and `ErrConversationNotFound`, into a 500
//    (chat_service.go:875-887, :990-1010, :1037-1060), while
//    `GetMessageAttachmentHandler` maps the SAME error values to 403/404
//    correctly (chat_service.go:1180-1187). The spec documents 403/404.
//    The cases below assert the SECURITY property (denied + no content
//    leaked), which is true and must stay true; the contract assertion lives
//    in `conversation-access-status.mjs.disabled`, ready to enable when the
//    handlers map their errors.
// 2. **`GET /conversations/unread` always returns 0.** It reads
//    `conversation.UnreadCount` off the raw repository list
//    (chat_service.go:1350-1366) without the personalization step that is the
//    only thing that ever computes it (chat_service.go:1629-1637); the stored
//    `unread_count` field is written 0 at create and `UpdateUnreadCount` has
//    no caller. Confirmed live on staging: a conversation showing
//    `unread_count:1` in `GET /conversations` reports `unread_count:0` from
//    `/conversations/unread`. Not asserted here because the mobile app does
//    not use that endpoint — it derives the badge from the list
//    (app/mobile lib/core/providers/notification_indicators_provider.dart:23),
//    which this file DOES assert. Reported, not fixed.
//
// ── LEAK DISCIPLINE ────────────────────────────────────────────────────────
// One reused conversation (archived at the end, end state verified), a
// handful of messages on it, one throwaway outsider account, and one ~70-byte
// PNG per run in the protected bucket — `DELETE /documents` is documented as
// "Currently not implemented" (document-service docs/api.yaml:144), so the
// attachment cannot be torn down from the gateway. That is the only residue.
import { login, loginHost, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';
import { registerFreshUser } from '../lib/booking-flow.mjs';

// A 1x1 transparent PNG — the smallest thing that is genuinely an image, so
// the attachment case proves the real MIME/size path rather than a stub.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const ctx = {
  guest: null,
  host: null,
  outsider: null,
  guestId: null,
  hostId: null,
  listingId: null,
  conversationId: null,
  // Everything this run wrote, so reads can be scoped with `after` (see the
  // header). Set just before the first message is sent.
  since: null,
  guestMessageId: null,
  hostMessageId: null,
  imageMessageId: null,
  attachmentUrl: null,
};

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

const conversationsOf = (res) => res.data?.conversations ?? [];
const findConv = (res, id) => conversationsOf(res).find((c) => c.id === id);

// Messages this run wrote, oldest first. See header note 3 on `after`.
async function messagesSince(tokens) {
  const res = await gw(tokens, `/conversations/${ctx.conversationId}/messages?limit=50&after=${encodeURIComponent(ctx.since)}`);
  assert(res.status === 200, `GET /conversations/{id}/messages expected 200, got ${res.status}: ${res.text}`);
  return res.data?.messages ?? [];
}

export default {
  name: 'chat-service (guest ↔ host conversation: open → send → read → reply → attach → outsider is locked out)',
  cases: [
    {
      name: 'POST /conversations — a guest opens a thread with a host about a listing, and a repeat open DEDUPES',
      run: async () => {
        ctx.guest = await login();
        ctx.host = await loginHost();
        ctx.guestId = await fetchMeId(ctx.guest);
        ctx.hostId = await fetchMeId(ctx.host);
        assert(ctx.guestId && ctx.hostId, 'could not resolve both identities from GET /users/me');
        assert(ctx.guestId !== ctx.hostId, 'the guest and host credentials resolve to the same user');

        const mine = await gw(ctx.host, '/listings/user');
        assert(mine.status === 200, `GET /listings/user failed ${mine.status}`);
        const listing = (mine.data ?? [])[0];
        assert(listing, 'TEST_HOST_EMAIL owns no listing to anchor the conversation to');
        ctx.listingId = listing.ID;

        const body = {
          participants: [ctx.guestId, ctx.hostId],
          type: 'direct',
          metadata: { listing_id: ctx.listingId, listing_title: listing.Title },
        };
        const created = await gw(ctx.guest, '/conversations', { method: 'POST', body });
        assert(created.status === 201, `POST /conversations expected 201, got ${created.status}: ${created.text}`);
        ctx.conversationId = created.data?.id ?? null;
        assert(ctx.conversationId, `POST /conversations returned no id: ${created.text}`);
        assert(
          created.data.participants?.includes(ctx.guestId) && created.data.participants?.includes(ctx.hostId),
          `participants are wrong: ${JSON.stringify(created.data.participants)}`
        );
        assert(created.data.metadata?.listing_id === ctx.listingId, 'the listing context was not stored on the conversation');

        // Previous runs archive this thread on the way out (see header note 2).
        if (created.data.status === 'archived') {
          const reopened = await gw(ctx.guest, `/conversations/${ctx.conversationId}`, { method: 'PUT', body: { status: 'active' } });
          assert(reopened.status === 200, `PUT /conversations/{id} (re-activate) expected 200, got ${reopened.status}: ${reopened.text}`);
          assert(reopened.data?.status === 'active', `re-activation did not stick: status=${reopened.data?.status}`);
        }

        // The dedupe itself: opening the same thread again must return the
        // SAME conversation, not a second one. Without this, the mobile app
        // would fork a new thread every time a guest reopened a listing.
        const again = await gw(ctx.guest, '/conversations', { method: 'POST', body });
        assert(again.status === 201, `a repeat POST /conversations expected 201, got ${again.status}: ${again.text}`);
        assert(
          again.data?.id === ctx.conversationId,
          `opening the same (participants, listing) thread twice created a second conversation: ${again.data?.id} vs ${ctx.conversationId}`
        );

        console.log(`    · conversation ${ctx.conversationId} on listing ${ctx.listingId}`);
      },
    },

    {
      name: 'POST /conversations/find — the thread is findable by (participants, listing_id), and the caller must be in it',
      run: async () => {
        assert(ctx.conversationId, 'no conversation was opened');

        const found = await gw(ctx.guest, '/conversations/find', {
          method: 'POST',
          body: { participants: [ctx.guestId, ctx.hostId], metadata: { listing_id: ctx.listingId } },
        });
        assert(found.status === 200, `POST /conversations/find expected 200, got ${found.status}: ${found.text}`);
        const ids = (found.data ?? []).map((c) => c.id);
        assert(ids.includes(ctx.conversationId), `find did not return the thread: ${JSON.stringify(ids)}`);

        // find() is an explicit participant-scoped lookup: a caller who names
        // two OTHER people must be refused, or it becomes a way to enumerate
        // other users' threads (chat_service.go:917-926).
        const outsiderTokens = (ctx.outsider ??= await registerFreshUser('Outsider')).tokens;
        const snoop = await gw(outsiderTokens, '/conversations/find', {
          method: 'POST',
          body: { participants: [ctx.guestId, ctx.hostId], metadata: { listing_id: ctx.listingId } },
        });
        assert(snoop.status === 401, `find() by a non-participant must be refused with 401, got ${snoop.status}: ${snoop.text}`);
        assert(!snoop.text.includes(ctx.conversationId), `find() leaked the conversation id to a non-participant: ${snoop.text}`);
      },
    },

    {
      name: 'POST /conversations/{id}/messages — the guest sends, and the HOST sees it as unread',
      run: async () => {
        assert(ctx.conversationId, 'no conversation was opened');
        // Scope every later read to this run (header note 3). One second back
        // to stay clear of clock skew between this machine and the service.
        ctx.since = new Date(Date.now() - 1000).toISOString();

        const sent = await gw(ctx.guest, `/conversations/${ctx.conversationId}/messages`, {
          method: 'POST',
          body: { content: 'Gateway suite: is this space available for my dates?', message_type: 'text' },
        });
        assert(sent.status === 201, `POST message expected 201, got ${sent.status}: ${sent.text}`);
        ctx.guestMessageId = sent.data?.id ?? null;
        assert(ctx.guestMessageId, `the sent message has no id: ${sent.text}`);
        assert(sent.data.sender_id === ctx.guestId, `sender_id must be the caller, got ${sent.data.sender_id}`);
        assert(sent.data.message_type === 'text', `message_type round-trip failed: ${sent.data.message_type}`);

        const hostList = await gw(ctx.host, '/conversations?limit=50');
        assert(hostList.status === 200, `GET /conversations (host) expected 200, got ${hostList.status}`);
        const conv = findConv(hostList, ctx.conversationId);
        assert(conv, `the thread is missing from the host's conversation list`);
        // The badge the mobile app actually renders is derived from this field
        // (notification_indicators_provider.dart:23).
        assert(conv.unread_count >= 1, `the host must see the new message as unread, got unread_count=${conv.unread_count}`);
        assert(conv.last_message?.id === ctx.guestMessageId, `last_message was not updated to the new message: ${conv.last_message?.id}`);

        const hostMessages = await messagesSince(ctx.host);
        assert(
          hostMessages.some((m) => m.id === ctx.guestMessageId),
          `the host cannot see the guest's message: ${JSON.stringify(hostMessages.map((m) => m.id))}`
        );

        const byId = await gw(ctx.host, `/messages/${ctx.guestMessageId}`);
        assert(byId.status === 200, `GET /messages/{id} expected 200 for a participant, got ${byId.status}: ${byId.text}`);
        assert(byId.data?.conversation_id === ctx.conversationId, 'GET /messages/{id} returned a message from another conversation');
      },
    },

    {
      name: 'PUT /conversations/{id}/read — reading clears the badge and stamps read_by',
      run: async () => {
        assert(ctx.guestMessageId, 'no guest message to read');

        const read = await gw(ctx.host, `/conversations/${ctx.conversationId}/read`, { method: 'PUT' });
        assert(read.status === 200, `PUT /conversations/{id}/read expected 200, got ${read.status}: ${read.text}`);
        assert(read.data?.marked_count >= 1, `marking read reported nothing marked: ${read.text}`);

        const hostList = await gw(ctx.host, '/conversations?limit=50');
        const conv = findConv(hostList, ctx.conversationId);
        assert(conv, 'the thread vanished from the host list after marking read');
        assert(conv.unread_count === 0, `the host's badge must clear after reading, got unread_count=${conv.unread_count}`);

        // read_by is what the sender's "seen" tick reads.
        const messages = await messagesSince(ctx.guest);
        const mine = messages.find((m) => m.id === ctx.guestMessageId);
        assert(mine, "the guest cannot see their own message");
        assert(mine.read_by && ctx.hostId in mine.read_by, `read_by was not stamped with the reader: ${JSON.stringify(mine.read_by)}`);
      },
    },

    {
      name: 'the host replies, the guest sees it — and /poll returns the same thing the list does',
      run: async () => {
        assert(ctx.conversationId, 'no conversation was opened');

        const reply = await gw(ctx.host, `/conversations/${ctx.conversationId}/messages`, {
          method: 'POST',
          body: { content: 'Gateway suite: yes, those dates are open.', message_type: 'text' },
        });
        assert(reply.status === 201, `host reply expected 201, got ${reply.status}: ${reply.text}`);
        ctx.hostMessageId = reply.data?.id ?? null;
        assert(reply.data?.sender_id === ctx.hostId, `the reply's sender_id is wrong: ${reply.data?.sender_id}`);

        const guestList = await gw(ctx.guest, '/conversations?limit=50');
        const conv = findConv(guestList, ctx.conversationId);
        assert(conv, 'the thread is missing from the guest conversation list');
        assert(conv.unread_count >= 1, `the guest must now have an unread reply, got ${conv.unread_count}`);

        const messages = await messagesSince(ctx.guest);
        const ids = messages.map((m) => m.id);
        assert(ids.includes(ctx.guestMessageId) && ids.includes(ctx.hostMessageId), `both sides' messages must be in the thread: ${JSON.stringify(ids)}`);
        assert(
          ids.indexOf(ctx.guestMessageId) < ids.indexOf(ctx.hostMessageId),
          `messages must come back in send order, got ${JSON.stringify(ids)}`
        );

        const poll = await gw(ctx.guest, `/conversations/${ctx.conversationId}/poll?since=${encodeURIComponent(ctx.since)}&limit=50`);
        assert(poll.status === 200, `GET /conversations/{id}/poll expected 200, got ${poll.status}: ${poll.text}`);
        const polled = (poll.data?.messages ?? []).map((m) => m.id);
        assert(
          polled.includes(ctx.hostMessageId),
          `poll must return the reply it is polling for: ${JSON.stringify(polled)}`
        );

        // Fire-and-forget; asserted only so a routing regression on it is caught.
        const typing = await gw(ctx.guest, `/conversations/${ctx.conversationId}/typing`, { method: 'POST', body: { is_typing: true } });
        assert(typing.status === 204, `POST /conversations/{id}/typing expected 204, got ${typing.status}: ${typing.text}`);
      },
    },

    {
      name: 'PUT /messages/{id}/read + PUT /messages/{id} — a single message can be read, and only its SENDER can edit it',
      run: async () => {
        assert(ctx.hostMessageId, 'no host reply to act on');

        const read = await gw(ctx.guest, `/messages/${ctx.hostMessageId}/read`, { method: 'PUT' });
        assert(read.status === 200, `PUT /messages/{id}/read expected 200, got ${read.status}: ${read.text}`);
        assert(read.data?.read_by && ctx.guestId in read.data.read_by, `read_by was not stamped for the reader: ${JSON.stringify(read.data?.read_by)}`);
        assert(read.data?.status === 'read', `a read message's status must become "read", got ${read.data?.status}`);

        // The guest is a participant but NOT the sender of the host's reply —
        // editing it must be refused (chat_service.go:691-694). Refusal, and
        // the content is unchanged; the status code is the same 500 mapping
        // bug this file's header documents.
        const original = read.data.content;
        const hijack = await gw(ctx.guest, `/messages/${ctx.hostMessageId}`, {
          method: 'PUT',
          body: { content: 'Gateway suite: a participant must not be able to rewrite the other side.' },
        });
        assert(hijack.status >= 400, `editing someone else's message must be refused, got ${hijack.status}: ${hijack.text}`);
        const unchanged = await gw(ctx.guest, `/messages/${ctx.hostMessageId}`);
        assert(unchanged.data?.content === original, `a refused edit still changed the message: ${unchanged.data?.content}`);

        // The sender editing their own message does work.
        const edited = 'Gateway suite: yes, those dates are open (edited).';
        const own = await gw(ctx.host, `/messages/${ctx.hostMessageId}`, { method: 'PUT', body: { content: edited } });
        assert(own.status === 200, `a sender editing their own message expected 200, got ${own.status}: ${own.text}`);
        assert(own.data?.content === edited, `the edit was not applied: ${own.data?.content}`);
        const reread = await gw(ctx.guest, `/messages/${ctx.hostMessageId}`);
        assert(reread.data?.content === edited, `the edit is not visible to the other participant: ${reread.data?.content}`);
      },
    },

    {
      name: 'POST /documents/upload + GET /messages/{id}/attachment — an attachment round-trips to the recipient, byte for byte',
      run: async () => {
        assert(ctx.conversationId, 'no conversation was opened');

        const form = new FormData();
        form.append('type', 'Messaging');
        form.append('file', new Blob([TINY_PNG], { type: 'image/png' }), 'gateway-suite.png');
        const upRes = await fetch(`${config.gwUrl}/documents/upload`, {
          method: 'POST',
          headers: authHeaders(ctx.guest, 'full'), // no Content-Type — fetch sets the multipart boundary
          body: form,
        });
        const upText = await upRes.text();
        assert(upRes.status === 200, `POST /documents/upload expected 200, got ${upRes.status}: ${upText}`);
        // Deliberately NOT the {success,data} envelope — this flat shape is a
        // contract consumed by chat-service and the app (document-service
        // docs/api.yaml UploadAttachmentResponse).
        const doc = JSON.parse(upText);
        for (const f of ['document_id', 'file_url', 'file_name', 'file_size', 'mime_type', 'storage_filename']) {
          assert(doc[f] !== undefined && doc[f] !== '', `upload response is missing the required field "${f}": ${upText}`);
        }
        assert(doc.mime_type === 'image/png', `mime_type was not preserved: ${doc.mime_type}`);
        assert(doc.file_size === TINY_PNG.length, `file_size is wrong: ${doc.file_size} vs ${TINY_PNG.length}`);
        ctx.attachmentUrl = doc.file_url;

        const sent = await gw(ctx.guest, `/conversations/${ctx.conversationId}/messages`, {
          method: 'POST',
          body: {
            content: doc.file_name,
            message_type: 'image',
            metadata: {
              storage_filename: doc.storage_filename,
              file_name: doc.file_name,
              file_url: doc.file_url,
              file_size: doc.file_size,
              mime_type: doc.mime_type,
            },
          },
        });
        assert(sent.status === 201, `sending an image message expected 201, got ${sent.status}: ${sent.text}`);
        ctx.imageMessageId = sent.data?.id ?? null;
        assert(sent.data?.message_type === 'image', `message_type must be image, got ${sent.data?.message_type}`);

        // The RECIPIENT fetching the SENDER's attachment is the whole point of
        // the endpoint (the bucket is private, so the bytes can only come
        // through here).
        const att = await fetch(`${config.gwUrl}/messages/${ctx.imageMessageId}/attachment`, { headers: authHeaders(ctx.host, 'full') });
        assert(att.status === 200, `the recipient must be able to fetch the attachment, got ${att.status}`);
        assert(att.headers.get('content-type') === 'image/png', `attachment content-type is wrong: ${att.headers.get('content-type')}`);
        assert(
          (att.headers.get('content-disposition') ?? '').includes('gateway-suite.png'),
          `attachment filename was not preserved: ${att.headers.get('content-disposition')}`
        );
        const bytes = Buffer.from(await att.arrayBuffer());
        assert(bytes.equals(TINY_PNG), `the attachment came back corrupted: ${bytes.length} bytes vs ${TINY_PNG.length}`);

        // A text message has no attachment, and must say so rather than 500.
        const none = await fetch(`${config.gwUrl}/messages/${ctx.guestMessageId}/attachment`, { headers: authHeaders(ctx.guest, 'full') });
        assert(none.status === 404, `a text message's attachment must 404, got ${none.status}`);
      },
    },

    {
      name: 'the attachment bucket stays private — the stored file_url is NOT anonymously fetchable',
      run: async () => {
        assert(ctx.attachmentUrl, 'no attachment was uploaded');
        assert(
          ctx.attachmentUrl.includes('-protected'),
          `a chat attachment must live in the protected bucket, got ${ctx.attachmentUrl}`
        );
        const res = await fetch(ctx.attachmentUrl);
        assert(
          res.status === 401 || res.status === 403,
          `the raw storage URL of a private chat attachment must not be anonymously readable, got ${res.status}`
        );
      },
    },

    {
      name: 'a non-participant can read NOTHING of this thread, and cannot post into it',
      run: async () => {
        assert(ctx.conversationId, 'no conversation was opened');
        const outsider = (ctx.outsider ??= await registerFreshUser('Outsider')).tokens;

        // The claim is the SECURITY property: refused, and no content leaked.
        // The status codes these three return today are wrong (500, not
        // 403/404) — see this file's header and
        // conversation-access-status.mjs.disabled. Asserting "not 200 and no
        // leak" is not a loosened assertion: it is the part that must hold
        // whatever the handlers do with their error mapping.
        const secret = 'Gateway suite: is this space available';
        const probes = [
          ['GET /conversations/{id}', await gw(outsider, `/conversations/${ctx.conversationId}`)],
          ['GET /conversations/{id}/messages', await gw(outsider, `/conversations/${ctx.conversationId}/messages`)],
          ['GET /messages/{id}', await gw(outsider, `/messages/${ctx.guestMessageId}`)],
          [
            'POST /conversations/{id}/messages',
            await gw(outsider, `/conversations/${ctx.conversationId}/messages`, {
              method: 'POST',
              body: { content: 'Gateway suite: an outsider must not be able to post here.', message_type: 'text' },
            }),
          ],
        ];
        for (const [label, res] of probes) {
          assert(res.status >= 400, `${label} must refuse a non-participant, got ${res.status}: ${res.text}`);
          assert(!res.text.includes(secret), `${label} LEAKED private message content to a non-participant: ${res.text}`);
          assert(!res.text.includes(ctx.hostId), `${label} leaked a participant id to a non-participant: ${res.text}`);
        }

        // The attachment handler maps its errors properly, so this one can
        // assert the real contract.
        const att = await fetch(`${config.gwUrl}/messages/${ctx.imageMessageId}/attachment`, { headers: authHeaders(outsider, 'full') });
        assert(att.status === 403, `a non-participant fetching an attachment must get 403, got ${att.status}`);

        // And the thread simply does not exist as far as their inbox is concerned.
        const list = await gw(outsider, '/conversations?limit=50');
        assert(list.status === 200, `GET /conversations for a fresh user expected 200, got ${list.status}`);
        assert(!findConv(list, ctx.conversationId), "the thread appeared in a non-participant's conversation list");

        // The outsider must not have been able to write, either.
        const messages = await messagesSince(ctx.guest);
        assert(
          !messages.some((m) => m.sender_id === ctx.outsider.id),
          `a non-participant's message was persisted into the thread: ${JSON.stringify(messages.map((m) => m.sender_id))}`
        );
      },
    },

    {
      name: 'anonymous callers are rejected by every conversation and message path',
      run: async () => {
        assert(ctx.conversationId, 'no conversation was opened');
        const paths = [
          ['GET', '/conversations'],
          ['GET', `/conversations/${ctx.conversationId}`],
          ['GET', `/conversations/${ctx.conversationId}/messages`],
          ['GET', `/messages/${ctx.guestMessageId}`],
          ['GET', `/messages/${ctx.imageMessageId}/attachment`],
        ];
        for (const [method, path] of paths) {
          const res = await fetch(`${config.gwUrl}${path}`, { method });
          assert(res.status === 401, `anonymous ${method} ${path} must be 401, got ${res.status}`);
        }
      },
    },

    {
      name: 'cleanup — the thread is archived and out of both inboxes',
      run: async () => {
        if (!ctx.conversationId) return;
        const del = await gw(ctx.guest, `/conversations/${ctx.conversationId}`, { method: 'DELETE' });
        assert(del.status === 204, `DELETE /conversations/{id} expected 204, got ${del.status}: ${del.text}`);

        // Verify the end state rather than trusting the 204: archived, and
        // gone from the list the app renders. It stays readable by id on
        // purpose — archive is not a delete.
        const after = await gw(ctx.guest, `/conversations/${ctx.conversationId}`);
        assert(after.status === 200, `an archived conversation should still be readable by id, got ${after.status}`);
        assert(after.data?.status === 'archived', `cleanup did not archive the thread: status=${after.data?.status}`);

        const list = await gw(ctx.guest, '/conversations?limit=50');
        assert(!findConv(list, ctx.conversationId), 'the archived thread is still in the guest inbox');
        console.log(`    · archived conversation ${ctx.conversationId}`);
      },
    },
  ],
};
