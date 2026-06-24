import { App } from '@slack/bolt';
import { KnownBlock } from '@slack/types';
import { drive_v3 } from 'googleapis';
import { Collection } from 'mongodb';
import { checkDriveCompliance, ComplianceCheckerOptions, ComplianceResult } from '../google-drive-checker';

const DRIVE_LINK_PATTERNS = [
    /https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/g,
    /https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/g,
    /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation|forms|drawings)\/d\/([a-zA-Z0-9_-]+)/g,
    /https?:\/\/drive\.google\.com\/open\?(?:[^&\s]*&)*id=([a-zA-Z0-9_-]+)/g,
    /https?:\/\/drive\.google\.com\/uc\?(?:[^&\s]*&)*id=([a-zA-Z0-9_-]+)/g,
];

function extractDriveLinks(text: string): Array<{ id: string; url: string }> {
    const seen = new Set<string>();
    const results: Array<{ id: string; url: string }> = [];

    for (const pattern of DRIVE_LINK_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            const id = match[1];
            const url = match[0];
            if (!seen.has(id)) {
                seen.add(id);
                results.push({ id, url });
            }
        }
    }

    return results;
}

function buildComplianceBlocks(
    results: ComplianceResult[],
    auditContext?: { userId: string; channel: string },
): KnownBlock[] {
    const blocks: KnownBlock[] = [
        {
            type: 'header',
            text: { type: 'plain_text', text: 'Google Drive 合規稽核報告', emoji: true },
        },
    ];

    if (auditContext) {
        blocks.push({
            type: 'context',
            elements: [{
                type: 'mrkdwn',
                text: `由 <@${auditContext.userId}> 分享於 <#${auditContext.channel}>`,
            }],
        });
    }

    for (const result of results) {
        const linkText = result.fileName
            ? `*<${result.url}|${result.fileName}>*`
            : `*${result.url}*`;

        blocks.push({ type: 'divider' });

        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: linkText },
        });

        const statusLabel: Record<string, string> = {
            compliant: ':white_check_mark: 合規',
            violations: ':warning: 發現違規',
            cannot_check: ':grey_question: 無法稽核',
            not_accessible: ':no_entry: 無法存取',
        };

        blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `狀態：${statusLabel[result.status]}` }],
        });

        if (result.status === 'violations') {
            for (const v of result.violations) {
                let text: string;
                if (v.kind === 'public_access') {
                    text = v.allowFileDiscovery
                        ? ':unlock: 公開分享（任何人都可搜尋並存取）'
                        : ':link: 連結分享（知道連結的任何人可存取）';
                } else if (v.kind === 'domain_sharing') {
                    text = ':office: 組織內分享（整個組織都可存取）';
                } else {
                    text = ':file_folder: 檔案不在核准的位置（Shared Drive 或指定資料夾）';
                }
                blocks.push({
                    type: 'section',
                    text: { type: 'mrkdwn', text },
                });
            }
        } else if (result.status === 'cannot_check') {
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: 'Bot 沒有權限查看此檔案的分享設定。' },
            });
        } else if (result.status === 'not_accessible') {
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: 'Bot 無法存取此檔案，可能是連結無效或存取受限。' },
            });
        }
    }

    return blocks;
}

export class GoogleDriveCheckModule {
    constructor(
        private app: App,
        private driveClient: drive_v3.Drive,
        private jobCollection: Collection,
        private checkerOptions: ComplianceCheckerOptions,
        private reportOnlyViolations: boolean,
        private auditChannel?: string,
    ) {}

    async init() {
        this.app.message('', async ({ message, client, logger }) => {
            if (message.subtype !== undefined) return;
            if (!('text' in message) || !message.text) return;

            const links = extractDriveLinks(message.text);
            if (links.length === 0) return;

            const now = new Date();
            await this.jobCollection.insertMany(
                links.map(({ id, url }) => ({
                    fileId: id,
                    url,
                    channel: message.channel,
                    thread_ts: message.ts,
                    requestedAt: now,
                    status: 'pending',
                }))
            );

            const results = await Promise.all(
                links.map(({ id, url }) =>
                    checkDriveCompliance(id, url, this.driveClient, this.checkerOptions, logger)
                )
            );

            const completedAt = new Date();
            await Promise.all(
                results.map(result =>
                    this.jobCollection.updateOne(
                        { fileId: result.fileId, thread_ts: message.ts, status: 'pending' },
                        { $set: { status: result.status === 'not_accessible' || result.status === 'cannot_check' ? 'error' : 'completed', result, completedAt } }
                    )
                )
            );

            const hasViolations = results.some(r => r.status === 'violations');
            const skipNotify = this.reportOnlyViolations && !hasViolations;

            if (!skipNotify && 'user' in message && message.user) {
                // 只有傳訊者看得到的 ephemeral 通知
                await client.chat.postEphemeral({
                    channel: message.channel,
                    user: message.user,
                    blocks: buildComplianceBlocks(results),
                    text: 'Google Drive 合規稽核報告',
                });
            }

            if (!skipNotify && this.auditChannel && 'user' in message && message.user) {
                await client.chat.postMessage({
                    channel: this.auditChannel,
                    blocks: buildComplianceBlocks(results, {
                        userId: message.user,
                        channel: message.channel,
                    }),
                    text: 'Google Drive 合規稽核報告',
                });
            }

            logger.debug(`Drive compliance checked for ${results.length} file(s) in ${message.channel}/${message.ts}`);
        });
    }
}
