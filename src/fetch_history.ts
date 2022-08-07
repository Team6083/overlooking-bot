import { doWhilst, eachLimit } from 'async';
import { WebClient } from '@slack/web-api';
import chalk from 'chalk';
import { doWhilstWithRate, eachLimitWithRate } from './utils/async_rate_limit';
import { Message } from './types/message';

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
    rateLimit: number;
};

export async function fetchHistory(web: WebClient, channelId: string, handler: MessagesHandler, props?: Partial<FetchHistoryProps>) {
    const rateLimit: number = props?.rateLimit ?? 5000;
    let nextCursor: string | null = null;

    await doWhilstWithRate((cb) => {

        web.conversations.history({
            channel: channelId,
            cursor: nextCursor ?? undefined
        }).then((result) => {
            if (!result.ok) {
                console.error(result.error);
                cb(new Error(result.error ?? 'unknown error'));
            } else if (result.messages) {
                nextCursor = result.response_metadata?.next_cursor ?? null;

                console.log(chalk.yellow(result.response_metadata?.next_cursor));
                console.log(chalk.green(new Date(parseFloat(result.messages[0]?.ts ?? '0') * 1000).toLocaleString()));

                Promise.all([
                    handler(result.messages.map((v) => {
                        return {
                            ...v,
                            ts: v.ts!, // assume ts always exist
                            channel: channelId,
                        }
                    })),
                    eachLimitWithRate(
                        result.messages.filter((v) => v.reply_count && v.reply_count > 0 && typeof v.ts === 'string'),
                        1,
                        (item, callback) => {
                            console.log(`fetching replies for ${item.ts} @ ${channelId}: ${item.text ?? 'n/a'} (${item.reply_count})`)
                            fetchReplies(web, channelId, item.ts!, handler).then(() => callback(null));
                        }
                        ,
                        2000
                    )
                ]).then(() => cb(null)).catch(cb);
            } else {
                cb(null);
            }
        });
    }, (cb) => {
        cb(null, typeof nextCursor === 'string')
    }, rateLimit);
}
