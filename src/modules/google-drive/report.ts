import type { KnownBlock } from '@slack/types';
import type { ComplianceResult } from './types';
import { diffResult, isCompliant, isRecheckFailure } from './recheck-core';

/** Slack allows 50 blocks per message; a file takes two (divider + section), so cap the files shown. */
export const MAX_FILES_SHOWN = 20;
const MAX_SECTION_CHARS = 3000;

function clampSection(text: string): string {
    return text.length <= MAX_SECTION_CHARS ? text : `${text.slice(0, MAX_SECTION_CHARS - 1)}…`;
}

/** Lower sorts first: violations, then files that could not be checked, then compliant ones. */
function statusRank(status: ComplianceResult['status']): number {
    return status === 'violations' ? 0 : status === 'compliant' ? 2 : 1;
}

/** When the list must be cut, keep the files that explain the overall status; stable within groups. */
export function prioritize<T>(items: T[], rank: (item: T) => number): T[] {
    if (items.length <= MAX_FILES_SHOWN) return items;
    return items.map((item, i) => ({ item, i, r: rank(item) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map(x => x.item);
}

function moreFilesBlock(hidden: number): KnownBlock | undefined {
    return hidden > 0
        ? { type: 'context', elements: [{ type: 'mrkdwn', text: `…另有 ${hidden} 個檔案未顯示` }] }
        : undefined;
}

export const RECHECK_ACTION_ID = 'drive_recheck';

export const STATUS_EMOJI: Record<string, string> = {
    compliant: ':white_check_mark:',
    violations: ':warning:',
    cannot_check: ':question:',
    not_accessible: ':no_entry:',
};

export const STATUS_LABEL: Record<string, string> = {
    compliant: '合規',
    violations: '發現違規',
    cannot_check: '無法稽核',
    not_accessible: '無法存取',
};

export function escapeMrkdwn(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Slack date token that renders in the viewer's timezone. */
export function slackDate(date: Date): string {
    return `<!date^${Math.floor(date.getTime() / 1000)}^{date_short_pretty} {time}|${date.toISOString()}>`;
}

export function fileLink(result: Pick<ComplianceResult, 'url' | 'fileName'>): string {
    // Always wrap the URL in <...> so Slack doesn't auto-link the surrounding
    // bold markers (`*`) into the URL itself.
    return result.fileName
        ? `<${result.url}|${escapeMrkdwn(result.fileName)}>`
        : `<${result.url}>`;
}

export function buildFileSection(result: ComplianceResult): string {
    const lines: string[] = [
        `${STATUS_EMOJI[result.status]} *${fileLink(result)}*`,
        `*狀態：* ${STATUS_LABEL[result.status]}`,
    ];

    if (result.status === 'violations') {
        for (const v of result.violations) {
            if (v.kind === 'public_access') {
                lines.push(v.allowFileDiscovery
                    ? ':unlock: 公開分享（任何人都可搜尋並存取）'
                    : ':link: 連結分享（知道連結的任何人可存取）');
            } else if (v.kind === 'domain_sharing') {
                lines.push(':office: 組織內分享（整個組織都可存取）');
            } else {
                lines.push(':file_folder: 檔案不在核准的位置（Shared Drive 或指定資料夾）');
            }
        }
    } else if (result.status === 'cannot_check') {
        lines.push('Bot 沒有權限查看此檔案的分享設定。');
    } else if (result.status === 'not_accessible') {
        lines.push('Bot 無法存取此檔案，可能是連結無效或存取受限。');
    }

    return lines.join('\n');
}

/** The button value that identifies a report: the channel and ts of the message that held the links. */
export function encodeRecheckValue(sourceChannel: string, sourceTs: string): string {
    return `${sourceChannel}|${sourceTs}`;
}

export function decodeRecheckValue(value: string | undefined): { channel: string; ts: string } | undefined {
    const m = /^([^|]+)\|([^|]+)$/.exec(value ?? '');
    return m ? { channel: m[1], ts: m[2] } : undefined;
}

export function recheckButton(value: string, actionId: string = RECHECK_ACTION_ID): {
    type: 'button'; text: { type: 'plain_text'; text: string; emoji: true }; action_id: string; value: string;
} {
    return {
        type: 'button',
        text: { type: 'plain_text', text: '🔄 重新檢查', emoji: true },
        action_id: actionId,
        value,
    };
}

export function buildComplianceBlocks(
    results: ComplianceResult[],
    auditContext?: { userId: string; channel: string; recheckValue?: string },
): KnownBlock[] {
    const headerText = auditContext
        ? `*Google Drive 合規稽核報告*\n由 <@${auditContext.userId}> 分享於 <#${auditContext.channel}>`
        : '*Google Drive 合規稽核報告*';

    const blocks: KnownBlock[] = [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: headerText },
        },
    ];
    for (const result of prioritize(results, r => statusRank(r.status)).slice(0, MAX_FILES_SHOWN)) {
        blocks.push({ type: 'divider' });
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: clampSection(buildFileSection(result)) },
        });
    }
    const more = moreFilesBlock(results.length - MAX_FILES_SHOWN);
    if (more) blocks.push(more);
    if (auditContext?.recheckValue) {
        blocks.push({ type: 'actions', elements: [recheckButton(auditContext.recheckValue)] });
    }
    return blocks;
}

