import { Message } from "../types/message";

export type MessagesHandler = (messages: Message[]) => Promise<void>;

interface FetchConversationHistory {
    channelId: string;
    cursor?: string;
    includeReplies?: boolean;
    includeFiles?: boolean;
    oldest?: string;
    latest?: string;
    
    api_queued?: boolean;
}

export type HistoryFetchJob = FetchConversationHistory;
