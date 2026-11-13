import type { KnownBlock } from '@slack/types';
import type { ComplianceResult } from './types';
import { diffResult } from './recheck-core';

export const RECHECK_ACTION_ID = 'drive_recheck';

export const STATUS_EMOJI: Record<string, string> = {
    compliant: ':white_check_mark:',
    violations: ':warning:',
    cannot_check: ':grey_question:',
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
    for (const result of results) {
        blocks.push({ type: 'divider' });
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: buildFileSection(result) },
        });
    }
    if (auditContext?.recheckValue) {
        blocks.push({ type: 'actions', elements: [recheckButton(auditContext.recheckValue)] });
    }
    return blocks;
}

export type RecheckEntry = { result: ComplianceResult; previous: ComplianceResult | undefined };

/** Blocks for the thread reply the audit message gets after each recheck. */
export function buildRecheckReplyBlocks(
    entries: RecheckEntry[],
    info: { triggeredBy: string; checkedAt: Date; recheckValue: string },
): KnownBlock[] {
    const blocks: KnownBlock[] = [
        { type: 'section', text: { type: 'mrkdwn', text: '*🔄 重新檢查結果*' } },
        {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `由 <@${info.triggeredBy}> 觸發 · 檢查時間 ${slackDate(info.checkedAt)}` }],
        },
    ];
    for (const { result, previous } of entries) {
        blocks.push({ type: 'divider' });
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `${buildFileSection(result)}\n*變化：* ${diffResult(previous, result).text}` },
        });
    }
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
