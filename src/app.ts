import { config } from 'dotenv';
config();
import { App } from '@slack/bolt';
import * as mongoDB from 'mongodb';
import { getBoltLogLevel } from './utils/slack';
import { SlackStorageModule } from './slack-storage';
import { AppHomeModule } from './app-home';

import 'dotenv/config'
import { ReactionCheckModule } from './reaction-check';

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN,
    logLevel: getBoltLogLevel(process.env.LOG_LEVEL),
    socketMode: true,
    ignoreSelf: false,
});

app.use(async ({ next }) => {
    await next!();
});

(async () => {

    if (!process.env.DB_CONN_STRING) throw new Error('Env DB_CONN_STRING is required.');
    const client = new mongoDB.MongoClient(process.env.DB_CONN_STRING);
    await client.connect();

    const msgCollection = client.db().collection('messages');
    const changedMsgCollection = client.db().collection('changedMessages');
    const deletedMsgCollection = client.db().collection('deletedMessages');

    const fileSavePrefix = process.env.SLACK_FILE_SAVE_PREFIX;
    if (!fileSavePrefix) throw new Error('Env SLACK_FILE_SAVE_PREFIX is required.');

    const slackUserToken = process.env.SLACK_USER_TOKEN
    if (!slackUserToken) throw new Error('Env SLACK_USER_TOKEN is required.');

    // Start your app
    await app.start();

    const slackStorageModule = new SlackStorageModule(
        app,
        msgCollection,
        changedMsgCollection,
        deletedMsgCollection,
        fileSavePrefix,
        slackUserToken,
    );
    await slackStorageModule.init();

    const appHomeModule = new AppHomeModule(app);
    await appHomeModule.init();

    let ignoredUsers: string[] = [];
    if (process.env.REACTION_USER_IGN_LIST) {
        ignoredUsers = process.env.REACTION_USER_IGN_LIST.split(',');
    }
    const reactionCheckModule = new ReactionCheckModule(app, ignoredUsers);
    await reactionCheckModule.init();

    console.log('⚡️ Bolt app is running!');
})();