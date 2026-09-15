// verification-service — reading a submission back.
//
// ENABLED 2026-09-14: the product bug below is FIXED (verification-service
// a329289 — `document_type` is now Optional on VerificationStatusResponse) and
// these cases pass against staging. The write-up is kept as the regression's
// history; the cases are the guard against it coming back.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BUG (found 2026-09-13 while writing services/verification-flow.mjs)
//
// As soon as a user owns ANY verification that is not an ID-document type, BOTH
// of their own read endpoints stop working:
//
//   GET /verifications            -> 200 {"success":false,"error":"Failed to get
//                                        verification history","data":null}
//   GET /verifications/{id}       -> 200 {"success":false,"error":"Failed to get
//                                        verification details","data":null}
//
// ROOT CAUSE — verification-service app/schemas/verification.py:113:
//
//     class VerificationStatusResponse(BaseModel):
//         ...
//         document_type: DocumentType = Field(..., description="Document type")
//
// `document_type` is a REQUIRED, non-Optional enum. A selfie verification is
// selfie-only by design — no government ID, so no document type (see
// app/schemas/selfie_submission.py's own docstring: "Unlike facematch, this is
// selfie-only — no government ID document"). Both routers build this model from
// the stored record (app/routers/verifications.py:395-406 for the list,
// :450-460 for the by-id read), pydantic raises on `document_type=None`, the
// blanket `except Exception` turns it into `success:false`, and the caller gets
// nothing. `voice`, `location` and `background` submissions have the same shape
// and will hit the same wall.
//
// STAGING EVIDENCE (verification-service, corneroom-82fbb, 2026-09-13T23:10:43Z
// and repeatedly at :15 / :19 / :27 / :43 — one pair per read attempt):
//
//   Failed to get user verifications: 1 validation error for VerificationStatusResponse
//   document_type
//     Input should be 'drivers_license', 'passport' or 'national_id'
//     [type=enum, input_value=None, input_type=NoneType]
//
//   Failed to get verification 2543a6a9-4145-4372-99b3-f5421818545a: 1 validation
//   error for VerificationStatusResponse  (same error)
//
// Reproduced end to end: a fresh account's history reads fine and empty; one
// selfie submission later, every read above fails, permanently, for that user.
// The WRITE path is unaffected — the submission is stored, processed, approved,
// and propagated to the user's profile correctly (that half is asserted, live,
// in services/verification-flow.mjs). This is purely a read-back serialization
// failure.
//
// WHY THE EXISTING SUITE MISSED IT: services/verification.mjs asserts
// `GET /verifications` returns **200**, and it does — the failure is inside a
// 200 envelope. A `success === true` check would have caught it.
//
// BLAST RADIUS: not staging-only, and not mode-only. The schema is hit on READ,
// so `AI_MODE` is irrelevant — production (`AI_MODE=manual`) is affected
// identically the moment a real user submits a selfie, voice, location or
// background verification. The mobile app does not currently call these two
// endpoints (it posts submissions and reads `success`;
// app/mobile lib/features/face_verification/data/face_verification_service.dart),
// which is presumably why it has gone unnoticed — but any screen or admin view
// that lists a user's own verification history is broken today.
//
// NOT FIXED HERE ON PURPOSE: this suite is test-only. The fix belongs in
// verification-service (make `document_type` optional on the response schema,
// or populate it per verification type) with its own unit test.
//
// WHAT TO DO WHEN IT IS FIXED: rename this file to `.mjs`. Every case below was
// written against the intended behaviour and needs no other change.
//
// ── WHY THE OWNERSHIP GUARD IS IN HERE TOO ────────────────────────────────
// It is not merely inconvenienced by the bug — it is UNPROVABLE while the bug is
// open, and would pass for the wrong reason. `get_verification` raises 403 for a
// non-owner BEFORE the response model is built (app/service/verification_service.py:179),
// and the router maps that to `success:false`. The owner's own read fails LATER,
// at model construction, and the router maps that to `success:false` as well.
// The two are indistinguishable from outside, so "another user was denied"
// currently holds for every caller including the rightful one. Keeping it here
// is the point: it must only count once the owner can actually read their own.
//
// LEAK DISCIPLINE: nothing here writes. The submission is made by a throwaway
// qa+<digits>@bot.com account and, as in verification-flow.mjs, verification
// records have no delete endpoint and contend with no shared fixture.
import { registerFreshUser } from '../lib/booking-flow.mjs';
import { login } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { authHeaders } from '../lib/auth.mjs';
import { poll } from '../lib/poll.mjs';

const ctx = {};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

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

async function anyPublishedImageUrl(tokens) {
  const { json } = await vs(tokens, '/listings?limit=20');
  const withThumb = (json?.data ?? []).find((l) => typeof l.thumbnail === 'string' && l.thumbnail.startsWith('https://'));
  assert(withThumb, 'no listing with an https thumbnail on this environment to use as a selfie URL fixture');
  return withThumb.thumbnail;
}

