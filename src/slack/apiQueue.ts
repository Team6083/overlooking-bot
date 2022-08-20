import { ConversationsHistoryArguments, ConversationsRepliesArguments, WebClient } from "@slack/web-api";
import Queue, { Job } from "bull";

export type ConversationHistoryRequest = { type: 'conv.hist', data: ConversationsHistoryArguments };
export type ConversationRepliesRequest = { type: 'conv.replies', data: ConversationsRepliesArguments };

export type WebClientRequest = ConversationHistoryRequest | ConversationRepliesRequest;

export type AddSlackAPITaskFunc = (task: WebClientRequest) => Promise<Job<WebClientRequest>>;

export interface GetAPIQueueResp {
    queues: Queue.Queue<WebClientRequest>[];
    addTask: AddSlackAPITaskFunc;
}

export function getAPIQueue(web: WebClient): GetAPIQueueResp {
    const t1 = new Queue<WebClientRequest>('slack_tier1', { limiter: { max: 1, duration: 70000 } });
    const t2 = new Queue<WebClientRequest>('slack_tier2', { limiter: { max: 1, duration: 7000 } });
    const t3 = new Queue<WebClientRequest>('slack_tier3', { limiter: { max: 1, duration: 2000 } });
    const t4 = new Queue<WebClientRequest>('slack_tier4', { limiter: { max: 1, duration: 1000 } });
    const no_limit = new Queue<WebClientRequest>('slack_no_limit');

    const processFunc = async (job: Job<WebClientRequest>) => {
        const { type, data } = job.data;

        if (type === 'conv.hist') {
            return web.conversations.history(data);
        } else if (type === 'conv.replies') {
            return web.conversations.replies(data);
        }
    }

    const queues = [t1, t2, t3, t4, no_limit];
    queues.forEach((q) => {
        q.process(processFunc);
    });

    return {
        queues,
        addTask: (task) => {
            if (['conv.hist', 'conv.replies'].includes(task.type)) {
                return t3.add(task);
            }

            throw new Error('Not supported');
        },
    };
}
