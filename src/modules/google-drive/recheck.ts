import { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';
import { acquireReportLock, releaseReportLock } from './lock';
import { setStatusReaction } from './slack';
import { randomUUID } from 'node:crypto';
import { drive_v3 } from 'googleapis';
import { Collection } from 'mongodb';
import { AppHomeModule } from '../app-home';
import { ObjectId } from 'mongodb';
import { markJobHandled } from './store';
import { checkDriveCompliance } from './checker';
import {
    CHECKING_REACTION,
    markSurvivesRecheck,
    OPEN_JOB_FILTER,
    overallStatusOfJobs,
    runRecheckStep,
    isMessageGoneError,
    JobState,
    OverallStatus,
    RecheckJob,
    reactionForStatus,
    shouldApplyReaction,
} from './recheck-core';
import {
    buildRecheckFailedBlocks,
    buildRecheckReplyBlocks,
    decodeRecheckValue,
    MARK_HANDLED_ACTION_PREFIX,
    encodeRecheckValue,
    escapeMrkdwn,
    fileLink,
    RECHECK_ACTION_ID,
    slackDate,
    STATUS_EMOJI,
    STATUS_LABEL,
} from './report';
import type { ComplianceCheckerOptions, ComplianceResult } from './types';

import type { RecheckAllowed } from '../../config';

const HOME_MENU_PREFIX = 'drive_home_menu';
const HANDLED_MODAL = 'drive_mark_handled_modal';
const NOTE_BLOCK = 'note_block';
const NOTE_ACTION = 'note';
const NOTE_MAX = 500;
const PERMALINK_CACHE_MAX = 200;
const HOME_MAX_ROWS = 20; // one block per row keeps the home well under Slack's 100-block limit

type Logger = { error: (msg: string, ...args: any[]) => void; debug?: (msg: string, ...args: any[]) => void };

/** Rechecks audit reports on demand, from the audit message's button or from the App Home overview. */
export class GoogleDriveRecheckModule {
    private permalinks = new Map<string, string>();

    constructor(
        private app: App,
        private appHome: AppHomeModule,
        private driveClient: drive_v3.Drive,
        private jobCollection: Collection,
        private checkerOptions: ComplianceCheckerOptions,
        private allowed: RecheckAllowed,
    ) {}

    async init() {
        this.app.action(RECHECK_ACTION_ID, async ({ ack, body, action, client, logger }) => {
            await ack();
            await this.handleClick(client, body, action, logger, false);
        });
        this.app.action(new RegExp(`^${HOME_MENU_PREFIX}`), async ({ ack, body, action, client, logger }) => {
            await ack();
            const value: string = (action as any).selected_option?.value ?? '';
            const [kind, ...rest] = value.split('|');
            if (kind === 'recheck') {
                await this.handleClick(client, body, { value: rest.join('|') }, logger, true);
            } else if (kind === 'handled') {
                await this.openHandledModal(client, body, rest.join('|'), true, logger);
            }
        });
        this.app.action(new RegExp(`^${MARK_HANDLED_ACTION_PREFIX}:`), async ({ ack, body, action, client, logger }) => {
            await ack();
            await this.openHandledModal(client, body, (action as any).value ?? '', false, logger);
        });
        this.app.view(HANDLED_MODAL, async ({ ack, body, view, client, logger }) => {
            const userId = body.user.id;
            const meta = JSON.parse(view.private_metadata) as { jobId: string; home: boolean; channel?: string };
            const note = (view.state.values[NOTE_BLOCK]?.[NOTE_ACTION]?.value ?? '').trim();
            if (!note) {
                await ack({ response_action: 'errors', errors: { [NOTE_BLOCK]: '請填寫處理說明。' } });
                return;
            }
            await ack();
            try {
                // The authoritative permission check; slower than Slack's 3 s ack window, so it follows the ack.
                if (!(await this.isAllowed(client, userId))) {
                    await this.tell(client, userId, meta.channel, `只有${this.allowedWho()}可以標記已處理。`);
                    return;
                }
                const message = await this.markHandled(client, meta.jobId, userId, note, logger);
                if (message) await this.tell(client, userId, meta.channel, message);
            } catch (err) {
                logger.error('Drive mark-handled failed', err);
                await this.tell(client, userId, meta.channel, '標記已處理時發生未預期的錯誤，請稍後再試。');
            } finally {
                if (meta.home) {
                    try {
                        await this.appHome.publish(client, userId);
                    } catch (err) {
                        logger.error('Failed to refresh the App Home after marking handled', err);
                    }
                }
            }
        });
        this.appHome.addSection((client, userId) => this.renderHomeSection(client, userId));
    }

    private async isAllowed(client: WebClient, userId: string): Promise<boolean> {
        if (this.allowed === 'everyone') return true;
        const res = await client.users.info({ user: userId });
        const owner = !!(res.user?.is_owner || res.user?.is_primary_owner);
        return this.allowed === 'owners' ? owner : owner || !!res.user?.is_admin;
    }

    /** Who may act, for the denial message. */
    private allowedWho(): string {
        return this.allowed === 'owners' ? '工作區擁有者' : '工作區管理員';
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
                await this.tell(client, userId, clickChannel, `只有${this.allowedWho()}可以重新檢查。`);
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

    private async openHandledModal(client: WebClient, body: any, jobId: string, home: boolean, logger: Logger) {
        const userId: string = body.user.id;
        const channel: string | undefined = body.channel?.id ?? body.container?.channel_id;
        try {
            // Permission and lookup run concurrently so views.open still lands inside the trigger_id
            // window; both are checked again on submit.
            const [allowed, job] = await Promise.all([
                this.isAllowed(client, userId),
                ObjectId.isValid(jobId) ? this.jobCollection.findOne({ _id: new ObjectId(jobId) }) : null,
            ]);
            if (!allowed) {
                await this.tell(client, userId, channel, `只有${this.allowedWho()}可以標記已處理。`);
                return;
            }
            if (!job) {
                await this.tell(client, userId, channel, '找不到這個項目的紀錄。');
                return;
            }
            if (job.manualResolution) {
                await this.tell(client, userId, channel, '這個項目已經被標記為已處理。');
                return;
            }
            await client.views.open({
                trigger_id: body.trigger_id,
                view: {
                    type: 'modal',
                    callback_id: HANDLED_MODAL,
                    private_metadata: JSON.stringify({ jobId, home, channel }),
                    title: { type: 'plain_text', text: '標記已處理' },
                    submit: { type: 'plain_text', text: '標記' },
                    close: { type: 'plain_text', text: '取消' },
                    blocks: [
                        {
                            type: 'section',
                            text: { type: 'mrkdwn', text: `將 *${fileLink({ url: job.url, fileName: job.result?.fileName })}* 標記為已處理。檢查結果不會被更動；之後重新檢查若再發現違規，標記會自動清除。` },
                        },
                        {
                            type: 'input',
                            block_id: NOTE_BLOCK,
                            label: { type: 'plain_text', text: '處理說明' },
                            element: { type: 'plain_text_input', action_id: NOTE_ACTION, multiline: true, max_length: NOTE_MAX },
                        },
                    ],
                },
            });
        } catch (err) {
            logger.error('Failed to open the mark-handled modal', err);
            await this.tell(client, userId, channel, '無法開啟標記視窗，請稍後再試。');
        }
    }

    /** Saves the manual resolution and announces it in the audit thread. Returns a message for the user when something needs saying. */
    private async markHandled(client: WebClient, jobId: string, userId: string, note: string, logger: Logger): Promise<string | undefined> {
        if (!ObjectId.isValid(jobId)) return '找不到這個項目的紀錄。';
        const { outcome, job } = await markJobHandled(this.jobCollection, new ObjectId(jobId), userId, new Date(), note);
        if (outcome === 'not_found' || !job) return '找不到這個項目的紀錄。';
        if (outcome === 'already_handled') return '這個項目已經被標記為已處理。';
        if (outcome === 'compliant') return '這個項目目前已合規，不需要標記。';
        if (outcome === 'no_result') return '這個項目還沒有檢查結果，無法標記。';

        const audit = job.auditMessage as { channel: string; ts: string } | undefined;
        if (!audit) return '已儲存，但找不到稽核訊息。';
        const gone = '已儲存處理標記，但原本的稽核訊息已不存在，無法在其中回覆。';
        try {
            await client.chat.postMessage({
                channel: audit.channel,
                thread_ts: audit.ts,
                reply_broadcast: false,
                text: `✔️ <@${userId}> 將 ${fileLink({ url: job.url, fileName: job.result?.fileName })} 標記為已處理：${escapeMrkdwn(note)}`,
            });
        } catch (err) {
            if (isMessageGoneError(err)) return gone;
            logger.error('Failed to post the mark-handled reply', err);
        }
        try {
            const siblings = await this.jobCollection
                .find({ channel: job.channel, thread_ts: job.thread_ts, auditMessage: { $exists: true } }).toArray();
            // Always set it, even while a recheck runs: the recheck re-syncs after releasing its lock,
            // so whichever finishes last leaves the reaction matching the stored state.
            await setStatusReaction(client, audit.channel, audit.ts, reactionForStatus(overallStatusOfJobs(siblings as unknown as JobState[])));
        } catch (err) {
            if (isMessageGoneError(err)) return gone;
            logger.error('Failed to update the status reaction after marking handled', err);
        }
        return undefined;
    }

    /**
     * Rechecks every file of one report. Returns a message for the clicker when the recheck
     * could not run (locked, report gone), undefined otherwise.
     */
    private async recheck(client: WebClient, channel: string, ts: string, userId: string, logger: Logger): Promise<string | undefined> {
        const reportFilter = { channel, thread_ts: ts, auditMessage: { $exists: true } };
        const token = randomUUID();
        const lock = await acquireReportLock(this.jobCollection, reportFilter, token);
        if (lock === 'missing') return '找不到這份報告的紀錄。';
        if (lock === 'busy') return '這份報告正在重新檢查中，請稍候再試。';

        let syncAudit: { channel: string; ts: string } | undefined;
        let applied: OverallStatus | undefined; // the status the first sync put on the message
        try {
            const jobs = await this.jobCollection.find({ ...reportFilter, recheckingToken: token }).sort({ _id: 1 }).toArray();
            const audit = jobs[0]?.auditMessage as { channel: string; ts: string } | undefined;
            if (!audit) return '找不到這份報告的稽核訊息。';
            syncAudit = audit;
            const recheckValue = encodeRecheckValue(channel, ts);
            const previousOverall = overallStatusOfJobs(jobs as unknown as JobState[]);
            const gone = '原本的稽核訊息已不存在，無法重新檢查。';

            try {
                await setStatusReaction(client, audit.channel, audit.ts, CHECKING_REACTION);
            } catch (err) {
                if (isMessageGoneError(err)) return gone;
                throw err;
            }

            try {
                const checkedAt = new Date();
                const step = await runRecheckStep(
                    jobs as unknown as RecheckJob[],
                    j => checkDriveCompliance(j.fileId, j.url, this.driveClient, this.checkerOptions, logger),
                    userId,
                    checkedAt,
                );
                const { results } = step;
                // Take each job's manualResolution as it was just before the update, so a mark made
                // after the snapshot is still reported when this recheck clears it.
                const hadMark = await Promise.all(jobs.map(async (job, i) => {
                    const { $set, $unset, $push } = step.updates[i];
                    const res: any = await this.jobCollection.findOneAndUpdate(
                        { _id: job._id },
                        { ...($set ? { $set } : {}), ...($unset ? { $unset } : {}), $push } as any,
                        { returnDocument: 'before' },
                    );
                    const before = res && 'value' in res ? res.value : res;
                    return !!before?.manualResolution;
                }));

                await client.chat.postMessage({
                    channel: audit.channel,
                    thread_ts: audit.ts,
                    reply_broadcast: false,
                    blocks: buildRecheckReplyBlocks(
                        results.map((result, i) => ({
                            result,
                            previous: jobs[i].result as ComplianceResult | undefined,
                            jobId: String(jobs[i]._id),
                            hadManualResolution: hadMark[i],
                            handled: markSurvivesRecheck(hadMark[i], result),
                        })),
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
                applied = await this.syncReaction(client, audit, reportFilter, previousOverall, undefined, logger);
            }
            return undefined;
        } finally {
            await releaseReportLock(this.jobCollection, reportFilter, token);
            // A mark committed after the sync above but before the lock was released is only seen now.
            if (syncAudit) await this.syncReaction(client, syncAudit, reportFilter, undefined, applied, logger);
        }
    }

    /**
     * Sets the audit message's status reaction from the report's stored state, read fresh. Skips the
     * reaction calls when that state is the one already `applied`. Returns the status now on the
     * message, or `applied` unchanged when nothing was set.
     */
    private async syncReaction(
        client: WebClient,
        audit: { channel: string; ts: string },
        reportFilter: Record<string, unknown>,
        fallback: OverallStatus | undefined,
        applied: OverallStatus | undefined,
        logger: Logger,
    ): Promise<OverallStatus | undefined> {
        try {
            let overall = fallback;
            try {
                overall = overallStatusOfJobs(await this.jobCollection.find(reportFilter).toArray() as unknown as JobState[]);
            } catch (err) {
                logger.error('Failed to re-read the report for its status reaction', err);
            }
            if (!shouldApplyReaction(applied, overall)) return applied;
            await setStatusReaction(client, audit.channel, audit.ts, reactionForStatus(overall!));
            return overall;
        } catch (err) {
            if (!isMessageGoneError(err)) logger.error('Failed to set the audit status reaction', err);
            return applied;
        }
    }

    private async permalink(client: WebClient, channel: string, ts: string): Promise<string | undefined> {
        const key = `${channel}:${ts}`;
        const cached = this.permalinks.get(key);
        if (cached) return cached;
        try {
            const link = (await client.chat.getPermalink({ channel, message_ts: ts })).permalink;
            if (link) {
                if (this.permalinks.size >= PERMALINK_CACHE_MAX) this.permalinks.clear();
                this.permalinks.set(key, link);
            }
            return link;
        } catch {
            return undefined; // failures are not cached
        }
    }

    /** App Home overview of files whose latest check is not compliant. */
    async renderHomeSection(client: WebClient, userId: string): Promise<KnownBlock[]> {
        if (!(await this.isAllowed(client, userId))) return [];

        const filter = { auditMessage: { $exists: true }, ...OPEN_JOB_FILTER };
        const [jobs, total] = await Promise.all([
            this.jobCollection.find(filter).sort({ _id: -1 }).limit(HOME_MAX_ROWS).toArray(),
            this.jobCollection.countDocuments(filter),
        ]);

        const blocks: KnownBlock[] = [
            { type: 'divider' },
            { type: 'section', text: { type: 'mrkdwn', text: '*Google Drive 未合規項目*\n最新一次檢查結果不是「合規」、且尚未標記為已處理的檔案。' } },
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
                accessory: {
                    type: 'overflow',
                    action_id: `${HOME_MENU_PREFIX}:${i}`,
                    options: [
                        { text: { type: 'plain_text', text: '🔄 重新檢查', emoji: true }, value: `recheck|${encodeRecheckValue(job.channel, job.thread_ts)}` },
                        { text: { type: 'plain_text', text: '✔️ 標記已處理', emoji: true }, value: `handled|${String(job._id)}` },
                    ],
                },
            });
        });
        if (total > jobs.length) {
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…還有 ${total - jobs.length} 筆未顯示。` }] });
        }
        return blocks;
    }
}