export default {
  name: 'verification-service (reading a submission back)',
  cases: [
    {
      name: 'setup: a fresh user submits a selfie and it is approved',
      run: async () => {
        ctx.user = await registerFreshUser('KycReadUser');
        const imageUrl = await anyPublishedImageUrl(ctx.user.tokens);
        const { data } = await vs(ctx.user.tokens, '/verifications/selfie', {
          method: 'POST',
          body: JSON.stringify({ selfie_image_url: imageUrl }),
        });
        assert(data?.id, `submission failed: ${JSON.stringify(data)}`);
        ctx.verificationId = data.id;

        // Observed via the profile rather than via /verifications/{id} — the
        // endpoint this file is about cannot be used to set up its own test.
        await poll(
          async () => {
            const { data: me } = await vs(ctx.user.tokens, '/users/me');
            const v = (me?.verifications ?? []).find((x) => x.type === 'selfie');
            return { done: v?.verified === true, value: v };
          },
          { timeoutMs: 120000, intervalMs: 5000, desc: 'the selfie to be approved' }
        );
      },
    },
    {
      name: 'THE BUG: the owner can read their own submission back by id',
      run: async () => {
        const { status, json, data } = await vs(ctx.user.tokens, `/verifications/${ctx.verificationId}`);
        assert(status === 200, `expected 200, got ${status}`);
        assert(
          json?.success === true,
          `a user must be able to read their own verification. This is the document_type schema bug in the file ` +
            `header — check verification-service's logs for "1 validation error for VerificationStatusResponse". Got ` +
            `${JSON.stringify(json)}`
        );
        assert(data.id === ctx.verificationId, `read back the wrong record: ${data.id}`);
        assert(data.verification_type === 'selfie', `expected verification_type='selfie', got '${data.verification_type}'`);
        assert(data.status === 'approved', `expected status='approved', got '${data.status}'`);
        assert(data.user_id === ctx.user.id, `record belongs to ${data.user_id}, not the caller ${ctx.user.id}`);
      },
    },
    {
      name: "THE BUG: the submission appears in the owner's verification history",
      run: async () => {
        const { json, data } = await vs(ctx.user.tokens, '/verifications?limit=10&offset=0');
        assert(json?.success === true, `history read failed — same schema bug: ${JSON.stringify(json)}`);
        assert(data.total === 1, `expected exactly the one submission in history, got total=${data.total}`);
        const row = data.verifications.find((v) => v.id === ctx.verificationId);
        assert(row, `the submission is missing from its own owner's history: ${JSON.stringify(data.verifications)}`);
        assert(row.status === 'approved', `expected the approved status in history, got '${row.status}'`);
      },
    },
    {
      // Only meaningful once the case above passes — see the file header. A
      // verification record is the most sensitive document a user has, and the
      // id being a uuid is not an access control. The shared tests/.env account
      // stands in for "some other authenticated user".
      name: "THE GUARD: another authenticated user cannot read someone else's verification",
      run: async () => {
        const mine = await vs(ctx.user.tokens, `/verifications/${ctx.verificationId}`);
        assert(
          mine.json?.success === true,
          'the owner cannot read their own record, so "another user is denied" would pass for the wrong reason — ' +
            'fix the schema bug in the file header before trusting this case'
        );

        const other = await login(); // the shared suite account — a different user
        const byId = await vs(other, `/verifications/${ctx.verificationId}`);
        assert(byId.json?.success === false, `another user was allowed to read the record: ${JSON.stringify(byId.json)}`);
        assert(!byId.data?.id, `a denied read must leak no record, got ${JSON.stringify(byId.data)}`);

        const results = await vs(other, `/verifications/${ctx.verificationId}/results`);
        assert(results.json?.success === false, `another user was allowed to read the AI results: ${JSON.stringify(results.json)}`);
        assert(!results.data, `a denied results read must leak nothing, got ${JSON.stringify(results.data)}`);

        const list = await vs(other, '/verifications?limit=10&offset=0');
        assert(
          !(list.data?.verifications ?? []).some((v) => v.id === ctx.verificationId),
          `another user's history leaked the record: ${JSON.stringify(list.data?.verifications)}`
        );
      },
    },
    {
      // A second, smaller gap found at the same time, recorded here so it isn't
      // lost: the selfie handler never writes `ai_results` (selfie_handler.py:114-120
      // sets only status and expires_at), so the owner's own results read comes
      // back "not available" forever. Asserted as the CURRENT contract, with the
      // note that a real liveness provider should turn this green-to-red — that
      // is the signal to replace it with an assertion on the real payload, not
      // to delete it. Kept in this file because, while the bug above is open, it
      // cannot be told apart from the generic failure either.
      name: 'GET /verifications/{id}/results reports no results for a selfie — the handler never writes ai_results',
      run: async () => {
        const { status, json } = await vs(ctx.user.tokens, `/verifications/${ctx.verificationId}/results`);
        assert(
          ![404, 405].includes(status),
          `GET /verifications/{id}/results is not routed on the app gateway (${status}) — re-run \`make gateway ENV=staging\``
        );
        assert(
          json?.success === false,
          `a selfie carries no ai_results today, so this must report none. A success here means a provider was wired ` +
            `in — replace this case with an assertion on the real payload: ${JSON.stringify(json)}`
        );
      },
    },
  ],
};
