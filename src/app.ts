import { loadConfig } from './config';
import { connectDb } from './db';
import { App } from '@slack/bolt';
import { google } from 'googleapis';
import { SlackStorageModule } from './modules/slack-storage';
import { AppHomeModule } from './modules/app-home';
import { ReactionCheckModule } from './modules/reaction-check';
import { GoogleDriveCheckModule } from './modules/google-drive/handler';
import { createWebServer } from './web/server';
import { WebhookRelayModule } from './modules/webhook-relay';

(async () => {
    const config = loadConfig();

    const { client: dbClient, collections } = await connectDb(config.db.connString);

    const app = new App({
        token: config.slack.botToken,
        signingSecret: config.slack.signingSecret,
        appToken: config.slack.appToken,
        logLevel: config.slack.logLevel,
        socketMode: true,
        ignoreSelf: false,
    });

    app.use(async ({ next }) => { await next!(); });

    await app.start();

    const slackStorageModule = new SlackStorageModule(
        app,
        collections.messages,
        collections.changedMessages,
        collections.deletedMessages,
        config.app.fileSavePrefix,
        config.slack.userToken,
        { autoJoinChannels: config.app.autoJoinChannels },
    );
    await slackStorageModule.init();

    const appHomeModule = new AppHomeModule(app);
    await appHomeModule.init();

    let webhookRelayModule: WebhookRelayModule | undefined;
    if (config.webhookRelay.enabled) {
        const { port, publicBaseUrl } = config.webhookRelay;
        webhookRelayModule = new WebhookRelayModule(
            collections.webhooks,
            collections.messages,
            { botToken: config.slack.botToken, port, publicBaseUrl },
        );
        await webhookRelayModule.init(app, appHomeModule);
        console.log(`Webhook relay listening on port ${port}`);
    }

    if (config.features.useReactionCheck) {
        const reactionCheckModule = new ReactionCheckModule(app, config.features.reactionUserIgnoreList);
        await reactionCheckModule.init();
    }

    if (config.features.useGoogleDriveCheck) {
        const auth = new google.auth.GoogleAuth({
            keyFile: config.features.googleServiceAccountKeyFile,
            credentials: config.features.googleServiceAccountKeyJson
                ? JSON.parse(config.features.googleServiceAccountKeyJson)
                : undefined,
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        });
        const driveClient = google.drive({ version: 'v3', auth });

        const gdCheckModule = new GoogleDriveCheckModule(
            app,
            driveClient,
            collections.driveComplianceJobs,
            {
                allowedSharedDriveIds: config.features.googleDriveAllowedSharedDriveIds,
                allowedFolderIds: config.features.googleDriveAllowedFolderIds,
                allowDomainSharing: config.features.googleDriveAllowDomainSharing,
                maxParentTraversalDepth: config.features.googleDriveMaxParentTraversalDepth,
            },
            config.features.googleDriveReportOnlyViolations,
            config.features.googleDriveAuditChannel,
        );
        await gdCheckModule.init();
    }

    const httpServer = config.api.enabled
        ? await createWebServer(config.api, collections)
        : undefined;

    console.log('⚡️ Bolt app is running!');

    const shutdown = async () => {
        console.log('Shutting down...');
        httpServer?.close();
        await webhookRelayModule?.stop();
        await app.stop();
        await dbClient.close();
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
})();
