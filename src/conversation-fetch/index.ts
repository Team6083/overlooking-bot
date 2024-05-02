import { WebClient } from "@slack/web-api";
import { FileElement } from "@slack/web-api/dist/response/ConversationsHistoryResponse";
import { nanoid } from "nanoid";

import {
    FetchHistoryTask, FetchHistoryResult,
    FetchRepliesTask, FetchRepliesResult,
    FetchFileTask, FetchFileResult,
    WorkQueueTask,
} from "./types";
import { RateLimiter } from "../utils/rate-limiter";
import { fetchFile, fetchHistory, fetchReplies } from "./fetch-functions";
import { SlackStorageRepository } from "../message-repository";
import { writeFileSync } from "fs";

const slackTier3 = {
    max: 50,
    duration: 60 * 1000,
}

export type OnCompleteEventHandlers<T, R> = (task: T, result: R) => void;

type EventSubjects = 'hist' | 'repl' | 'file';
type EventNames = 'enqueue' | 'completed';

type FetchChannelOptions = {
    before?: string;
    after?: string;
    downloadFiles?: boolean;
}

export class ConversationFetchService {
    constructor(
        private webAPI: WebClient,
        private repo: SlackStorageRepository,
        private log: (...args: any[]) => void = console.log,
        private warn: (...args: any[]) => void = console.warn,
        private error: (...args: any[]) => void = console.error,
    ) {
        this.on('hist', 'completed', this.saveFetchHistoryResult.bind(this));
        this.on('repl', 'completed', this.saveFetchRepliesResult.bind(this));
        this.on('file', 'completed', this.saveFetchFileResult.bind(this));

        this.on('hist', 'enqueue', this.onEnqueueTask.bind(this));
        this.on('repl', 'enqueue', this.onEnqueueTask.bind(this));
        this.on('file', 'enqueue', this.onEnqueueTask.bind(this));
    }

    private histQueue = new RateLimiter(slackTier3.max, slackTier3.duration);
    private replQueue = new RateLimiter(slackTier3.max, slackTier3.duration);
    private fileQueue = new RateLimiter(10, 30);

    getQueueStats() {
        return {
            hist: {
                active: this.histQueue.getRunningCount(),
                waiting: this.histQueue.getQueueLength(),
            },
            repl: {
                active: this.replQueue.getRunningCount(),
                waiting: this.replQueue.getQueueLength(),
            },
            file: {
                active: this.fileQueue.getRunningCount(),
                waiting: this.fileQueue.getQueueLength(),
            },
        }
    }

