// Triggering the staging scheduled jobs a flow depends on.
//
// The booking auto-completion sweep is a Cloud Scheduler job that runs ONCE A
// DAY (`auto-complete-booking-job`, `0 9 * * *` UTC — verified against staging
// 2026-09-15). A payout row only exists after that sweep completes a booking,
// so CR-650's payout acceptance criteria cannot be observed by waiting: the
// flow has to fast-forward the booking's dates (lib/firestore.mjs) and then ask
// the sweep to run now.
//
// It is triggered through Cloud Scheduler rather than by calling
// booking-service's `/internal/jobs/bookings/auto-complete` directly, because
// that Cloud Run service grants `roles/run.invoker` only to three service
// accounts (booking-, dashboard- and user-service) — no human identity can
// invoke it, and punching a hole for one would be an IAM change for a test.
// `gcloud scheduler jobs run` makes the SCHEDULER invoke it with its own
// identity, exactly as the daily run does. Nothing is bypassed and no
// permission is added.
//
// This runs the real sweep, so it also completes any OTHER staging booking that
// is already eligible — which is precisely what the daily job would have done
// anyway, a few hours later.
//
// No gcloud (or no permission) → SKIP, not a failure.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { skip } from './skip.mjs';
import { STAGING_PROJECT } from './firestore.mjs';

const execFileAsync = promisify(execFile);

const LOCATION = 'us-central1';

export async function runAutoCompleteSweep() {
  try {
    await execFileAsync(
      'gcloud',
      [
        'scheduler',
        'jobs',
        'run',
        'auto-complete-booking-job',
        `--project=${STAGING_PROJECT}`,
        `--location=${LOCATION}`,
      ],
      { timeout: 120000 }
    );
  } catch (e) {
    const msg = `${e.stderr || ''}${e.message || ''}`;
    if (/not found|ENOENT|command not found/i.test(msg) && /gcloud/i.test(msg)) {
      skip('gcloud CLI not available — the booking auto-completion sweep cannot be triggered from here');
    }
    if (/PERMISSION_DENIED|does not have permission|Reauthentication|credentials/i.test(msg)) {
      skip(`no permission to run auto-complete-booking-job on ${STAGING_PROJECT} — \`gcloud auth login\` with an account that has cloudscheduler.jobs.run`);
    }
    throw new Error(`failed to trigger auto-complete-booking-job: ${msg.trim()}`);
  }
}
