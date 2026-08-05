import {
  insertQueuedCall,
  markContactDone,
  markDialing,
  markEnded,
  markFailed,
} from "../calls/queries.js";
import type { Config } from "../config.js";
import type { Pool } from "../db/client.js";
import { withTransaction } from "../db/client.js";
import {
  acquireNumber,
  attachLeaseToCall,
  releaseLease,
  sweepExpiredLeases,
} from "../numbers/pool.js";
import { presignGet, type S3Client } from "../s3.js";
import type { DialerProvider } from "./dialer.js";
import {
  claimNextContact,
  completeFinishedCampaigns,
  questionKeysFor,
  releaseContact,
  runnableCampaigns,
} from "./queries.js";

/**
 * One hour. The Worker computes the runway it needs from the question count
 * and refuses a URL that expires too soon; an hour clears the ten-question
 * worst case with room to spare.
 */
export const PRESIGN_TTL_SECONDS = 3600;

export const TICK_MS = 2000;

/**
 * Automatic redials per contact. Failure here is a dial that never reached
 * Telnyx - a Worker outage or a secret mismatch - so a couple of retries
 * absorb a blip, and the cap stops a misconfiguration from looping forever.
 * After the cap the contact is done and the call's Retry button is the path.
 */
export const MAX_DIAL_ATTEMPTS = 3;

export interface DispatchDeps {
  pool: Pool;
  config: Config;
  s3: S3Client;
  dialer: DialerProvider;
}

/**
 * One pass of the loop. Kept separate from the timer so the whole behaviour is
 * testable without waiting on real time.
 */
export async function dispatchOnce(
  deps: DispatchDeps,
): Promise<{ dialled: number; swept: number }> {
  const { pool, config, s3, dialer } = deps;

  // A lease that outlived its call would otherwise hold a number forever.
  const strandedCallIds = await sweepExpiredLeases(pool);
  for (const callId of strandedCallIds) {
    await markEnded(pool, {
      callId,
      outcome: "unknown",
      lastStep: null,
      hangupCause: null,
    });
    // The hangup callback that normally does this never arrived. Done, not
    // pending: an unknown outcome must not auto-redial someone who may have
    // just finished the survey. The call is ended, so Retry stays available.
    await markContactDone(pool, callId);
  }

  let dialled = 0;

  for (const campaign of await runnableCampaigns(pool)) {
    // Keep taking numbers for this campaign until the pool says no.
    for (;;) {
      const lease = await acquireNumber(pool, campaign.tenantId);
      if (!lease) break;

      const claimed = await withTransaction(pool, async (client) => {
        const contact = await claimNextContact(client, campaign.id);
        if (!contact) return null;

        const queued = await insertQueuedCall(client, {
          campaignId: campaign.id,
          contactId: contact.contactId,
          phoneNumberId: lease.phoneNumberId,
        });
        await attachLeaseToCall(client, lease.leaseId, queued.id);
        return { ...contact, callId: queued.id, attempt: queued.attempt };
      });

      if (!claimed) {
        // Somebody else took the last contact between the two statements.
        await releaseLease(pool, lease.leaseId);
        break;
      }

      const keys = await questionKeysFor(pool, campaign.id);
      const audio = {
        questions: await Promise.all(
          keys.map((key) => presignGet(s3, config, key, PRESIGN_TTL_SECONDS)),
        ),
        thanks: await presignGet(
          s3,
          config,
          campaign.thanksS3Key,
          PRESIGN_TTL_SECONDS,
        ),
      };

      try {
        const { callControlId } = await dialer.dial({
          to: claimed.e164,
          from: lease.e164,
          silenceMs: campaign.silenceMs,
          audio,
          callbackUrl: `${config.publicBaseUrl}/callbacks/worker`,
        });
        await markDialing(pool, claimed.callId, callControlId);
        dialled += 1;
      } catch (error) {
        // A failed dial must not consume the contact or the number. The call
        // row stays as history so the operator can see why it failed.
        await markFailed(pool, claimed.callId);
        await releaseLease(pool, lease.leaseId);
        if (claimed.attempt >= MAX_DIAL_ATTEMPTS) {
          // Terminal for this contact: done + a failed call keeps the manual
          // Retry button as the only way it dials again.
          await markContactDone(pool, claimed.callId);
        } else {
          await releaseContact(pool, claimed.contactId);
        }
        console.error(
          JSON.stringify({
            msg: "dial_failed",
            call_id: claimed.callId,
            to: claimed.e164,
            error: String(error),
          }),
        );
        break;
      }
    }
  }

  await completeFinishedCampaigns(pool);

  return { dialled, swept: strandedCallIds.length };
}

export function startDispatcher(deps: DispatchDeps): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await dispatchOnce(deps);
      if (result.dialled > 0 || result.swept > 0) {
        console.log(JSON.stringify({ msg: "dispatch_tick", ...result }));
      }
    } catch (error) {
      // One bad tick must not end the loop.
      console.error(JSON.stringify({ msg: "dispatch_tick_failed", error: String(error) }));
    }
    if (!stopped) timer = setTimeout(() => void tick(), TICK_MS);
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
