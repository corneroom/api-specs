// verification-service × user-service — a KYC submission from the app's side:
// submit it, let it decide, and watch the decision reach the user's profile.
//
// The suite already guards the two things that must never regress on this
// service — that `GET /verifications` rejects `X-Corneroom-Access` alone
// (services/verification.mjs) and that the internal KYC-status write stays 404
// on the app gateway (services/security.mjs, the C1 unauthenticated-bypass
// regression). Neither says anything about whether verification actually WORKS.
// This does.
//
// ── READ-BACK IS NOT COVERED HERE — IT IS BROKEN ──────────────────────────
// Everything that reads a submission back (`GET /verifications`,
// `GET /verifications/{id}`, `/results`, and therefore the ownership guard on
// them) lives in services/verification-history-read.mjs.disabled, because it
// currently cannot pass: verification-service 500s internally on any user who
// owns a non-document verification. That file's header carries the root cause,
// the staging log evidence and the one-line re-enable. It is a product bug, not
// a test bug, and is deliberately NOT worked around here.
//
// ── WHY SELFIE, AND ONLY SELFIE ───────────────────────────────────────────
// Staging deploys with `AI_MODE=mock` (verification-service
// .github/workflows/ci.yml:242; production is `manual`, :232 — no real identity
// provider is wired up, so prod queues every submission for an admin instead).
// In mock mode the handlers do NOT agree on how they decide:
//
//   selfie     app/services/handlers/selfie_handler.py:114 — mock auto-APPROVES,
//              deterministically. Every other branch routes to NEEDS_REVIEW.
//   facematch / background / voice / location
//              random.choice(["approved","needs_review","rejected"]) per
//              submission (e.g. facematch_handler.py:121).
//
// So selfie is the only type whose outcome a test can assert at all, and
// **driving a REJECTION deterministically is impossible** — there is no seam for
// it (no "fail" fixture, no header, no metadata flag; the random branches are
// the only route to `rejected`, and a coin flip is not a test). The
// "submit → rejected → re-submit" scenario is therefore not covered, and
// covering it needs a product change, not a test change.
//
// Re-submission after an APPROVAL is also deliberately not asserted. The router
// has no duplicate guard — `submit` mints a fresh uuid every call
// (selfie_handler.py:54) — so a second submit just creates a second record.
// That may or may not be intended; pinning it would freeze an accident as a
// contract. It is reported, not encoded.
//
// ── NO IMAGE IS UPLOADED, ON PURPOSE ──────────────────────────────────────
// `selfie_image_url` is a pydantic `HttpUrl` that is stored and never fetched
// (app/schemas/selfie_submission.py; nothing in the mock path reads the bytes).
// Uploading a real selfie through document-service would create a Cloud Storage
// object this suite has no way to delete, on every 6-hourly run, to satisfy a
// field nothing looks at. So the submission points at a URL this environment has
// already published (a listing thumbnail, discovered at run time — never
// hardcoded), and the validation case proves the field is genuinely validated.
//
// ── LEAK DISCIPLINE (see rewards-referral-flow.mjs's header) ──────────────
// verification-service exposes no delete — `/verifications/{id}` is GET-only —
// so the submission record and the resulting profile entry cannot be cleaned.
// That is acceptable ONLY because both belong to a throwaway qa+<digits>@bot.com
// account created by this file: unlike a booking or a session seat they hold no
// shared fixture and contend with nothing, so they cannot degrade later runs.
// Nothing here touches a shared resource, so there is no teardown case — if a
// future case in this file ever does, it needs one.
import { registerFreshUser } from '../lib/booking-flow.mjs';
import { config } from '../lib/env.mjs';
import { authHeaders } from '../lib/auth.mjs';
import { poll } from '../lib/poll.mjs';

