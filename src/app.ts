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
import { WebhookRelayModule } from './modules/webhook-relay';

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

    const settings = settingsStore.get();
    const driveCredentialsConfigured = Boolean(
        config.features.googleServiceAccountKeyFile || config.features.googleServiceAccountKeyJson,
    );

    const slackStorageModule = new SlackStorageModule(
        app,
        collections.messages,
        collections.changedMessages,
        collections.deletedMessages,
        config.app.fileSavePrefix,
        config.slack.userToken,
        { autoJoinChannels: settings.autoJoinChannels },
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

    if (settings.useReactionCheck) {
        const reactionCheckModule = new ReactionCheckModule(app, settings.reactionUserIgnoreList);
        await reactionCheckModule.init();
    }

    if (settings.useGoogleDriveCheck) {
        // The flag may have been enabled through the API, so recheck the credentials here.
        if (!driveCredentialsConfigured) {
            throw new Error('useGoogleDriveCheck is on but GOOGLE_SERVICE_ACCOUNT_KEY_FILE / GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not set.');
        }
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
                allowedSharedDriveIds: settings.googleDriveAllowedSharedDriveIds,
                allowedFolderIds: settings.googleDriveAllowedFolderIds,
                allowDomainSharing: config.features.googleDriveAllowDomainSharing,
                maxParentTraversalDepth: config.features.googleDriveMaxParentTraversalDepth,
            },
            settings.googleDriveReportOnlyViolations,
            settings.googleDriveAuditChannel,
        );
        await gdCheckModule.init();
    }

    const httpServer = config.api.enabled
        ? await createWebServer(config.api, collections, settingsStore, { driveCredentialsConfigured })
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
