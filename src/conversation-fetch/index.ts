import { WebClient } from "@slack/web-api";
import { FileElement, MessageElement as HistMessageElement } from "@slack/web-api/dist/response/ConversationsHistoryResponse";
import { MessageElement as ReplMessageElement } from "@slack/web-api/dist/response/ConversationsRepliesResponse";

import Bull, { Job, JobId, KeepJobsOptions, Queue, RateLimiter } from "bull";
import { createHash } from "crypto";
import { createBullBoard } from "@bull-board/api";
import { BullAdapter } from "@bull-board/api/bullAdapter"
import { ExpressAdapter } from "@bull-board/express";

import { getFileArrayBufFromSlack } from "../utils/slack";
import { nanoid } from "nanoid";

interface WorkQueueTask {
    type: string;
}

export interface FetchChannelTask extends WorkQueueTask {
    type: 'chan';
    channelId: string;
    before?: string;
    after?: string;
}

export interface FetchHistoryTask extends WorkQueueTask {
    type: 'hist';
    channelId: string;
    cursor?: string;
    before?: string;
    after?: string;
}

export interface FetchHistoryResult {
    messages: HistMessageElement[];
    nextCursor?: string;
}

export interface FetchRepliesTask extends WorkQueueTask {
    type: 'repl';
    channelId: string;
    ts: string;
    cursor?: string;
}

export interface FetchRepliesResult {
    messages: ReplMessageElement[];
    nextCursor?: string;
}

export interface FetchFileTask extends WorkQueueTask {
    type: 'file';
    url_private_download: string;
    meta: FileElement;
}

export interface FetchFileResult {
    buf?: ArrayBuffer;
}

export class SlackAPIError extends Error {
    constructor(
        public code: string,
    ) {
        super(`Slack API error: ${code}`);
    }
}

const slackTier3: RateLimiter = {
    max: 50,
    duration: 60 * 1000,
    bounceBack: true,
}

const keepJobsOpt: KeepJobsOptions = {
    // in seconds
    age: 5 * 24 * 60 * 60,
}

export class ConversationFetchService {
    constructor(
        private webAPI: WebClient,
        redisUrl: string,
        serverAdapter?: ExpressAdapter,
    ) {
        this.channelQueue = new Bull('fetch-channel-queue', redisUrl);

        this.histQueue = new Bull('fetch-history-queue', redisUrl, {
            limiter: slackTier3,
        });

        this.replQueue = new Bull('fetch-reply-queue', redisUrl, {
            limiter: slackTier3,
        });

        this.fileQueue = new Bull('file-queue', redisUrl);

        this.channelQueue.process(3, this.processFetchChannel.bind(this));
        this.histQueue.process('*', (job) => this.processFetchHistory(job.data));
        this.replQueue.process('*', (job) => this.processFetchReplies(job.data));
        this.fileQueue.process('*', 3, (job) => this.processFetchFile(job.data));

        if (serverAdapter) {
            createBullBoard({
                queues: [
                    new BullAdapter(this.channelQueue),
                    new BullAdapter(this.histQueue),
                    new BullAdapter(this.replQueue),
                    new BullAdapter(this.fileQueue)
                ],
                serverAdapter,
            });
        }
    }

    private channelQueue: Queue<FetchChannelTask>;
    private histQueue: Queue<FetchHistoryTask>;
    private replQueue: Queue<FetchRepliesTask>;
    private fileQueue: Queue<FetchFileTask>;

    fetchChannel(channelId: string, before?: string, after?: string) {
        return this.channelQueue.add(
            { type: 'chan', channelId, before, after },
            { removeOnComplete: keepJobsOpt, jobId: `chan_${channelId}_${nanoid(5)}` }
        );
    }

    fetchHistory(channelId: string, cursor?: string, before?: string, after?: string): Promise<FetchHistoryResult> {
        const jobId = cursor ? `hist_${channelId}_${cursor}` : undefined;

        return this.histQueue.add(
            { type: 'hist', channelId, cursor, before, after },
            { removeOnComplete: keepJobsOpt, jobId }
        ).then(ConversationFetchService.convertToResultPromise<FetchHistoryTask, FetchHistoryResult>);
    }

    fetchReplies(channelId: string, ts: string, cursor?: string): Promise<FetchRepliesResult> {
        const jobId = cursor ? `repl_${channelId}_${ts}_${cursor}` : undefined;

        return this.replQueue.add(
            { type: 'repl', channelId, ts, cursor },
            { removeOnComplete: keepJobsOpt, jobId }
        ).then(ConversationFetchService.convertToResultPromise<FetchRepliesTask, FetchRepliesResult>);
    }

    fetchFile(url: string, meta: FileElement): Promise<FetchFileResult> {
        const urlHash = createHash('sha256').update(url).digest('hex');

        return this.fileQueue.add(
            { type: 'file', url_private_download: url, meta },
            { removeOnComplete: keepJobsOpt, jobId: urlHash }
        ).then(ConversationFetchService.convertToResultPromise<FetchFileTask, FetchFileResult>);
    }

    onFetchHistoryComplete(handler: (job: Job<FetchHistoryTask>, result: FetchHistoryResult) => void) {
        this.histQueue.on('completed', handler);
    }

    onFetchRepliesComplete(handler: (job: Job<FetchRepliesTask>, result: FetchRepliesResult) => void) {
        this.replQueue.on('completed', handler);
    }

    onFetchFileComplete(handler: (job: Job<FetchFileTask>, result: FetchFileResult) => void) {
        this.fileQueue.on('completed', handler);
    }

