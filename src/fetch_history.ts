import { config } from 'dotenv';
config();
import * as mongoDB from 'mongodb';
import { WebClient } from '@slack/web-api';
import chalk from 'chalk';
import args from 'args';

import { doWhilstWithRate, eachLimitWithRate } from './utils/async_rate_limit';
import { Message } from './types/message';
import { getLogLevel } from './utils/get_log_level';
import { getMessageCollection } from './mongodb/collections';
import { exit } from 'process';

export type MessagesHandler = (messages: Message[]) => Promise<void>;

export type FetchRepliesProps = {
    rateLimit: number;
}

export async function fetchReplies(web: WebClient, channelId: string, ts: string, handler: MessagesHandler, props?: FetchRepliesProps) {
    const rateLimit: number = props?.rateLimit ?? 2000;
    let nextCursor: string | null = null;

    await doWhilstWithRate((cb) => {
        web.conversations.replies({
            channel: channelId,
            ts,
            cursor: nextCursor ?? undefined,
        }).then((result) => {

            if (!result.ok) {
                console.error(result.error);
                cb(new Error(result.error ?? 'unknown error'));
            } else if (result.messages) {
                nextCursor = result.response_metadata?.next_cursor ?? null;

                console.log(chalk.blue(result.response_metadata?.next_cursor));

                handler(result.messages.map((v) => {
                    return {
                        ...v,
                        ts: v.ts!, // assume ts always exist
                        channel: channelId,
                    }
                })).then(() => cb(null)).catch(cb);
            } else {
                cb(null);
            }
        });
    }, (cb) => {
        cb(null, typeof nextCursor === 'string');
    }, rateLimit);
}

export type FetchHistoryProps = {
    latest: string;
    oldest: string;

    includeReplies: boolean;

    rateLimit: number;
};

export async function fetchHistory(web: WebClient, channelId: string, handler: MessagesHandler, props?: Partial<FetchHistoryProps>) {
    const rateLimit: number = props?.rateLimit ?? 5000;
    let nextCursor: string | null = null;

    await doWhilstWithRate((cb) => {

        web.conversations.history({
            channel: channelId,
            cursor: nextCursor ?? undefined,
            latest: props?.latest,
            oldest: props?.oldest,
        }).then((result) => {
            if (!result.ok) {
                console.error(result.error);
                cb(new Error(result.error ?? 'unknown error'));
            } else if (result.messages) {
                nextCursor = result.response_metadata?.next_cursor ?? null;

                console.log('next_cursor', chalk.yellow(result.response_metadata?.next_cursor));
                console.log('first_msg_time', chalk.green(result.messages[0]?.ts ? new Date(parseFloat(result.messages[0]?.ts ?? '0') * 1000).toLocaleString() : undefined));

                Promise.all([
                    handler(result.messages.map((v) => {
                        return {
                            ...v,
                            ts: v.ts!, // assume ts always exist
                            channel: channelId,
                        }
                    })),
                    // fetch replies
                    props?.includeReplies ? eachLimitWithRate(
                        result.messages.filter((v) => v.reply_count && v.reply_count > 0 && typeof v.ts === 'string'),
                        1,
                        (item, callback) => {
                            console.log(`fetching replies for ${item.ts} @ ${channelId}: ${item.text ?? 'n/a'} (${item.reply_count})`)
                            fetchReplies(web, channelId, item.ts!, handler).then(() => callback(null));
                        }
                        ,
                        2000
                    ) : Promise.resolve(),
                ]).then(() => cb(null)).catch(cb);
            } else {
                cb(null);
            }
        });
    }, (cb) => {
        cb(null, typeof nextCursor === 'string')
    }, rateLimit);
}

(async () => {
    args
        .option('channel', 'ID of the channel to fetch')
        .option('includeReplies', 'Should get replies of messages.');

    const { channel, includeReplies } = args.parse(process.argv);
    if (typeof channel !== 'string' || channel.length === 0) {
        throw new Error('channel is required');
    }

    if (!process.env.DB_CONN_STRING) throw new Error('Env DB_CONN_STRING is required.');
    const client = new mongoDB.MongoClient(process.env.DB_CONN_STRING);
    await client.connect();

    const web = new WebClient(process.env.SLACK_BOT_TOKEN, {
        logLevel: getLogLevel(process.env.LOG_LEVEL),
    });

    const conversationsInfoResult = await web.conversations.info({ channel });
    if (!conversationsInfoResult.ok || !conversationsInfoResult.channel) {
        console.error(conversationsInfoResult.error);
        exit(1);
    }

    if (!conversationsInfoResult.channel.is_member && !conversationsInfoResult.channel.is_archived) {
        console.log(`Bot not in channel, trying to join the channel...`)

        const r = await web.conversations.join({ channel });
        if (!r.ok) {
            console.error(r.error);
            exit(1);
        }
        console.log('Successfully joined!');
    }

    const msgCollection = getMessageCollection(client.db());

    const getQuery = () => msgCollection.find({ channel, thread_ts: { $exists: false } });
    const latest: string | undefined = (await getQuery().sort('ts', 'asc').limit(1).toArray())[0]?.ts;
    const oldest: string | undefined = (await getQuery().sort('ts', 'desc').limit(1).toArray())[0]?.ts;

    const handler: MessagesHandler = async (messages) => {
        if (messages.length > 0) {
            await Promise.all(messages.map(async (v) => {
                const r = await msgCollection.findOne({ channel: v.channel, ts: v.ts });
                if (!r) {
                    console.log(`creating ${v.ts} @ ${v.channel}: ${(v as any).text ?? 'n/a'}`);
                    await msgCollection.insertOne(v);
                } else {
                    await msgCollection.updateOne({ _id: r._id }, {
                        $set: v,
                    });
                }
            }));
        }
    };

    if (oldest) console.log(`Fetch range: ~${oldest}, ${latest}~`);

    await fetchHistory(web, channel, handler, {
        latest,
        includeReplies: includeReplies === 'true',
    });

    if (oldest !== undefined) {
        await fetchHistory(web, channel, handler, {
            oldest,
            includeReplies: includeReplies === 'true',
        });
    }

    console.log('Done.');
    exit(0);
})();
