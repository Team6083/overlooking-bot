import type { ComplianceResult, ComplianceStatus, ComplianceViolation } from './types';

/** Overall state of one audit report (every file in the source message). */
export type OverallStatus = 'violations' | 'cannot_check' | 'compliant';

/** Every reaction the bot uses as a status marker on an audit message. */
export const STATUS_REACTIONS = ['warning', 'grey_question', 'white_check_mark', 'hourglass_flowing_sand'] as const;
export type StatusReaction = typeof STATUS_REACTIONS[number];
export const CHECKING_REACTION: StatusReaction = 'hourglass_flowing_sand';

export type HistoryEntry = {
    checkedAt: Date;
    /** Slack user id, or 'system' for the initial check. */
    checkedBy: string;
    status: ComplianceStatus;
    violations: ComplianceViolation[];
    /** A recheck that could not be completed; it is logged but changed nothing else. */
    failed?: boolean;
    errorMessage?: string;
    /** Absent (or `check`) for a check; `manual_resolution` when someone marked the file handled. */
    kind?: 'check' | 'manual_resolution';
    /** For `manual_resolution`: the handler's explanation. `checkedBy` is who marked it. */
    note?: string;
};

/** Someone marked a still-open problem as handled (file deleted, access lost, ...). */
export type ManualResolution = { by: string; at: Date; note: string };

/** The parts of a stored job document that the recheck logic reads; old docs may lack any of them. */
export type JobState = {
    result?: ComplianceResult;
    checkCount?: number;
    resolvedAt?: Date;
    manualResolution?: ManualResolution;
};

export function isCompliant(status: ComplianceStatus | undefined): boolean {
    return status === 'compliant';
}

/** violations beat cannot_check / not_accessible, which beat compliant. */
export function overallStatus(results: ComplianceResult[]): OverallStatus {
    if (results.some(r => r.status === 'violations')) return 'violations';
    if (results.some(r => r.status === 'cannot_check' || r.status === 'not_accessible')) return 'cannot_check';
    return 'compliant';
}

/** Overall status of a report; files marked as manually handled count as compliant. */
export function overallStatusOfJobs(jobs: Pick<JobState, 'result' | 'manualResolution'>[]): OverallStatus {
    return overallStatus(jobs.flatMap(j => !j.result ? [] : j.manualResolution ? [{ ...j.result, status: 'compliant' as const }] : [j.result]));
}

export function reactionForStatus(status: OverallStatus): StatusReaction {
    switch (status) {
        case 'violations': return 'warning';
        case 'cannot_check': return 'grey_question';
        default: return 'white_check_mark';
    }
}

const PLAIN_EMOJI: Record<ComplianceStatus, string> = {
    compliant: '✅',
    violations: '⚠️',
    cannot_check: '❔',
    not_accessible: '⛔',
};

export type ChangeKind = 'new' | 'unchanged' | 'fixed' | 'regressed' | 'changed';

export type ResultDiff = { kind: ChangeKind; text: string };

function violationKinds(result: ComplianceResult): string {
    return result.violations
        .map(v => v.kind === 'public_access' ? `public_access:${v.allowFileDiscovery}` : v.kind)
        .sort()
        .join(',');
}

/** Describes how a file's latest result differs from the previous one. */
export function diffResult(prev: ComplianceResult | undefined, next: ComplianceResult): ResultDiff {
    if (!prev) return { kind: 'new', text: `🆕 ${PLAIN_EMOJI[next.status]} 無先前結果可比較` };
    const arrow = `${PLAIN_EMOJI[prev.status]} → ${PLAIN_EMOJI[next.status]}`;
    if (prev.status === next.status) {
        if (violationKinds(prev) === violationKinds(next)) {
            return { kind: 'unchanged', text: `➖ ${PLAIN_EMOJI[next.status]} 無變化` };
        }
        return { kind: 'changed', text: `${arrow} 違規項目有變動` };
    }
    if (next.status === 'compliant') return { kind: 'fixed', text: `${arrow} 已修正` };
    if (prev.status === 'compliant') return { kind: 'regressed', text: `${arrow} 出現新問題` };
    return { kind: 'changed', text: `${arrow} 狀態變更` };
}

/** The legacy `status` field of a job document. */
export function jobStatusFor(result: ComplianceResult): 'completed' | 'error' {
    return result.status === 'not_accessible' || result.status === 'cannot_check' ? 'error' : 'completed';
}

/** Whether a "handled" mark that existed when a file was rechecked is still in place afterwards. */
export function markSurvivesRecheck(hadMark: boolean, result: ComplianceResult): boolean {
    return hadMark && result.status !== 'violations';
}

/** Open items: the latest result exists and is not compliant, and nobody marked it handled. */
export const OPEN_JOB_FILTER = {
    'result.status': { $exists: true, $ne: 'compliant' },
    manualResolution: { $exists: false },
} as const;

/** Exactly the jobs OPEN_JOB_FILTER does not match. */
export const CLOSED_JOB_FILTER = {
    $or: [
        { 'result.status': { $exists: false } },
        { 'result.status': 'compliant' },
        { manualResolution: { $exists: true } },
    ],
} as const;

