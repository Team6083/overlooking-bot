import { WebClient } from "@slack/web-api";
import * as MongoDB from 'mongodb';
import { queue } from "async";

import 'dotenv/config'
import { downloadFileFromSlack } from "./utils/slack";
import { FileElement } from "@slack/web-api/dist/response/ConversationsHistoryResponse";
import { nanoid } from "nanoid";
import { setTimeout } from "timers/promises";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { exit } from "process";
import args from "args";

interface StorageMessage {
    channel: string;
    ts?: string;
}

type MessagesHandler = (messages: StorageMessage[]) => Promise<void>;

type FetchMessageProps = {
    cursor: string;
    latest: string;
    oldest: string;
};

type FetchConversationProps = {
    latest: string;
    oldest: string;

    omitReplies: boolean;
    omitFiles: boolean;
}

class ConversationFetchService {
    constructor(
        private webAPI: WebClient,
        private messageHandler: MessagesHandler,
        private fileSavePrefix: string,
    ) { }

    async fetchConversation(channelId: string, props?: Partial<FetchConversationProps>) {
        const { latest, oldest, omitFiles, omitReplies } = props ?? {};

        type WorkQueueTask = {
            type: 'hist',
            cId: string,
            cursor?: string,
        } | {
            type: 'repl',
            cId: string,
            ts: string,
            cursor?: string,
        } | {
            type: 'file',
            file: FileElement
        };

        const taskToStr = (task: WorkQueueTask) => {
            if (task.type === 'hist') return `hist: ${task.cId}, cursor=${task.cursor ?? 'None'}`;
            if (task.type === 'repl') return `repl: ${task.cId}, ts=${task.ts}, cursor=${task.cursor ?? 'None'}`;
            if (task.type === 'file') return `file: ${task.file.permalink ?? task.file.external_url}`;
        }

        const workQueue = queue((_task: WorkQueueTask, cb) => {
            (async (task: WorkQueueTask) => {
                console.log(`Processing ${taskToStr(task)}`);

                if (task.type === 'hist') {
                    const result = await this.fetchHistory(task.cId, {
                        cursor: task.cursor,
                        latest,
                        oldest,
                    });

                    if (!Array.isArray(result.messages)) throw new Error('messages are not array');

                    const messages = result.messages.map((msg) => {
                        if (!msg.ts) console.warn(`Hist: Message without ts@${task.cId}: ${msg.text}`);

                        return {
                            ...msg,
                            channel: task.cId,
                        };
                    });

                    await this.messageHandler(messages);

                    // Add next history work
                    if (result.nextCursor) {
                        workQueue.unshift({
                            ...task,
                            cursor: result.nextCursor,
                        });
                    }

                    // Add reply works
                    if (!omitReplies) {
                        const works = messages
                            .filter((v) => typeof v.ts === 'string' && v.reply_count && v.reply_count > 0)
                            .map((v): WorkQueueTask => ({
                                type: 'repl',
                                cId: v.channel,
                                ts: v.ts!,
                            }));

                        workQueue.unshift(works);
                    }

                    // Add file works
                    if (!omitFiles) {
                        const works = messages
                            .filter((v) => Array.isArray(v.files))
                            .map((msg) => msg.files!)
                            .flat()
                            .map((file): WorkQueueTask => ({
                                type: 'file',
                                file,
                            }));

                        workQueue.unshift(works);
                    }
                } else if (task.type === 'repl') {
                    const result = await this.fetchReplies(task.cId, task.ts, {
                        cursor: task.cursor,
                        latest,
                        oldest,
                    });

                    if (!Array.isArray(result.messages)) throw new Error('messages are not array');

                    const messages = result.messages.map((msg) => {
                        if (!msg.ts) console.warn(`Repl: Message without ts@${task.cId}: ${msg.text}`);
                        if (!msg.thread_ts) console.warn(`Repl: Message without thread_ts@${task.cId}: ${msg.text}`);

                        return {
                            ...msg,
                            channel: task.cId,
                        };
                    });

                    await this.messageHandler(messages);

                    // Add next reply work
                    if (result.nextCursor) {
                        workQueue.unshift({
                            ...task,
                            cursor: result.nextCursor,
                        });
                    }

                    // Add file works
                    if (!omitFiles) {
                        const works = messages
                            .filter((v) => Array.isArray(v.files))
                            .map((msg) => msg.files!)
                            .flat()
                            .map((file): WorkQueueTask => ({
                                type: 'file',
                                file,
                            }));

                        workQueue.unshift(works);
                    }
                } else if (task.type === 'file') {
                    const { id, user, name, url_private_download, mode, is_external } = task.file;

                    if (is_external) return;

                    if (mode === 'tombstone') {
                        console.warn(`File: ${id} no longer available.`);
                        return;
                    }
                    if (!url_private_download) throw new Error('url_private_download is undefined');

                    const dirPath = `${this.fileSavePrefix}/${user ?? 'unknown'}/${id ?? nanoid()}`;
                    const filePath = `${dirPath}/${name}`;


                    if (!existsSync(dirPath)) {
                        await mkdir(dirPath, { recursive: true });
                    }

                    await this.downloadFile(url_private_download, filePath);
                }
            })(_task)
                .then(() => cb())
                .catch((err) => cb(err));
        });

        workQueue.error(function (err, task) {
            console.error(`task experienced an error, ${taskToStr(task)}`);
            console.error(task);
            console.error(err);
        });

        workQueue.push({
            type: 'hist',
            cId: channelId,
        });

        return workQueue.drain();
    }

