import { loadConfig } from './config';
import { connectDb } from './db';
import { App } from '@slack/bolt';
import { google } from 'googleapis';
import { SlackStorageModule } from './modules/slack-storage';
import { AppHomeModule } from './modules/app-home';
import { ReactionCheckModule } from './modules/reaction-check';
import { GoogleDriveCheckModule } from './modules/google-drive/handler';
import { SettingsStore } from './modules/settings/store';
import { createWebServer } from './web/server';

(async () => {
    const config = loadConfig();

    const { client: dbClient, collections } = await connectDb(config.db.connString);

    const settingsStore = new SettingsStore(collections.settings);
    await settingsStore.load({
        useReactionCheck: config.features.useReactionCheck,
        useGoogleDriveCheck: config.features.useGoogleDriveCheck,
        autoJoinChannels: config.app.autoJoinChannels,
        reactionUserIgnoreList: config.features.reactionUserIgnoreList,
        googleDriveReportOnlyViolations: config.features.googleDriveReportOnlyViolations,
        googleDriveAuditChannel: config.features.googleDriveAuditChannel,
        googleDriveAllowedSharedDriveIds: config.features.googleDriveAllowedSharedDriveIds,
        googleDriveAllowedFolderIds: config.features.googleDriveAllowedFolderIds,
    });

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

    const settings = settingsStore.get();

    if (settings.useReactionCheck) {
        const reactionCheckModule = new ReactionCheckModule(app, settings.reactionUserIgnoreList);
        await reactionCheckModule.init();
    }

    if (settings.useGoogleDriveCheck) {
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

    const httpServer = createWebServer(config, collections, settingsStore);

    console.log('⚡️ Bolt app is running!');

    const shutdown = async () => {
        console.log('Shutting down...');
        httpServer.close();
        await app.stop();
        await dbClient.close();
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
})();
