import { MessageChangedEvent, MessageDeletedEvent } from "@slack/bolt";
import { writeFileSync, accessSync, constants } from "fs";
import { Collection } from "mongodb";
import { mkdir } from "fs/promises";

import { FileMetadata, FindMessagesParams, Message, SlackStorageRepository } from "./index";

export class MongoDBSlackStorageRepository implements SlackStorageRepository {
    constructor(
        private msgCollection: Collection,
        private changedMsgCollection: Collection,
        private deletedMsgCollection: Collection,
        private fileMetadataCollection: Collection,
        private fileSavePrefix: string,
    ) { }

    findMessage(channel: string, ts: string): Promise<Message | undefined> {
        throw new Error("Method not implemented.");
    }

    async findLatestMessage(channel: string): Promise<Message | undefined> {
        const cursor = this.msgCollection.aggregate([
            {
                '$match': {
                    'channel': channel
                }
            }, {
                '$addFields': {
                    'ts_num': {
                        '$toDouble': '$ts'
                    }
                }
            }, {
                '$sort': {
                    'ts_num': -1
                }
            }, {
                '$limit': 1
            }
        ]);

        const result = await cursor.next();
        if (!result)
            return undefined;

        return result as Message;
    }

    findMessages(channel: string, params?: FindMessagesParams): Promise<Message[]> {
        throw new Error("Method not implemented.");
    }

    async saveMessages(messages: Message[]): Promise<void> {
        await Promise.all(messages.map(async (v) => {
            const r = await this.msgCollection.findOne({ channel: v.channel, ts: v.ts });
            if (!r) {
                await this.msgCollection.insertOne(v);
            } else {
                await this.msgCollection.updateOne({ _id: r._id }, {
                    $set: v,
                });
            }
        }));
    }

    private static getFilePath(prefix: string, meta: FileMetadata): string {
        const fileId = meta.id;
        const fileName = meta.name ?? 'unknown';

        return `${prefix}/${fileId}_${fileName}`;
    }

    hasFileSync(meta: FileMetadata): boolean {
        const path = MongoDBSlackStorageRepository.getFilePath(this.fileSavePrefix, meta);
        try {
            accessSync(path, constants.F_OK);

            return true;
        } catch (error) {
            return false;
        }
    }

    async saveFile(data: ArrayBuffer, meta: FileMetadata): Promise<void> {
        const fileId = meta.id;
        const dirPath = this.fileSavePrefix;
        await mkdir(dirPath, { recursive: true });

        const filePath = MongoDBSlackStorageRepository.getFilePath(dirPath, meta);
        writeFileSync(filePath, Buffer.from(data));

        if (meta) {
            const r = await this.fileMetadataCollection.findOne({ id: fileId });
            if (!r) {
                await this.fileMetadataCollection.insertOne(meta);
            } else {
                await this.fileMetadataCollection.updateOne({ _id: r._id }, {
                    $set: meta,
                });
            }
        }
    }

    async onMessage(data: Message): Promise<void> {
        await this.msgCollection.insertOne(data);
    }

    async onMessageChanged(data: MessageChangedEvent): Promise<void> {
        await this.changedMsgCollection.insertOne(data);
    }

    async onMessageDeleted(data: MessageDeletedEvent): Promise<void> {
        await this.deletedMsgCollection.insertOne(data);
    }

}