/** A successful recheck that finds violations again voids a manual "handled" mark. */
export function clearsManualResolution(job: Pick<JobState, 'manualResolution'>, result: ComplianceResult): boolean {
    return !!job.manualResolution && result.status === 'violations';
}

export type JobUpdate = {
    $set?: Record<string, unknown>;
    $unset?: Record<string, ''>;
    $push: { history: HistoryEntry };
};

/**
 * The Mongo update to apply to a job document after a (re)check.
 * `resolvedAt` is set when the result turns compliant after a non-compliant one and cleared
 * when it stops being compliant; it is left alone otherwise.
 */
export function computeJobUpdate(job: JobState, result: ComplianceResult, checkedBy: string, checkedAt: Date): JobUpdate {
    const $set: Record<string, unknown> = {
        status: jobStatusFor(result),
        result,
        lastCheckedAt: checkedAt,
        checkCount: (job.checkCount ?? (job.result ? 1 : 0)) + 1,
    };
    const update: JobUpdate = {
        $set,
        $push: { history: { checkedAt, checkedBy, status: result.status, violations: result.violations } },
    };
    if (!isCompliant(result.status)) {
        update.$unset = { resolvedAt: '' };
        // The problem is demonstrably back, so any "handled" mark no longer holds. Unset it
        // unconditionally: a mark made after this job was read must not survive either.
        if (result.status === 'violations') update.$unset.manualResolution = '';
    } else if (job.result && !isCompliant(job.result.status)) {
        $set.resolvedAt = checkedAt;
    }
    return update;
}

/** A recheck result that says the check itself did not work (as opposed to a verdict on the file). */
export function isFailedCheck(result: ComplianceResult): boolean {
    return result.status === 'cannot_check' || result.status === 'not_accessible';
}

/** A recheck of a file that already has a stored result counts as failed when the check did not work. */
export function isRecheckFailure(previous: ComplianceResult | undefined, result: ComplianceResult): boolean {
    return !!previous && isFailedCheck(result);
}

/** The result to keep: a failed recheck keeps the previous one. */
export function effectiveResult(previous: ComplianceResult | undefined, result: ComplianceResult): ComplianceResult {
    return previous && isRecheckFailure(previous, result) ? previous : result;
}

/**
 * The Mongo update for a RECHECK. A failed recheck only appends a history entry marked `failed`
 * (and does not bump `checkCount`, which counts checks that produced a verdict); the stored
 * result, status, timestamps and `resolvedAt` stay as they were. Otherwise same as computeJobUpdate.
 */
export function computeRecheckUpdate(job: JobState, result: ComplianceResult, checkedBy: string, checkedAt: Date): JobUpdate {
    if (!isRecheckFailure(job.result, result)) return computeJobUpdate(job, result, checkedBy, checkedAt);
    return {
        $push: {
            history: {
                checkedAt,
                checkedBy,
                status: result.status,
                violations: result.violations,
                failed: true,
                ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
            },
        },
    };
}

/** The update for marking a job handled: the stored result is deliberately left alone. */
export function computeManualResolutionUpdate(job: { result: ComplianceResult }, by: string, at: Date, note: string): JobUpdate {
    return {
        $set: { manualResolution: { by, at, note } satisfies ManualResolution },
        $push: {
            history: {
                kind: 'manual_resolution',
                checkedAt: at,
                checkedBy: by,
                status: job.result.status,
                violations: job.result.violations,
                note,
            },
        },
    };
}

export type RecheckJob = JobState & { fileId: string; url: string };

export type RecheckStep = {
    results: ComplianceResult[];
    updates: JobUpdate[];
    /** Per job: whether the result the recheck produced was a failure (previous result kept). */
    failed: boolean[];
    /** Per job: whether its manual "handled" mark survives the recheck. */
    handledAfter: boolean[];
};

/**
 * The per-report recheck step, without Slack or DB: runs `check` for every job (a rejected check
 * is that file's failure, not the whole recheck's) and computes each job's update.
 */
export async function runRecheckStep(
    jobs: RecheckJob[],
    check: (job: RecheckJob) => Promise<ComplianceResult>,
    checkedBy: string,
    checkedAt: Date,
): Promise<RecheckStep> {
    const results = await Promise.all(jobs.map(job => check(job).catch((err): ComplianceResult => ({
        fileId: job.fileId, url: job.url, status: 'cannot_check', violations: [], errorMessage: String(err?.message ?? err),
    }))));
    return {
        results,
        updates: jobs.map((job, i) => computeRecheckUpdate(job, results[i], checkedBy, checkedAt)),
        failed: jobs.map((job, i) => isRecheckFailure(job.result, results[i])),
        handledAfter: jobs.map((job, i) => markSurvivesRecheck(!!job.manualResolution, results[i])),
    };
}

const GONE_ERRORS = new Set(['message_not_found', 'thread_not_found', 'channel_not_found', 'not_in_channel', 'is_archived']);

/** Whether a Slack API error means the audit message (or its channel) is no longer reachable. */
export function isMessageGoneError(err: unknown): boolean {
    const code = (err as any)?.data?.error;
    return typeof code === 'string' && GONE_ERRORS.has(code);
}

/** Slack errors that are harmless when switching reactions. */
export function isIgnorableReactionError(err: unknown): boolean {
    const code = (err as any)?.data?.error;
    return code === 'already_reacted' || code === 'no_reaction';
}