const ctx = {};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// verification-service answers on the HTTP layer with 200 + `success:false` for
// not-found / access-denied (its routers catch HTTPException and re-wrap it
// through APIResponse — app/routers/verifications.py:470, and APIException
// subclasses HTTPException, app/core/exceptions.py:4), but request-BODY
// validation is pydantic's, which rejects at the FastAPI layer with a real 422
// before any handler runs. Both shapes show up below, so return status and body.
async function vs(tokens, path, init = {}) {
  const res = await fetch(`${config.gwUrl}${path}`, {
    ...init,
    headers: {
      ...authHeaders(tokens, 'full'),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
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

const submitSelfie = (tokens, selfieImageUrl) =>
  vs(tokens, '/verifications/selfie', { method: 'POST', body: JSON.stringify({ selfie_image_url: selfieImageUrl }) });

// A real, already-published URL from THIS environment — never a hardcoded one,
// so the fixture survives a staging reseed and would be equally valid anywhere
// else this suite is pointed.
async function anyPublishedImageUrl(tokens) {
  const { json } = await vs(tokens, '/listings?limit=20');
  const withThumb = (json?.data ?? []).find((l) => typeof l.thumbnail === 'string' && l.thumbnail.startsWith('https://'));
  assert(withThumb, 'no listing with an https thumbnail on this environment to use as a selfie URL fixture');
  return withThumb.thumbnail;
}

export default {
  name: 'verification-service × user-service (submit → decide → land on the profile)',
  cases: [
    {
      // Also the only state in which the history endpoint currently works —
      // see verification-history-read.mjs.disabled. Kept here because an empty
      // history is genuinely the app's first-run state, and because it proves
      // the account really is fresh before anything is submitted.
      name: 'setup: a fresh user starts with an empty verification history',
      run: async () => {
        ctx.user = await registerFreshUser('KycUser');
        ctx.imageUrl = await anyPublishedImageUrl(ctx.user.tokens);

        const { status, json, data } = await vs(ctx.user.tokens, '/verifications?limit=10&offset=0');
        assert(status === 200, `expected 200 from the history endpoint, got ${status}`);
        assert(json?.success === true, `expected a successful history read for a fresh account, got ${JSON.stringify(json)}`);
        assert(
          Array.isArray(data?.verifications) && data.verifications.length === 0,
          `a brand-new account must have no verifications, got ${JSON.stringify(data?.verifications)}`
        );
        assert(data.total === 0, `expected total=0, got ${JSON.stringify(data.total)}`);
      },
    },
    {
      // Validation is the one job that field has: the handler stores the URL and
      // never fetches it, so a malformed value would otherwise sit in a KYC
      // record forever. pydantic rejects it at the FastAPI request-model layer,
      // so this is a real 422 — not the 200 + success:false envelope the rest of
      // the service uses.
      name: 'POST /verifications/selfie rejects a malformed selfie_image_url instead of storing it',
      run: async () => {
        const { status, json } = await submitSelfie(ctx.user.tokens, 'not-a-url');
        assert(
          ![404, 405].includes(status),
          `POST /verifications/selfie is not routed on the app gateway (${status}) — re-run \`make gateway ENV=staging\``
        );
        assert(status === 422, `a malformed selfie_image_url must be refused with 422, got ${status}: ${JSON.stringify(json)}`);
        assert(
          JSON.stringify(json?.detail ?? '').includes('selfie_image_url'),
          `the 422 must name the offending field so the app can surface it, got ${JSON.stringify(json)}`
        );
        assert(!json?.data?.id, `a refused submission must not create a verification, got ${JSON.stringify(json?.data)}`);
      },
    },
    {
      name: 'POST /verifications/selfie accepts a valid submission and returns it as pending',
      run: async () => {
        const { status, json, data } = await submitSelfie(ctx.user.tokens, ctx.imageUrl);
        assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
        assert(json?.success === true, `expected a successful submission, got ${JSON.stringify(json)}`);
        assert(data?.id, `expected a verification id, got ${JSON.stringify(data)}`);
        ctx.verificationId = data.id;
        // Every field of VerificationSubmissionResponse
        // (app/schemas/verification.py:96). The app shows the estimate on its
        // "we're checking this" screen, so a missing one is a blank UI.
        assert(data.status === 'pending', `a new submission starts pending, got '${data.status}'`);
        assert(
          typeof data.created_at === 'string' && data.created_at.length > 0,
          `expected created_at, got ${JSON.stringify(data.created_at)}`
        );
        assert(
          typeof data.estimated_processing_time === 'number',
          `expected an estimated_processing_time, got ${JSON.stringify(data.estimated_processing_time)}`
        );
      },
    },
    {
      // THE GUARD, and — while the read-back endpoints are broken — the only
      // way to observe the decision at all.
      //
      // verification-service processes the submission in a background task and
      // publishes `verification.approved`; user-service upserts it onto the
      // user's `verifications[]` (internal/events/verification_events.go and
      // internal/service/user.go:2851-2868). That array is what the app reads
      // for the verified badge and what booking-service's guest gate reads, so a
      // decision that never lands there is invisible to the entire product.
      //
      // Polls for `verified === true` specifically, NOT merely for a selfie
      // entry to exist: `verification_submitted` deliberately writes a
      // `pending`/verified:false entry first so the verification hub shows
      // "pending" rather than "not started" (verification_events.go:97-104), and
      // the approval overwrites it ~2s later. A poll on existence alone catches
      // the pending row and fails.
      name: 'THE GUARD: the approval reaches the user profile as a verified selfie entry',
      run: async () => {
        const entry = await poll(
          async () => {
            const { data } = await vs(ctx.user.tokens, '/users/me');
            const v = (data?.verifications ?? []).find((x) => x.type === 'selfie');
            return { done: v?.verified === true, value: v };
          },
          { timeoutMs: 120000, intervalMs: 5000, desc: "the approved selfie to reach the user's profile" }
        );
        assert(
          entry.status === 'approved',
          `staging runs AI_MODE=mock, where a selfie is deterministically auto-approved ` +
            `(verification-service selfie_handler.py:114) — the profile entry says '${entry.status}'. ` +
            `'needs_review' means the deployed AI_MODE is no longer 'mock'; anything else is a real regression`
        );
        assert(
          entry.reference_id === ctx.verificationId,
          `the profile entry must point back at the submission it came from — expected ${ctx.verificationId}, ` +
            `got '${entry.reference_id}'`
        );
        assert(
          typeof entry.expires_at === 'string' && new Date(entry.expires_at) > new Date(),
          `an approved selfie carries a future expiry (selfie_handler.py:115 sets +365d), got ${JSON.stringify(entry.expires_at)}`
        );
      },
    },
  ],
};
