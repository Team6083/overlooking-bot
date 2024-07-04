import { FileElement, MessageElement as HistMessageElement } from "@slack/web-api/dist/response/ConversationsHistoryResponse";
import { MessageElement as ReplMessageElement } from "@slack/web-api/dist/response/ConversationsRepliesResponse";

export interface WorkQueueTask {
    id: string;
    type: string;
    corelationId?: string;
    causationId?: string;
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
