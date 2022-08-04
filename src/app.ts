import { config } from 'dotenv';
config();
import { App, LogLevel, subtype } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import * as mongoDB from 'mongodb';

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN,
    logLevel: LogLevel.DEBUG,
    socketMode: true,
});

const web = new WebClient(process.env.SLACK_BOT_TOKEN);

app.use(async ({ next }) => {
    await next!();
});

(async () => {
    if (!process.env.DB_CONN_STRING) throw new Error('Env DB_CONN_STRING is required.');
    const client = new mongoDB.MongoClient(process.env.DB_CONN_STRING);
    await client.connect();

    const msgCollection = client.db().collection('messages');
    const changedMsgCollection = client.db().collection('changedMessages');

    // Start your app
    await app.start();

    app.message('', async ({ message }) => {
        await msgCollection.insertOne(message);
    });

    app.message(subtype('message_changed'), async ({ event }) => {
        await changedMsgCollection.insertOne(event);
    });

    console.log('⚡️ Bolt app is running!');
})();