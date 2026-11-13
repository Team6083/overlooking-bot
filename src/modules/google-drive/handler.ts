import { App } from '@slack/bolt';
import { drive_v3 } from 'googleapis';
import { Collection } from 'mongodb';
import { checkDriveCompliance, ComplianceCheckerOptions } from './checker';
import { computeJobUpdate, overallStatus, reactionForStatus } from './recheck-core';
import { setStatusReaction } from './recheck';
import { buildComplianceBlocks, encodeRecheckValue } from './report';

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
                    ...('user' in message && message.user ? { user: message.user } : {}),
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
                results.map(result => {
                    const { $set, $unset, $push } = computeJobUpdate({}, result, 'system', completedAt);
                    return this.jobCollection.updateOne(
                        { fileId: result.fileId, channel: message.channel, thread_ts: message.ts, status: 'pending' },
                        { $set: { ...$set, completedAt }, ...($unset ? { $unset } : {}), $push } as any
                    );
                })
            );

            const allCompliant = results.every(r => r.status === 'compliant');
            const skipNotify = this.reportOnlyViolations && allCompliant;

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
                const audit = await client.chat.postMessage({
                    channel: this.auditChannel,
                    blocks: buildComplianceBlocks(results, {
                        userId: message.user,
                        channel: message.channel,
                        recheckValue: encodeRecheckValue(message.channel, message.ts),
                    }),
                    text: 'Google Drive 合規稽核報告',
                });
                if (audit.ts) {
                    const auditChannel = audit.channel ?? this.auditChannel;
                    await this.jobCollection.updateMany(
                        { channel: message.channel, thread_ts: message.ts },
                        { $set: { auditMessage: { channel: auditChannel, ts: audit.ts } } }
                    );
                    try {
                        await setStatusReaction(client, auditChannel, audit.ts, reactionForStatus(overallStatus(results)));
                    } catch (err) {
                        logger.error('Failed to add the status reaction to the audit message', err);
                    }
                }
            }

            logger.debug(`Drive compliance checked for ${results.length} file(s) in ${message.channel}/${message.ts}`);
        });
    }
}
