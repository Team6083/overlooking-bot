import Queue from 'bull'
import { AddSlackAPITaskFunc } from '../slack/apiQueue';
import { FetchJob, MessagesHandler } from './type';

export function getFetchQueue(addTask: AddSlackAPITaskFunc, handler: MessagesHandler): Queue.Queue<FetchJob> {
    const fetchQueue = new Queue<FetchJob>('hist_fetch');

    fetchQueue.process(async (job) => {
        const { type } = job.data;

        if (type === 'conv.hist') {
            const { channelId, cursor } = job.data;

            const result = await web.conversations.history({
                channel: channelId,
                cursor,
            });

            if (result.ok && result.messages) {
                await handler(result.messages.map((v) => {
                    return {
                        ...v,
                        ts: v.ts!, // assume ts always exist
                        channel: channelId,
                    }
                }), fetchQueue);

                if (result.response_metadata?.next_cursor) {
                    await job.queue.add({
                        ...job.data,
                        cursor: result.response_metadata.next_cursor,
                    });
                }
            } else {
                throw new Error(result.error);
            }
        } else if (type === 'conv.replies') {
            const { channelId, ts, cursor } = job.data;

            const result = await web.conversations.replies({
                channel: channelId,
                ts,
                cursor,
            });

            if (result.ok && result.messages) {
                await handler(result.messages.map((v) => {
                    return {
                        ...v,
                        ts: v.ts!, // assume ts always exist
                        channel: channelId,
                    }
                }), fetchQueue);

                if (result.response_metadata?.next_cursor) {
                    await job.queue.add({
                        ...job.data,
                        cursor: result.response_metadata.next_cursor,
                    });
                }
            } else {
                throw new Error(result.error);
            }
        }
    });

    return fetchQueue;
}
