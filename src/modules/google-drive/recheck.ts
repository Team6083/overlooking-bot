import { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';
import { randomUUID } from 'node:crypto';
import { drive_v3 } from 'googleapis';
import { Collection } from 'mongodb';
import { AppHomeModule } from '../app-home';
import { checkDriveCompliance } from './checker';
import {
    CHECKING_REACTION,
    computeJobUpdate,
    isIgnorableReactionError,
    isMessageGoneError,
    JobState,
    overallStatus,
    reactionForStatus,
    STATUS_REACTIONS,
    StatusReaction,
} from './recheck-core';
import {
    buildRecheckFailedBlocks,
    buildRecheckReplyBlocks,
    decodeRecheckValue,
    encodeRecheckValue,
    fileLink,
    RECHECK_ACTION_ID,
    recheckButton,
    slackDate,
    STATUS_EMOJI,
    STATUS_LABEL,
} from './report';
import type { ComplianceCheckerOptions, ComplianceResult } from './types';

import type { RecheckAllowed } from '../../config';

const HOME_ACTION_PREFIX = 'drive_recheck_home';
const LOCK_TTL_MS = 2 * 60 * 1000;
const HOME_MAX_ROWS = 20; // one block per row keeps the home well under Slack's 100-block limit

/** Makes `reaction` the only bot status reaction on the message. */
export async function setStatusReaction(client: WebClient, channel: string, ts: string, reaction: StatusReaction) {
    for (const name of STATUS_REACTIONS) {
        if (name === reaction) continue;
        try {
            await client.reactions.remove({ channel, timestamp: ts, name });
        } catch (err) {
            if (!isIgnorableReactionError(err)) throw err;
        }
    }
    try {
        await client.reactions.add({ channel, timestamp: ts, name: reaction });
    } catch (err) {
        if (!isIgnorableReactionError(err)) throw err;
    }
}

type Logger = { error: (msg: string, ...args: any[]) => void; debug?: (msg: string, ...args: any[]) => void };

/** Rechecks audit reports on demand, from the audit message's button or from the App Home overview. */
export class GoogleDriveRecheckModule {
    private permalinks = new Map<string, string | undefined>();

    constructor(
        private app: App,
        private appHome: AppHomeModule,
        private driveClient: drive_v3.Drive,
        private jobCollection: Collection,
        private checkerOptions: ComplianceCheckerOptions,
        private auditChannel: string,
        private allowed: RecheckAllowed,
    ) {}

    async init() {
        this.app.action(RECHECK_ACTION_ID, async ({ ack, body, action, client, logger }) => {
            await ack();
            await this.handleClick(client, body, action, logger, false);
        });
        this.app.action(new RegExp(`^${HOME_ACTION_PREFIX}`), async ({ ack, body, action, client, logger }) => {
            await ack();
            await this.handleClick(client, body, action, logger, true);
        });
        this.appHome.addSection((client, userId) => this.renderHomeSection(client, userId));
    }

    private async isAllowed(client: WebClient, userId: string): Promise<boolean> {
        if (this.allowed === 'everyone') return true;
        const res = await client.users.info({ user: userId });
        return !!(res.user?.is_admin || res.user?.is_owner || res.user?.is_primary_owner);
    }

    /** Tell the clicker something privately: ephemeral where they clicked, else a DM. */
    private async tell(client: WebClient, userId: string, channel: string | undefined, text: string) {
        try {
            if (channel) {
                await client.chat.postEphemeral({ channel, user: userId, text });
            } else {
                await client.chat.postMessage({ channel: userId, text });
            }
        } catch (err) {
            console.error('Failed to notify the user about a Drive recheck', err);
        }
    }

    private async handleClick(client: WebClient, body: any, action: any, logger: Logger, fromHome: boolean) {
        const userId: string = body.user.id;
        const clickChannel: string | undefined = body.channel?.id ?? body.container?.channel_id;
        const report = decodeRecheckValue(action?.value);
        try {
            if (!report) {
                await this.tell(client, userId, clickChannel, '無法辨識這份報告，請重新整理後再試。');
                return;
            }
            if (!(await this.isAllowed(client, userId))) {
                await this.tell(client, userId, clickChannel, '只有工作區管理員可以重新檢查。');
                return;
            }
            const message = await this.recheck(client, report.channel, report.ts, userId, logger);
            if (message) await this.tell(client, userId, clickChannel, message);
        } catch (err) {
            logger.error('Drive recheck failed unexpectedly', err);
            await this.tell(client, userId, clickChannel, '重新檢查時發生未預期的錯誤，請稍後再試。');
        } finally {
            if (fromHome) {
                try {
                    await this.appHome.publish(client, userId);
                } catch (err) {
                    logger.error('Failed to refresh the App Home after a Drive recheck', err);
                }
            }
        }
    }

    /**
     * Rechecks every file of one report. Returns a message for the clicker when the recheck
     * could not run (locked, report gone), undefined otherwise.
     */
    private async recheck(client: WebClient, channel: string, ts: string, userId: string, logger: Logger): Promise<string | undefined> {
        const reportFilter = { channel, thread_ts: ts, auditMessage: { $exists: true } };
        const token = randomUUID();
        const now = new Date();
        const locked = await this.jobCollection.updateMany(
            {
                ...reportFilter,
                $or: [
                    { recheckingAt: { $exists: false } },
                    { recheckingAt: null },
                    { recheckingAt: { $lt: new Date(now.getTime() - LOCK_TTL_MS) } },
                ],
            },
            { $set: { recheckingAt: now, recheckingToken: token } },
        );
        if (locked.modifiedCount === 0) {
            const exists = await this.jobCollection.countDocuments(reportFilter);
            return exists === 0 ? '找不到這份報告的紀錄。' : '這份報告正在重新檢查中，請稍候再試。';
        }

        try {
            const jobs = await this.jobCollection.find({ ...reportFilter, recheckingToken: token }).sort({ _id: 1 }).toArray();
            const audit = jobs[0]?.auditMessage as { channel: string; ts: string } | undefined;
            if (!audit) return '找不到這份報告的稽核訊息。';
            const recheckValue = encodeRecheckValue(channel, ts);
            const previousOverall = overallStatus(jobs.flatMap(j => (j.result ? [j.result as ComplianceResult] : [])));
            const gone = '原本的稽核訊息已不存在，無法重新檢查。';

            try {
                await setStatusReaction(client, audit.channel, audit.ts, CHECKING_REACTION);
            } catch (err) {
                if (isMessageGoneError(err)) return gone;
                throw err;
            }

            let restoreReaction = reactionForStatus(previousOverall);
            try {
                const results = await Promise.all(
                    jobs.map(j => checkDriveCompliance(j.fileId, j.url, this.driveClient, this.checkerOptions, logger)),
                );
                const checkedAt = new Date();
                await Promise.all(jobs.map((job, i) => {
                    const { $set, $unset, $push } = computeJobUpdate(job as JobState, results[i], userId, checkedAt);
                    return this.jobCollection.updateOne(
                        { _id: job._id },
                        { $set, ...($unset ? { $unset } : {}), $push } as any,
                    );
                }));
                restoreReaction = reactionForStatus(overallStatus(results));

                await client.chat.postMessage({
                    channel: audit.channel,
                    thread_ts: audit.ts,
                    reply_broadcast: false,
                    blocks: buildRecheckReplyBlocks(
                        results.map((result, i) => ({ result, previous: jobs[i].result as ComplianceResult | undefined })),
                        { triggeredBy: userId, checkedAt, recheckValue },
                    ),
                    text: 'Google Drive 重新檢查結果',
                });
            } catch (err) {
                if (isMessageGoneError(err)) return gone;
                logger.error('Drive recheck failed', err);
                try {
                    await client.chat.postMessage({
                        channel: audit.channel,
                        thread_ts: audit.ts,
                        reply_broadcast: false,
                        blocks: buildRecheckFailedBlocks({ triggeredBy: userId, checkedAt: new Date(), recheckValue }),
                        text: 'Google Drive 重新檢查失敗',
                    });
                } catch (replyErr) {
                    if (isMessageGoneError(replyErr)) return gone;
                    logger.error('Failed to post the Drive recheck failure notice', replyErr);
                }
            } finally {
                try {
                    await setStatusReaction(client, audit.channel, audit.ts, restoreReaction);
                } catch (err) {
                    if (!isMessageGoneError(err)) logger.error('Failed to restore the audit status reaction', err);
                }
            }
            return undefined;
        } finally {
            await this.jobCollection.updateMany(
                { channel, thread_ts: ts, recheckingToken: token },
                { $unset: { recheckingAt: '', recheckingToken: '' } },
            );
        }
    }

    private async permalink(client: WebClient, channel: string, ts: string): Promise<string | undefined> {
        const key = `${channel}:${ts}`;
        if (this.permalinks.has(key)) return this.permalinks.get(key);
        let link: string | undefined;
        try {
            link = (await client.chat.getPermalink({ channel, message_ts: ts })).permalink;
        } catch {
            link = undefined;
        }
        this.permalinks.set(key, link);
        return link;
    }

    /** App Home overview of files whose latest check is not compliant. */
    async renderHomeSection(client: WebClient, userId: string): Promise<KnownBlock[]> {
        if (!(await this.isAllowed(client, userId))) return [];

        const filter = { auditMessage: { $exists: true }, 'result.status': { $ne: 'compliant' } };
        const [jobs, total] = await Promise.all([
            this.jobCollection.find(filter).sort({ _id: -1 }).limit(HOME_MAX_ROWS).toArray(),
            this.jobCollection.countDocuments(filter),
        ]);

        const blocks: KnownBlock[] = [
            { type: 'divider' },
            { type: 'section', text: { type: 'mrkdwn', text: '*Google Drive 未合規項目*\n最新一次檢查結果不是「合規」的檔案。' } },
        ];
        if (jobs.length === 0) {
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '目前沒有未合規的項目。' }] });
            return blocks;
        }

        const links = await Promise.all(jobs.map(j => this.permalink(client, j.auditMessage.channel, j.auditMessage.ts)));
        jobs.forEach((job, i) => {
            const result = job.result as ComplianceResult | undefined;
            const status = result?.status ?? 'cannot_check';
            const lines = [
                `${STATUS_EMOJI[status]} *${fileLink({ url: result?.url ?? job.url, fileName: result?.fileName })}* · ${STATUS_LABEL[status]}`,
                `來源 <#${job.channel}>${job.user ? ` · <@${job.user}>` : ''}` +
                    `${links[i] ? ` · <${links[i]}|稽核訊息>` : ''}`,
                `最後檢查 ${slackDate(job.lastCheckedAt instanceof Date ? job.lastCheckedAt : (job.completedAt ?? job.requestedAt))}`,
            ];
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: lines.join('\n') },
                accessory: recheckButton(encodeRecheckValue(job.channel, job.thread_ts), `${HOME_ACTION_PREFIX}:${i}`),
            });
        });
        if (total > jobs.length) {
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…還有 ${total - jobs.length} 筆未顯示。` }] });
        }
        return blocks;
    }
}
