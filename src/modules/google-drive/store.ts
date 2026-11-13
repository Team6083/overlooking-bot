import type { Collection, Document } from 'mongodb';
import { computeManualResolutionUpdate, JobState, OPEN_JOB_FILTER } from './recheck-core';
import type { ComplianceResult } from './types';

export type MarkHandledOutcome = 'marked' | 'not_found' | 'no_result' | 'compliant' | 'already_handled';

type JobCollection = Pick<Collection<Document>, 'findOne' | 'updateOne'>;

/**
 * Marks one job handled, but only while it is open (has a non-compliant result and no mark).
 * The write is conditioned on that, so a concurrent recheck or second submit cannot slip past.
 */
export async function markJobHandled(
    col: JobCollection,
    _id: unknown,
    by: string,
    at: Date,
    note: string,
): Promise<{ outcome: MarkHandledOutcome; job?: Document }> {
    const job = await col.findOne({ _id } as any);
    if (!job) return { outcome: 'not_found' };
    const outcome = (j: Document): MarkHandledOutcome =>
        j.manualResolution ? 'already_handled' : !j.result ? 'no_result' : 'compliant';
    if (job.manualResolution || !job.result || job.result.status === 'compliant') return { outcome: outcome(job), job };

    const { $set, $push } = computeManualResolutionUpdate({ result: job.result as ComplianceResult }, by, at, note);
    const res = await col.updateOne({ _id, ...OPEN_JOB_FILTER } as any, { $set, $push } as any);
    if (res.modifiedCount === 1) return { outcome: 'marked', job };
    // Lost a race: say why from the current state.
    const now = await col.findOne({ _id } as any);
    return { outcome: now ? outcome(now) : 'not_found', job: now ?? job };
}

export type { JobState };
