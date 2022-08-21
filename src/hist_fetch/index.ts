import { ConversationsHistoryResponse, ConversationsInfoResponse, ConversationsRepliesResponse } from '@slack/web-api';
import Queue from 'bull'
import { getAPIQueue } from '../slack/apiQueue';
import { HistoryFetchJob, MessagesHandler } from './type';

export function getFetchQueue(apiQueue: ReturnType<typeof getAPIQueue>, storageHandler: MessagesHandler) {
    const fetchQueue = new Queue<HistoryFetchJob>('hist_fetch');

    const { addTask, registerOnComplete } = apiQueue;

    fetchQueue.process((job, done) => {
        const { channelId, cursor, latest, oldest } = job.data;

        (async () => {
            if (typeof job.data.channel_created !== 'number') {
                const infoJob = await addTask({
                    type: 'conv.info',
                    data: {
                        channel: channelId,
                    },
                    reqJobId: job.id,
                    reqNamespace: 'hist_fetch'
                });

                const result: ConversationsInfoResponse = await infoJob.finished();

                if (result.ok && result.channel?.created) {
                    await job.update({
                        ...job.data,
                        channel_created: result.channel.created,
                    });
                }
            }

            if (!job.data.api_queued) {
                await addTask({
                    type: 'conv.hist',
                    data: {
                        channel: channelId,
                        cursor,
                        latest,
                        oldest
                    },
                    reqJobId: job.id,
                    reqNamespace: 'hist_fetch'
                });

                await job.update({
                    ...job.data,
                    api_queued: true,
                });
            }
        })();
    });

    registerOnComplete(async (job, _r: unknown) => {
        if (job.data.reqNamespace === 'hist_fetch') {
            const reqJob = await fetchQueue.getJob(job.data.reqJobId);

            if (reqJob) {
                if (job.data.type === 'conv.hist' || job.data.type === 'conv.replies') {
                    const result = _r as (ConversationsHistoryResponse | ConversationsRepliesResponse);

                    if (result.ok && result.messages) {
                        // save messages to storage
                        await storageHandler(result.messages.map((v) => {
                            return {
                                ...v,
                                ts: v.ts!, // assume ts always exist
                                channel: reqJob.data.channelId,
                            };
                        }));

                        // log result
                        if (job.data.type === 'conv.hist') {
                            await reqJob.log(
                                `Get ${result.messages.length} messages` +
                                (result.messages[0].ts ? `, oldest ${new Date(parseFloat(result.messages[0].ts) * 1000)}` : '') +
                                (result.response_metadata?.next_cursor ? `, next cursor "${result.response_metadata?.next_cursor}"` : '') +
                                '.'
                            );
                        }

                        // update progress
                        if (job.data.type === 'conv.hist' && reqJob.data.channel_created) {
                            const lastMessage = result.messages[0];
                            const lastMessageTS = lastMessage.ts ? parseFloat(lastMessage.ts) : undefined;
                            if (lastMessageTS && !isNaN(lastMessageTS)) {
                                const total = Date.now() - reqJob.data.channel_created * 1000;
                                const progress = Date.now() - lastMessageTS * 1000;

                                await reqJob.progress(Math.floor((progress / total) * 100));
                            }
                        }

                        // check if has next_cursor
                        if (result.response_metadata?.next_cursor) {
                            const nextCursor = result.response_metadata?.next_cursor;
                            if (job.data.type === 'conv.hist') {
                                await addTask({
                                    type: 'conv.hist',
                                    data: {
                                        ...job.data.data,
                                        cursor: nextCursor,
                                    },
                                    reqJobId: reqJob.id,
                                    reqNamespace: 'hist_fetch'
                                });
                            } else if (job.data.type === 'conv.replies') {
                                await addTask({
                                    type: 'conv.replies',
                                    data: {
                                        ...job.data.data,
                                        cursor: nextCursor,
                                    },
                                    reqJobId: reqJob.id,
                                    reqNamespace: 'hist_fetch'
                                });
                            }
                        } else {
                            // no next_cursor
                            const pendingChildJobs = (await job.queue.getJobs(['active', 'delayed', 'paused', 'waiting']))
                                .filter((v) => v.data.reqNamespace === 'hist_fetch' && v.data.reqJobId === reqJob.id);

                            if (pendingChildJobs.length === 0) {
                                // no pending child jobs, mark reqJob as done.
                                await reqJob.moveToCompleted();
                            }
                        }
                    } else {
                        reqJob.log(`Get error from job "${job.id}": ${result.error}`);
                    }
                }
            }
        }
    });

    return fetchQueue;
}
