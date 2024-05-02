import { MessageChangedEvent, MessageDeletedEvent } from "@slack/bolt";
import { writeFileSync } from "fs";
import { nanoid } from "nanoid";

import { FileMetadata, FindMessagesParams, Message, SlackStorageRepository } from "./index";

export class DevSlackStorageRepository implements SlackStorageRepository {


    findMessage(channel: string, ts: string): Promise<Message | undefined> {
        throw new Error("Method not implemented.");
    }

    findLatestMessage(channel: string): Promise<Message | undefined> {
        throw new Error("Method not implemented.");
    }

    findMessages(channel: string, params?: FindMessagesParams): Promise<Message[]> {
        throw new Error("Method not implemented.");
    }

    async saveMessages(messages: Message[]): Promise<void> {
        console.log(`Saving ${messages.length} messages`);
    }

    async saveFile(data: ArrayBuffer, meta?: FileMetadata): Promise<void> {
        const fileNames = meta?.name ? meta.name : `unknown`;
        const fileId = meta?.id ? meta.id : nanoid();

        const path = `./files/${fileId}_${fileNames}`;

        writeFileSync(path, Buffer.from(data));
    }

    async onMessage(data: Message): Promise<void> {
        console.log(`Received message: `, data);
    }

    async onMessageChanged(data: MessageChangedEvent): Promise<void> {
        console.log(`Changed message: `, data);
    }

    async onMessageDeleted(data: MessageDeletedEvent): Promise<void> {
        console.log(`Deleted message: `, data);
    }

}
