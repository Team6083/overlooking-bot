import { config } from 'dotenv';
config();
import { App } from '@slack/bolt';
import * as mongoDB from 'mongodb';
import { getBoltLogLevel } from './utils/slack';
import { SlackStorageModule } from './slack-storage';
import { AppHomeModule } from './app-home';

import 'dotenv/config'
import { ReactionCheckModule } from './reaction-check';
import { GoogleDriveCheckModule } from './google-drive-check';
import { google } from 'googleapis';
import { WebhookRelayModule } from './webhook-relay';
import { WebhookDoc } from './webhook-relay/store';

(async () => {

    if (!process.env.DB_CONN_STRING) throw new Error('Env DB_CONN_STRING is required.');
    const client = new mongoDB.MongoClient(process.env.DB_CONN_STRING);
    await client.connect();

    const msgCollection = client.db().collection('messages');
    const changedMsgCollection = client.db().collection('changedMessages');
    const deletedMsgCollection = client.db().collection('deletedMessages');
    const driveJobCollection = client.db().collection('driveComplianceJobs');
    const webhookCollection = client.db().collection<WebhookDoc>('webhooks');

    // The webhook relay adds an HTTP route, which Bolt only accepts at construction time.
    const useWebhookRelay = process.env.USE_WEBHOOK_RELAY === 'true';
    let webhookRelayModule: WebhookRelayModule | undefined;
    let webhookPort: number | undefined;
    if (useWebhookRelay) {
        const botToken = process.env.SLACK_BOT_TOKEN;
        if (!botToken) throw new Error('Env SLACK_BOT_TOKEN is required.');
        const publicBaseUrl = process.env.WEBHOOK_PUBLIC_BASE_URL;
        if (!publicBaseUrl) throw new Error('Env WEBHOOK_PUBLIC_BASE_URL is required when USE_WEBHOOK_RELAY=true.');
        webhookPort = Number(process.env.WEBHOOK_PORT ?? 3000);
        if (!Number.isInteger(webhookPort) || webhookPort <= 0) throw new Error('Env WEBHOOK_PORT must be a port number.');

        webhookRelayModule = new WebhookRelayModule(webhookCollection, msgCollection, { botToken, publicBaseUrl });
    }

    const app = new App({
        token: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        appToken: process.env.SLACK_APP_TOKEN,
        logLevel: getBoltLogLevel(process.env.LOG_LEVEL),
        socketMode: true,
        ignoreSelf: false,
        customRoutes: webhookRelayModule?.routes(),
        installerOptions: webhookPort ? { port: webhookPort } : undefined,
    });

    const fileSavePrefix = process.env.SLACK_FILE_SAVE_PREFIX;
    if (!fileSavePrefix) throw new Error('Env SLACK_FILE_SAVE_PREFIX is required.');

    const slackUserToken = process.env.SLACK_USER_TOKEN
    if (!slackUserToken) throw new Error('Env SLACK_USER_TOKEN is required.');

    const useReactionCheck = process.env.USE_REACTION_CHECK === 'true';

    // Start your app
    await app.start();

    const autoJoinChannels = process.env.AUTO_JOIN_CHANNELS === 'true';

    const slackStorageModule = new SlackStorageModule(
        app,
        msgCollection,
        changedMsgCollection,
        deletedMsgCollection,
        fileSavePrefix,
        slackUserToken,
        {
            autoJoinChannels,
        }
    );
    await slackStorageModule.init();

    const appHomeModule = new AppHomeModule(app);
    await appHomeModule.init();

    if (webhookRelayModule) {
        await webhookRelayModule.init(app, appHomeModule);
        console.log(`Webhook relay listening on port ${webhookPort}`);
    }

    if (useReactionCheck) {
        let ignoredUsers: string[] = [];
        if (process.env.REACTION_USER_IGN_LIST) {
            ignoredUsers = process.env.REACTION_USER_IGN_LIST.split(',');
        }

        const reactionCheckModule = new ReactionCheckModule(app, ignoredUsers);
        await reactionCheckModule.init();
    }

    const useGoogleDriveCheck = process.env.USE_GOOGLE_DRIVE_CHECK === 'true';
    if (useGoogleDriveCheck) {
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
            throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_KEY_JSON is required when USE_GOOGLE_DRIVE_CHECK=true.');
        }

        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
            credentials: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
                ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON)
                : undefined,
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        });
        const driveClient = google.drive({ version: 'v3', auth });

        const gdCheckModule = new GoogleDriveCheckModule(
            app,
            driveClient,
            driveJobCollection,
            {
                allowedSharedDriveIds: (process.env.GOOGLE_DRIVE_ALLOWED_SHARED_DRIVE_IDS || '').split(',').filter(Boolean),
                allowedFolderIds: (process.env.GOOGLE_DRIVE_ALLOWED_FOLDER_IDS || '').split(',').filter(Boolean),
                allowDomainSharing: process.env.GOOGLE_DRIVE_ALLOW_DOMAIN_SHARING === 'true',
                maxParentTraversalDepth: 10,
            },
            process.env.GOOGLE_DRIVE_REPORT_ONLY_VIOLATIONS !== 'false',
            process.env.GOOGLE_DRIVE_AUDIT_CHANNEL || undefined,
        );
        await gdCheckModule.init();
    }

    console.log('⚡️ Bolt app is running!');

    const shutdown = async () => {
        console.log('Shutting down...');
        await app.stop();
        await client.close();
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
})();