import { config } from 'dotenv';
config();
import { App, ignoreSelf, KnownEventFromType, LogLevel, subtype } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import * as mongoDB from 'mongodb';
import { writeFile, mkdir } from 'fs/promises';
import fetch, { Headers } from 'node-fetch';

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
    ignoreSelf: false,
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

    const msgCollection = client.db().collection('messages');
    const changedMsgCollection = client.db().collection('changedMessages');
    const deletedMsgCollection = client.db().collection('deletedMessages');

    // Start your app
    await app.start();

    // process self channel join and apply ignore self
    app.use(async (args) => {

        if (args.payload.type === 'message') {
            const payload = args.payload as KnownEventFromType<'message'>
            
            // delete join message
            if (payload.subtype === 'channel_join' && payload.user === args.context.botUserId) {
                await args.client.chat.delete({
                    token: process.env.SLACK_USER_TOKEN,
                    channel: payload.channel,
                    ts: payload.ts,
                });
            }
        }

        await ignoreSelf()(args);
    });

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

    app.message(subtype('message_deleted'), async ({ event }) => {
        await deletedMsgCollection.insertOne(event);
    });

    console.log('⚡️ Bolt app is running!');
})();