    fetchChannel(channelId: string, opts?: FetchChannelOptions): Promise<void> {
        const { before, after, downloadFiles } = opts ?? {};

        return new Promise((resolve, reject) => {
            const rootEventId = nanoid(5);

            const getRelatedTasks = () => {
                return this.tasks.filter((v) => v.corelationId === rootEventId);
            };

            const completedTaskIds: {
                id: string;
                completedAt: Date;
            }[] = [];

            const updateStatus = (task: WorkQueueTask) => {
                this.log(`[${channelId}] Done: ${ConversationFetchService.taskToString(task)}`);

                completedTaskIds.push({
                    id: task.id,
                    completedAt: new Date(),
                });

                const relatedTasks = getRelatedTasks();
                const remainingTasks = relatedTasks.filter((v) => completedTaskIds.findIndex((c) => c.id === v.id) === -1);
                const completedTasks = relatedTasks.filter((v) => completedTaskIds.findIndex((c) => c.id === v.id) !== -1);

                writeFileSync(`./job_updates/${channelId}_${rootEventId}.json`, JSON.stringify({
                    completed: completedTasks,
                    remaining: remainingTasks,
                    completedTaskIds,
                }));

                {
                    const { hist, repl, file } = this.getQueueStats();
                    console.log(`Queue stats: ${hist.waiting} / ${repl.waiting} / ${file.waiting}`);
                }

                if (remainingTasks.length === 0) {
                    this.log("Done!");

                    this.off('hist', 'completed', handleHistDone);
                    this.off('repl', 'completed', handleReplDone);
                    this.off('file', 'completed', handleFileDone);

                    resolve();
                }
            }

            const handleHistDone = async (task: FetchHistoryTask, result: FetchHistoryResult) => {
                if (task.corelationId !== rootEventId) return;

                const eventIds = {
                    corelationId: rootEventId,
                    causationId: task.id
                };

                if (result.nextCursor) {
                    this.enqueueHist({
                        id: nanoid(5),
                        ...eventIds,
                        type: 'hist',
                        channelId,
                        cursor: result.nextCursor,
                        before,
                        after,
                    }).catch(reject);;
                }

                result.messages.forEach((v) => {
                    if (v.reply_count && v.reply_count > 0 && v.ts) {
                        this.enqueueRepl({
                            id: nanoid(5),
                            ...eventIds,
                            type: 'repl',
                            channelId,
                            ts: v.ts,
                        }).catch(reject);;
                    }

                    if (v.files && downloadFiles) {
                        v.files.forEach(async (f) => {
                            if (f.url_private_download && (typeof f.id !== 'string' || !this.repo.hasFileSync(f as any))) {
                                this.enqueueFile({
                                    id: nanoid(5),
                                    ...eventIds,
                                    type: 'file',
                                    url_private_download: f.url_private_download,
                                    meta: f,
                                }).catch(reject);;
                            }
                        });
                    }
                });

                const sortedTS = result.messages.map((v) => parseFloat(v.ts ?? '0')).sort();
                console.log(`[${channelId}] Hist: ${new Date(sortedTS[0] * 1000).toLocaleString()} - ${new Date(sortedTS[sortedTS.length - 1] * 1000).toLocaleString()}`);

                updateStatus(task);
            }

            const handleReplDone = async (task: FetchRepliesTask, result: FetchRepliesResult) => {
                if (task.corelationId !== rootEventId) return;

                const eventIds = {
                    corelationId: rootEventId,
                    causationId: task.id
                };

                if (result.nextCursor) {
                    this.enqueueRepl({
                        id: nanoid(5),
                        ...eventIds,
                        type: 'repl',
                        channelId,
                        ts: task.ts,
                        cursor: result.nextCursor,
                    }).catch(reject);;
                }


                if (downloadFiles) {
                    result.messages.forEach((v) => {
                        if (v.files) {
                            v.files.forEach(async (f) => {
                                if (f.url_private_download && (typeof f.id !== 'string' || !this.repo.hasFileSync(f as any))) {
                                    this.enqueueFile({
                                        id: nanoid(5),
                                        ...eventIds,
                                        type: 'file',
                                        url_private_download: f.url_private_download,
                                        meta: f,
                                    }).catch(reject);;
                                }
                            });
                        }
                    });
                }

                const sortedTS = result.messages.map((v) => parseFloat(v.ts ?? '0')).sort();
                console.log(`[${channelId}] Repl: ` +
                    `${new Date(parseFloat(task.ts ?? '0') * 1000).toLocaleString()} ` +
                    `${new Date(sortedTS[0] * 1000).toLocaleString()} - ${new Date(sortedTS[sortedTS.length - 1] * 1000).toLocaleString()}`);

                updateStatus(task);
            }

            const handleFileDone = (task: FetchFileTask, result: FetchFileResult) => {
                if (task.corelationId !== rootEventId) return;

                updateStatus(task);
            }

            this.on('hist', 'completed', handleHistDone);
            this.on('repl', 'completed', handleReplDone);
            this.on('file', 'completed', handleFileDone);

            this.enqueueHist({ id: rootEventId, corelationId: rootEventId, causationId: rootEventId, type: 'hist', channelId, before, after })
                .catch(reject);
        });
    }

    fetchHistory(channelId: string, cursor?: string, before?: string, after?: string) {
        const eventId = nanoid(5);
        return this.enqueueHist({ id: eventId, type: 'hist', channelId, cursor, before, after });
    }

    fetchReplies(channelId: string, ts: string, cursor?: string) {
        const eventId = nanoid(5);
        return this.enqueueRepl({ id: eventId, type: 'repl', channelId, ts, cursor });
    }

    fetchFile(url: string, meta: FileElement) {
        const eventId = nanoid(5);
        return this.enqueueFile({ id: eventId, type: 'file', url_private_download: url, meta });
    }

    private tasks: WorkQueueTask[] = [];

