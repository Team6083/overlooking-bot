import { config } from 'dotenv';
config();

import { App } from '@slack/bolt';
import * as mongoDB from 'mongodb';
import express from 'express';
import { ExpressAdapter } from '@bull-board/express';

import { getBoltLogLevel } from './utils/slack';
import { SlackStorageModule } from './slack-storage';
import { AppHomeModule } from './app-home';
import { ReactionCheckModule } from './reaction-check';
import { MongoDBSlackStorageRepository } from './message-repository/mongo-repo';
import { ConversationFetchService } from './conversation-fetch';

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN,
    logLevel: getBoltLogLevel(process.env.LOG_LEVEL),
    socketMode: true,
    ignoreSelf: false,
});

app.use(async ({ next }) => {
    await next();
});

(async () => {

    if (!process.env.DB_CONN_STRING) throw new Error('Env DB_CONN_STRING is required.');
    const client = new mongoDB.MongoClient(process.env.DB_CONN_STRING);
    await client.connect();

    if (!process.env.REDIS_CONN_STRING) throw new Error('Env REDIS_CONN_STRING is required.');
    const redisUrl = process.env.REDIS_CONN_STRING;

    const fileSavePrefix = process.env.SLACK_FILE_SAVE_PREFIX;
    if (!fileSavePrefix) throw new Error('Env SLACK_FILE_SAVE_PREFIX is required.');

    const msgCollection = client.db().collection('messages');
    const changedMsgCollection = client.db().collection('changedMessages');
    const deletedMsgCollection = client.db().collection('deletedMessages');
    const fileMetadataCollection = client.db().collection('file_metadata');

    const slackStorageRepo = new MongoDBSlackStorageRepository(
        msgCollection,
        changedMsgCollection,
        deletedMsgCollection,
        fileMetadataCollection,
        fileSavePrefix,
    );

    const slackUserToken = process.env.SLACK_USER_TOKEN
    if (!slackUserToken) throw new Error('Env SLACK_USER_TOKEN is required.');

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');

    const conversationFetchService = new ConversationFetchService(app.client, redisUrl, serverAdapter);

    // Start your app
    await app.start();

    const slackStorageModule = new SlackStorageModule(
        app,
        slackStorageRepo,
        conversationFetchService,
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

    const expressApp = express();
    expressApp.use('/admin/queues', serverAdapter.getRouter());

    expressApp.listen(3000, () => {
        console.log('Bull Board is running');
    });
})();