import { KnownEventFromType, MessageChangedEvent, MessageDeletedEvent } from "@slack/bolt";

export interface Message {
    channel: string;
    ts: string;
};

export interface FileMetadata {
    id: string;
    name?: string;
    permalink?: string;
};

export type FindMessagesParams = {
    after?: string,
    before?: string
};

export interface SlackStorageRepository {
    findMessage(channel: string, ts: string): Promise<Message | undefined>;

    findLatestMessage(channel: string): Promise<Message | undefined>;

    findMessages(channel: string, params?: FindMessagesParams): Promise<Message[]>;

    saveMessages(messages: Message[]): Promise<void>;

    saveFile(data: ArrayBuffer, meta: FileMetadata): Promise<void>;

    onMessage(data: Message): Promise<void>;

    onMessageChanged(data: MessageChangedEvent): Promise<void>;

    onMessageDeleted(data: MessageDeletedEvent): Promise<void>;
}
