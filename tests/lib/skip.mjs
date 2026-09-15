// SKIP convention for `run` cases.
//
// Until now a case could only pass or fail. That is right for everything the
// suite could always drive, but the dispute-RESOLUTION flow needs two things CI
// deliberately does not have: a Stripe **secret** key and Firestore ADC for
// staging. Failing those cases on a CI runner would train everyone to ignore a
// red suite, and silently passing them would be worse — so they announce
// themselves as skipped, with the reason.
//
// A skip is NOT a soft failure. Only ever skip on a MISSING CAPABILITY
// (no credential, no dependency installed, wrong environment). Never skip
// because the thing under test misbehaved — that is a failure.
//
// Usage inside a case's `run`:
//   if (!haveSecretKey) skip('STRIPE_SECRET_KEY not set — see tests/README.md');
export class SkipError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipError';
    this.skip = true;
  }
}

export function skip(reason) {
  throw new SkipError(reason);
}

export const isSkip = (e) => !!e && e.skip === true;
