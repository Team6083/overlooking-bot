import { config } from 'dotenv';
config();
import { App, LogLevel, subtype } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import * as mongoDB from 'mongodb';
import { writeFile, mkdir } from 'fs/promises';
import fetch, { Headers } from 'node-fetch';
import { fetch_history } from './fetch_history';
import { getChangedMsgCollection, getMessageCollection } from './mongodb/collections';
import { isGenericMessageEvent } from './utils/helpers';

function getLogLevel(logLevel: string | undefined): LogLevel {
    if (logLevel === LogLevel.ERROR) return LogLevel.ERROR;
    if (logLevel === LogLevel.WARN) return LogLevel.WARN;
    if (logLevel === LogLevel.INFO) return LogLevel.INFO;
    if (logLevel === LogLevel.DEBUG) return LogLevel.DEBUG;

    return LogLevel.WARN;
}

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN,
    logLevel: getLogLevel(process.env.LOG_LEVEL),
    socketMode: true,
});

const web = new WebClient(process.env.SLACK_BOT_TOKEN, {
    logLevel: getLogLevel(process.env.LOG_LEVEL),
});

app.use(async ({ next }) => {
    await next!();
});

async function downloadFileFromSlack(url: string, filename: string) {
    const x = await fetch(url, {
        headers: new Headers({
            'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
        }),
    });

    const x_1 = await x.arrayBuffer();

    return await writeFile(filename, Buffer.from(x_1));
}

const fileSavePrefix = process.env.SLACK_FILE_SAVE_PREFIX;

(async () => {

    if (!process.env.DB_CONN_STRING) throw new Error('Env DB_CONN_STRING is required.');
    const client = new mongoDB.MongoClient(process.env.DB_CONN_STRING);
    await client.connect();

    const msgCollection = getMessageCollection(client.db());
    const changedMsgCollection = getChangedMsgCollection(client.db());

    // Start your app
    await app.start();

    app.message('', async ({ message }) => {
        await msgCollection.insertOne(message);

        if (message.subtype === 'file_share' && message.files && fileSavePrefix) {
            await Promise.all(message.files.map(async (v) => {
                if (v.url_private_download) {
                    const dirPath = `${fileSavePrefix}/${message.user}/${v.id}`;
                    await mkdir(dirPath, { recursive: true });

                    const filePath = `${dirPath}/${v.name}`;
                    await downloadFileFromSlack(v.url_private_download, filePath);

                    console.log(`saving file ${v.permalink} to ${filePath}`);
                }
            }));
        }
    });

    app.message(subtype('message_changed'), async ({ event }) => {
        await changedMsgCollection.insertOne(event);
    });


    app.message('hello', async ({ message, say }) => {
        if (message.channel_type === 'im' && isGenericMessageEvent(message)) {
            await say({
                blocks: [
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": `早安 <@${message.user}>!`
                        },
                        "accessory": {
                            "type": "button",
                            "text": {
                                "type": "plain_text",
                                "text": "趕快點我"
                            },
                            "action_id": "button_click"
                        }
                    }
                ],
                text: `早安 <@${message.user}>!`,
            });
        }
    });

    app.action('button_click', async ({ body, ack, say }) => {
        // Acknowledge the action
        await ack();
        await say(`<@${body.user.id}> 點了按鈕`);
    });

    await fetch_history(web, 'CC2LH7T1N', async (messages) => {
        const coll = getMessageCollection(client.db());
        await Promise.all(messages.map(async (v) => {
            const r = await coll.findOne({ channel: v.channel, ts: v.ts });
            if (!r) {
                console.log(`creating ${v.ts} @ ${v.channel}: ${(v as any).text ?? 'n/a'}`);
                await coll.insertOne(v);
            } else {
                await coll.updateOne({ _id: r._id }, {
                    $set: v,
                });
            }
        }));
    });

    console.log('⚡️ Bolt app is running!');
})();