    private static async convertToResultPromise<T, R>(job: Job<T>): Promise<R> {
        return new Promise(async (resolve) => {
            const listener = (_job: Job<T>, result: R) => {
                if (job.id === _job.id) {
                    job.queue.off('completed', listener);

                    resolve(result);
                }
            }

            job.queue.on('completed', listener);
        });
    }

    private processFetchChannel(fetchChannelJob: Job<FetchChannelTask>): Promise<void> {
        return new Promise((resolve) => {
            const task = fetchChannelJob.data;

            const { channelId, before, after } = task;
            const jobName = typeof fetchChannelJob.id === 'string' ? fetchChannelJob.id : `chan_${channelId}_${nanoid(5)}`;

            const jobs: Set<JobId> = new Set();
            const finishedJobIds: Set<JobId> = new Set();

            const updateProgress = () => {
                const progress = Math.round((finishedJobIds.size / jobs.size) * 100);

                fetchChannelJob.progress(progress);

                if (finishedJobIds.size === jobs.size && finishedJobIds.size > 0) {
                    fetchChannelJob.log('All jobs done');
                    resolve();
                } else {
                    // jobs.forEach((v) => {
                    //     if (!finishedJobIds.has(v)) {
                    //         console.log(`Job ${v} not finished`);
                    //     }
                    // });

                    setTimeout(updateProgress, 1000);
                }
            }
            updateProgress();

            const enqueueHist = async (cursor?: string) => {
                const jobId = cursor ? `hist_${channelId}_${cursor}` : undefined;

                const job = await this.histQueue.add(jobName,
                    { type: 'hist', channelId, cursor, before, after },
                    { removeOnComplete: keepJobsOpt, jobId }
                )

                jobs.add(job.id);
            };

            const enqueueRepl = async (ts: string, cursor?: string) => {
                const jobId = cursor ? `repl_${channelId}_${ts}_${cursor}` : undefined;

                const job = await this.replQueue.add(jobName,
                    { type: 'repl', channelId, ts, cursor },
                    { removeOnComplete: keepJobsOpt, jobId }
                )

                jobs.add(job.id);
            };

            const enqueueFile = async (url: string, meta: FileElement) => {
                const urlHash = createHash('sha256').update(url).digest('hex');

                const job = await this.fileQueue.add(jobName,
                    { type: 'file', url_private_download: url, meta },
                    { removeOnComplete: keepJobsOpt, jobId: urlHash }
                )

                jobs.add(job.id);
            };

            const handleHistDone = async (job: Job<FetchHistoryTask>, result: FetchHistoryResult) => {
                if (job.name != jobName) return;

                if (result.nextCursor) {
                    await enqueueHist(result.nextCursor);
                }

                await Promise.all(result.messages.map(async (v) => {
                    if (v.reply_count && v.reply_count > 0 && v.ts) {
                        await enqueueRepl(v.ts);
                    }

                    if (v.files) {
                        await Promise.all(v.files.map(async (f) => {
                            if (f.url_private_download)
                                await enqueueFile(f.url_private_download, f);
                        }));
                    }
                }));

                finishedJobIds.add(job.id);
                fetchChannelJob.log(`Hist done: ${job.id}`);
            }

            const handleReplDone = async (job: Job<FetchRepliesTask>, result: FetchRepliesResult) => {
                if (job.name != jobName) return;

                if (result.nextCursor) {
                    await enqueueRepl(job.data.ts, result.nextCursor);
                }

                await Promise.all(result.messages.map(async (v) => {
                    if (v.files) {
                        await Promise.all(v.files.map(async (f) => {
                            if (f.url_private_download) {
                                await enqueueFile(f.url_private_download, f);
                            }
                        }));
                    }
                }));

                finishedJobIds.add(job.id);
                fetchChannelJob.log(`Replies done: ${job.id}`);
            }

            const handleFileDone = (job: Job<FetchFileTask>, result: FetchFileResult) => {
                if (job.name != jobName) return;

                finishedJobIds.add(job.id);
                fetchChannelJob.log(`File done: ${job.id}`);
            }

            this.histQueue.on('completed', handleHistDone);
            this.replQueue.on('completed', handleReplDone);
            this.fileQueue.on('completed', handleFileDone);

            // Start the process
            enqueueHist();
        });
    }

    private async processFetchHistory(task: FetchHistoryTask): Promise<FetchHistoryResult> {
        const { channelId, cursor, before, after } = task;

        const result = await this.webAPI.conversations.history({
            channel: channelId,
            include_all_metadata: true,
            limit: 999,
            cursor,
            latest: before,
            oldest: after,
        });

        if (result.ok) {
            const nextCursor = result.response_metadata?.next_cursor;

            return {
                messages: result.messages ?? [],
                nextCursor,
            }
        } else {
            throw new SlackAPIError(result.error ?? "unknown");
        }
    }

    private async processFetchReplies(task: FetchRepliesTask): Promise<FetchRepliesResult> {
        const { channelId, ts, cursor } = task;

        const result = await this.webAPI.conversations.replies({
            channel: channelId,
            ts,
            cursor,
        });

        if (result.ok) {
            const nextCursor = result.response_metadata?.next_cursor;

            return {
                messages: result.messages ?? [],
                nextCursor,
            }
        } else {
            throw new SlackAPIError(result.error ?? "unknown");
        }
    }

    private async processFetchFile(task: FetchFileTask): Promise<FetchFileResult> {
        const { url_private_download: url } = task;

        return {
            buf: await getFileArrayBufFromSlack(url, this.webAPI.token),
        };
    }
}