export type RecheckEntry = {
    result: ComplianceResult;
    previous: ComplianceResult | undefined;
    /** Job doc id; with `handled` it decides whether the file gets a "mark handled" button. */
    jobId?: string;
    /** Whether the file was marked handled before this recheck. */
    hadManualResolution?: boolean;
    /** Whether the mark is still in place after this recheck. */
    handled?: boolean;
};

export const MARK_HANDLED_ACTION_PREFIX = 'drive_mark_handled';

export function markHandledButton(jobId: string, index: number) {
    return {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: '✔️ 標記已處理', emoji: true as const },
        action_id: `${MARK_HANDLED_ACTION_PREFIX}:${index}`,
        value: jobId,
    };
}

const FAILURE_REASON: Record<string, string> = { cannot_check: '無法稽核', not_accessible: '無法存取' };

/** One file's line in the recheck reply when the recheck of that file did not work. */
export function describeRecheckFailure(previous: ComplianceResult, next: ComplianceResult): string {
    return `❗ 複查失敗（${FAILURE_REASON[next.status] ?? STATUS_LABEL[next.status]}），保留上次結果：${STATUS_LABEL[previous.status]}`;
}

/** Blocks for the thread reply the audit message gets after each recheck. */
export function buildRecheckReplyBlocks(
    entries: RecheckEntry[],
    info: { triggeredBy: string; checkedAt: Date; recheckValue: string },
): KnownBlock[] {
    const failed = (e: RecheckEntry) => isRecheckFailure(e.previous, e.result);
    const allFailed = entries.length > 0 && entries.every(failed);
    const blocks: KnownBlock[] = [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: allFailed ? '*❗ 複查失敗*\n所有檔案都無法完成複查，未變更任何結果。' : '*🔄 重新檢查結果*' },
        },
        {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `由 <@${info.triggeredBy}> 觸發 · 檢查時間 ${slackDate(info.checkedAt)}` }],
        },
    ];
    // Non-compliant first (by the kept result); among compliant files, changed or failed before unchanged.
    const rank = (e: RecheckEntry) => {
        if (e.handled) return 2; // handled problems sit between open problems and compliant files
        const kept = failed(e) ? e.previous! : e.result;
        return isCompliant(kept.status)
            ? (!failed(e) && diffResult(e.previous, e.result).kind === 'unchanged' ? 4 : 3)
            : statusRank(kept.status);
    };
    for (const entry of prioritize(entries, rank).slice(0, MAX_FILES_SHOWN)) {
        const { result, previous } = entry;
        const cleared = !!entry.hadManualResolution && !entry.handled && !failed(entry);
        const kept = failed(entry) ? previous! : result;
        const body = (failed(entry)
            ? `${buildFileSection(previous!)}\n*複查：* ${describeRecheckFailure(previous!, result)}`
            : `${buildFileSection(result)}\n*變化：* ${diffResult(previous, result).text}`)
            + (cleared ? '\n:warning: 已處理標記已清除' : entry.handled ? '\n✔️ 已標記為已處理' : '');
        blocks.push({ type: 'divider' });
        const showButton = entry.jobId && !entry.handled && !isCompliant(kept.status);
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: clampSection(body) },
            ...(showButton ? { accessory: markHandledButton(entry.jobId!, blocks.length) } : {}),
        });
    }
    const more = moreFilesBlock(entries.length - MAX_FILES_SHOWN);
    if (more) blocks.push(more);
    blocks.push({ type: 'actions', elements: [recheckButton(info.recheckValue)] });
    return blocks;
}

export function buildRecheckFailedBlocks(info: { triggeredBy: string; checkedAt: Date; recheckValue: string }): KnownBlock[] {
    return [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*🔄 重新檢查失敗*\n由 <@${info.triggeredBy}> 觸發 · ${slackDate(info.checkedAt)}\n檢查時發生錯誤，已保留先前的檢查結果與狀態標記，請稍後再試。`,
            },
        },
        { type: 'actions', elements: [recheckButton(info.recheckValue)] },
    ];
}
