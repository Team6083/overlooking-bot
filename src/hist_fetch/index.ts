import { ConversationsHistoryResponse, ConversationsInfoResponse, ConversationsRepliesResponse } from '@slack/web-api';
import Queue from 'bull'
import { Collection } from 'mongodb';
import { getAPIQueue } from '../slack/apiQueue';
import { HistoryFetchJob, MessagesHandler } from './type';

export function getFetchQueue(apiQueue: ReturnType<typeof getAPIQueue>, storageHandler: MessagesHandler) {
    const fetchQueue = new Queue<HistoryFetchJob>('hist_fetch');

    const { addTask, registerOnComplete } = apiQueue;

    fetchQueue.process((job, done) => {
        const { channelId, cursor, latest, oldest } = job.data;

        console.log(job.id, job.data);
        (async () => {
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
                if (!(await reqJob.isActive())) return;

                if (job.data.type === 'conv.hist' || job.data.type === 'conv.replies') {
                    const result = _r as (ConversationsHistoryResponse | ConversationsRepliesResponse);

                    if (result.ok && result.messages) {
                        // save messages to storage
                        if (result.messages.length > 0) {
                            await storageHandler(result.messages.map((v) => {
                                return {
                                    ...v,
                                    ts: v.ts!, // assume ts always exist
                                    channel: reqJob.data.channelId,
                                };
                            }));
                        }

                        // log result
                        if (job.data.type === 'conv.hist') {
                            await reqJob.log(
                                `Get ${result.messages.length} messages` +
                                (result.messages[0]?.ts ? `, oldest ${new Date(parseFloat(result.messages[0].ts) * 1000)}` : '') +
                                (result.response_metadata?.next_cursor ? `, next cursor "${result.response_metadata?.next_cursor}"` : '') +
                                '.'
                            );
                        } else {
                            await reqJob.log(
                                `Get ${result.messages.length} replies (thread_ts: "${result.messages[0]?.thread_ts ?? 'n/a'}")` +
                                (result.response_metadata?.next_cursor ? `, next cursor "${result.response_metadata?.next_cursor}"` : '') +
                                '.'
                            );
                        }

                        // fetch replies if includeReplies is true
                        if (job.data.type === 'conv.hist' && reqJob.data.includeReplies && result.messages.length > 0) {
                            const threads = (result as ConversationsHistoryResponse).messages!.filter((v) => v.ts && v.reply_count && v.reply_count > 0);

                            await reqJob.log(`Fetching replies for ${threads.length} messages.`);

                            threads.forEach(async (t) => {
                                addTask({
                                    type: 'conv.replies',
                                    data: {
                                        channel: reqJob.data.channelId,
                                        ts: t.ts!,
                                    },
                                    reqJobId: reqJob.id,
                                    reqNamespace: 'hist_fetch'
                                });
                            });
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

export async function fetch_channel(queue: Queue.Queue<HistoryFetchJob>, channelId: string, messageCollection: Collection,
    includeReplies: boolean = true, includeFiles: boolean = true
) {
    const getQuery = () => messageCollection.find({ channel: channelId, thread_ts: { $exists: false } });
    const latest: string | undefined = (await getQuery().sort('ts', 'asc').limit(1).toArray())[0]?.ts;
    const oldest: string | undefined = (await getQuery().sort('ts', 'desc').limit(1).toArray())[0]?.ts;

    const j1 = await queue.add({
        channelId,
        latest,
        includeReplies,
        includeFiles
    });

    console.log(j1.id);

    const j2 = await queue.add({
        channelId,
        oldest,
        includeReplies,
        includeFiles
    });

    console.log(j2.id);
}
