import { doWhilst, eachLimit } from 'async';
import { WebClient } from '@slack/web-api';
import chalk from 'chalk';
import { doWhilstWithRate, eachLimitWithRate } from './utils/async_rate_limit';
import { Message } from './types/message';

export type MessagesHandler = (messages: Message[]) => Promise<void>;

export async function fetch_replies(web: WebClient, channelId: string, ts: string, handler: MessagesHandler) {

    let nextCursor: string | null = null;
    let lastResponseTime: Date | null = null;

    await doWhilst((cb) => {
        const rateLimit = 2000;
        const timeoutSec = lastResponseTime ? rateLimit - (Date.now() - lastResponseTime?.getTime()) : 0;

        setTimeout(() => {
            web.conversations.replies({
                channel: channelId,
                ts,
                cursor: nextCursor ?? undefined,
            }).then((result) => {
                lastResponseTime = new Date();

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
                    })).then(() => {
                        cb(null);
                    });
                } else {
                    cb(null);
                }
            });
        }, timeoutSec);
    }, (cb) => {
        cb(null, typeof nextCursor === 'string');
    });
}

export async function fetch_history(web: WebClient, channelId: string, handler: MessagesHandler) {

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
                            fetch_replies(web, channelId, item.ts!, handler).then(() => callback(null));
                        }
                        ,
                        2000
                    )
                ]).then(() => {
                    cb(null);
                });
            } else {
                cb(null);
            }
        });
    }, (cb) => {
        cb(null, typeof nextCursor === 'string')
    }, 5000);
}