    downloadFile(url: string, savePath: string) {
        return downloadFileFromSlack(url, savePath, this.webAPI.token);
    }

    private lastFetchReplies: number | undefined;
    async fetchReplies(channelId: string, ts: string, props?: Partial<FetchMessageProps>) {
        await setTimeout(this.lastFetchReplies ? 2000 - (Date.now() - this.lastFetchReplies) : 0);
        this.lastFetchReplies = Date.now();

        const { cursor, latest, oldest } = props ?? {};

        const result = await this.webAPI.conversations.replies({
            channel: channelId,
            ts,
            include_all_metadata: true,
            cursor,
            latest,
            oldest,
        });

        if (result.ok) {
            const nextCursor = result.response_metadata?.next_cursor;

            return {
                messages: result.messages?.slice(1),
                nextCursor,
            }
        } else {
            throw new Error(result.error);
        }
    }

    private lastFetchHistory: number | undefined;
    async fetchHistory(channelId: string, props?: Partial<FetchMessageProps>) {
        await setTimeout(this.lastFetchHistory ? 2000 - (Date.now() - this.lastFetchHistory) : 0);
        this.lastFetchHistory = Date.now();

        const { cursor, latest, oldest } = props ?? {};

        const result = await this.webAPI.conversations.history({
            channel: channelId,
            include_all_metadata: true,
            cursor,
            latest,
            oldest
        });

        if (result.ok) {
            const nextCursor = result.response_metadata?.next_cursor;

            return {
                messages: result.messages,
                nextCursor,
            }
        } else {
            throw new Error(result.error);
        }
    }
}

(async function () {
    args
        .option('channel', 'ID of the channel to fetch');


    const { channel } = args.parse(process.argv);
    if (typeof channel !== 'string' || channel.length === 0) {
        throw new Error('channel is required');
    }

    if (!process.env.DB_CONN_STRING) throw new Error('Env DB_CONN_STRING is required.');
    const client = new MongoDB.MongoClient(process.env.DB_CONN_STRING);
    await client.connect();

    const msgCollection = client.db().collection('messages');

    const fileSavePrefix = process.env.SLACK_FILE_SAVE_PREFIX;
    if (!fileSavePrefix) throw new Error('Env SLACK_FILE_SAVE_PREFIX is required.');

    const fetchService = new ConversationFetchService(
        new WebClient(process.env.SLACK_BOT_TOKEN),
        async (messages) => {
            await Promise.all(messages.map(async (v) => {
                if (!v.ts) {
                    await msgCollection.insertOne(v);
                    return;
                }

                const r = await msgCollection.findOne({ channel: v.channel, ts: v.ts });
                if (!r) {
                    console.log(`creating ${v.ts} @ ${v.channel}: ${(v as any).text ?? 'n/a'}`);
                    await msgCollection.insertOne(v);
                } else {
                    console.log(`updating ${v.ts} @ ${v.channel} (${r._id.toHexString()})`)
                    await msgCollection.updateOne({ _id: r._id }, {
                        $set: v,
                    });
                }
            }));
        },
        fileSavePrefix,
    );

    console.log(`Start fetch conversation from ${channel}`);
    await fetchService.fetchConversation(channel);

    exit();
})();
