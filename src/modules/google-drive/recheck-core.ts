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
};

/** The parts of a stored job document that the recheck logic reads; old docs may lack any of them. */
export type JobState = {
    result?: ComplianceResult;
    checkCount?: number;
    resolvedAt?: Date;
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