    // enqueue tasks

    private enqueueHist(task: FetchHistoryTask) {
        this.emit('hist', 'enqueue', task);
        return this.histQueue.enqueueTask(async () => {
            const result = await fetchHistory(this.webAPI, task);
            this.emit('hist', 'completed', task, result);
            return result;
        });
    }

    private enqueueRepl(task: FetchRepliesTask) {
        this.emit('repl', 'enqueue', task);
        return this.replQueue.enqueueTask(async () => {
            const result = await fetchReplies(this.webAPI, task);
            this.emit('repl', 'completed', task, result);
            return result;
        });
    }

    private enqueueFile(task: FetchFileTask) {
        this.emit('file', 'enqueue', task);
        return this.fileQueue.enqueueTask(async () => {
            const result = await fetchFile(this.webAPI, task);
            this.emit('file', 'completed', task, result);
            return result;
        });
    }

    private static taskToString(task: WorkQueueTask) {
        const getTaskStr = (task: WorkQueueTask) => {
            if (task.type === 'hist') {
                const histTask = task as FetchHistoryTask;
                return `${histTask.type}@${histTask.channelId}_${histTask.cursor ?? 'null'}`;
            }

            if (task.type === 'repl') {
                const replTask = task as FetchRepliesTask;
                return `${replTask.type}@${replTask.channelId}_${replTask.ts}_${replTask.cursor ?? 'null'}`;
            }

            if (task.type === 'file') {
                const fileTask = task as FetchFileTask;
                return `${fileTask.type}@${fileTask.url_private_download}`;
            }

            return 'unknown';
        }

        return `\`${getTaskStr(task)}\` #\`${task.causationId}\`-\`${task.id}\``;
    }

    private onEnqueueTask(task: WorkQueueTask) {
        this.tasks.push(task);

        // this.log(`Enqueued: ${ConversationFetchService.taskToString(task)}`);
    }

    // save result handlers

    private async saveFetchHistoryResult(task: FetchHistoryTask, result: FetchHistoryResult) {
        await this.repo.saveMessages(result.messages.map((v) => {
            const ts = v.ts;
            if (!ts) {
                this.warn(`Hist: Message without ts@${task.channelId}: ${v.text}`);
            }

            return {
                ...v,
                ts: ts ?? '0',
                channel: task.channelId,
            };
        }));
    }

    private async saveFetchRepliesResult(task: FetchRepliesTask, result: FetchRepliesResult) {
        await this.repo.saveMessages(result.messages.map((v) => {
            const ts = v.ts;
            if (!ts) {
                this.warn(`Replies: Message without ts@${task.channelId}: ${v.text}`);
            }

            return {
                ...v,
                ts: ts ?? '0',
                channel: task.channelId,
            };
        }));
    }

    private async saveFetchFileResult(task: FetchFileTask, result: FetchFileResult) {
        const meta = task.meta;
        const fileId = meta.id;

        if (!fileId) {
            this.error('File task without meta.id');
            return;
        }

        if (result.buf) {
            await this.repo.saveFile(result.buf, {
                ...meta, id: fileId
            });
        }
    }

    // TODO: better event handling
    // event handlers
    private eventListeners: { [event: string]: Function[] } = {};

    private static getEventKey(subject: EventSubjects, event: EventNames) {
        return `${subject}:${event}`;
    }

    on(subject: EventSubjects, event: EventNames, listener: Function) {
        const key = ConversationFetchService.getEventKey(subject, event);

        if (!this.eventListeners[key]) {
            this.eventListeners[key] = [];
        }
        this.eventListeners[key].push(listener);
    }

    off(subject: EventSubjects, event: EventNames, listener: Function) {
        const key = ConversationFetchService.getEventKey(subject, event);

        const listeners = this.eventListeners[key];
        if (listeners) {
            const index = listeners.indexOf(listener);
            if (index >= 0) {
                listeners.splice(index, 1);
            }
        }
    }

    emit(subject: EventSubjects, event: EventNames, ...args: any[]) {
        const key = ConversationFetchService.getEventKey(subject, event);

        const listeners = this.eventListeners[key];
        if (listeners) {
            for (const listener of listeners) {
                listener(...args);
            }
        }
    }
}
