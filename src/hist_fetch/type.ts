import { Queue } from "bull";
import { Message } from "../types/message";

export type fetchJobTypes = 'conv.hist' | 'conv.replies';

export type MessagesHandler = (messages: Message[], queue: Queue<FetchJob>) => Promise<void>;

export interface FetchConversationHistory {
    type: 'conv.hist';
    channelId: string;
    cursor?: string;
}

export interface FetchConversationReplies {
    type: 'conv.replies';
    channelId: string;
    ts: string;
    cursor?: string;
}

export type FetchJob = FetchConversationHistory | FetchConversationReplies;

export function getFetchJobDesc(job: FetchJob): string {
    let desc = `${job.type}: ${job.channelId}`;

    if (job.type === 'conv.replies') {
        desc += ` ${job.ts}`;
    }

    if (job.cursor) {
        desc += ` ${job.cursor}`;
    }

    return desc;
}
