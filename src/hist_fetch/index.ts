import { ConversationsHistoryResponse, ConversationsRepliesResponse } from '@slack/web-api';
import Queue, { Job } from 'bull'
import { AddSlackAPITaskFunc, WebClientRequest } from '../slack/apiQueue';
import { FetchJob, MessagesHandler } from './type';

export function getFetchQueue(addTask: AddSlackAPITaskFunc, storageHandler: MessagesHandler): Queue.Queue<FetchJob> {
    const fetchQueue = new Queue<FetchJob>('hist_fetch');

    fetchQueue.process(4, (job, done) => {
        const { type } = job.data;

        if (type === 'conv.hist') {
            const { channelId, cursor, includeReplies } = job.data;

            const jobHandler = async (reqJob: Job<WebClientRequest>) => {
                const result = await reqJob.finished() as ConversationsHistoryResponse;

                if (result.ok && result.messages) {
                    job.log(`Get ${result.messages.length} messages.`);

                    if (includeReplies) {
                        result.messages
                            .filter((v) => v.reply_count && v.reply_count > 0 && !!v.ts)
                            .forEach((v) => {
                                fetchQueue.add({
                                    type: 'conv.replies',
                                    channelId,
                                    ts: v.ts!,
                                    totalReplies: v.reply_count!,
                                }, { priority: 9 }).then((job) => {
                                    job.log(`Thread parent message "${v.text}" @ ${channelId}`);
                                });
                            });
                    }

                    await storageHandler(result.messages.map((v) => {
                        return {
                            ...v,
                            ts: v.ts!, // assume ts always exist
                            channel: channelId,
                        }
                    }));

                    if (result.response_metadata?.next_cursor) {
                        // if has next_cursor, run with next_cursor
                        job.log(`Next cursor ${result.response_metadata.next_cursor}`);

                        await job.update({
                            ...job.data,
                            cursor: result.response_metadata.next_cursor,
                        });

                        addTask({
                            type: 'conv.hist',
                            data: {
                                channel: channelId,
                                cursor: result.response_metadata.next_cursor
                            },
                        }).then(jobHandler);
                    } else {
                        done(null);
                    }
                } else {
                    throw new Error(result.error);
                }
            }

            addTask({
                type: 'conv.hist',
                data: {
                    channel: channelId,
                    cursor,
                },
            }).then(jobHandler).catch(done);
        } else if (type === 'conv.replies') {
            const { channelId, ts, cursor, totalReplies } = job.data;

            const jobHandler = async (reqJob: Job<WebClientRequest>) => {
                const result = await reqJob.finished() as ConversationsRepliesResponse;

                if (result.ok && result.messages) {
                    job.log(`Get ${result.messages.length} messages.`);

                    job.progress(result.messages.length / totalReplies);

                    await storageHandler(result.messages.map((v) => {
                        return {
                            ...v,
                            ts: v.ts!, // assume ts always exist
                            channel: channelId,
                        }
                    }));

                    if (result.response_metadata?.next_cursor) {
                        // if has next_cursor, run with next_cursor
                        job.log(`Next cursor ${result.response_metadata.next_cursor}`);

                        await job.update({
                            ...job.data,
                            cursor: result.response_metadata.next_cursor,
                        });

                        addTask({
                            type: 'conv.replies',
                            data: {
                                channel: channelId,
                                ts,
                                cursor: result.response_metadata.next_cursor,
                            }
                        }).then(jobHandler);
                    } else {
                        done(null);
                    }
                } else {
                    throw new Error(result.error);
                }
            }

            addTask({
                type: 'conv.replies',
                data: {
                    channel: channelId,
                    ts,
                    cursor,
                }
            }).then(jobHandler).catch(done);
        }
    });

    return fetchQueue;
}
