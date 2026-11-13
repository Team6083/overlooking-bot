import { loadConfig } from './config';
import { connectDb } from './db';
import { App } from '@slack/bolt';
import { google } from 'googleapis';
import { SlackStorageModule } from './modules/slack-storage';
import { AppHomeModule } from './modules/app-home';
import { ReactionCheckModule } from './modules/reaction-check';
import { GoogleDriveCheckModule } from './modules/google-drive/handler';
import { GoogleDriveRecheckModule } from './modules/google-drive/recheck';
import { startHttpServer } from './web/server';
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
        webhookRelayModule = new WebhookRelayModule(
            collections.webhooks,
            collections.messages,
            { botToken: config.slack.botToken, publicBaseUrl: config.webhookRelay.publicBaseUrl },
        );
        await webhookRelayModule.init(app, appHomeModule);
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

        // Recheck only exists next to the audit channel's reports.
        if (config.features.googleDriveAuditChannel) {
            const recheckModule = new GoogleDriveRecheckModule(
                app,
                appHomeModule,
                driveClient,
                collections.driveComplianceJobs,
                {
                    allowedSharedDriveIds: config.features.googleDriveAllowedSharedDriveIds,
                    allowedFolderIds: config.features.googleDriveAllowedFolderIds,
                    allowDomainSharing: config.features.googleDriveAllowDomainSharing,
                    maxParentTraversalDepth: config.features.googleDriveMaxParentTraversalDepth,
                },
                config.features.googleDriveRecheckAllowed,
            );
            await recheckModule.init();
        }
    }

    // One HTTP server on LISTEN_ADDR for the REST API and the webhook relay; none when both are off.
    const httpServer = config.api.enabled || webhookRelayModule
        ? await startHttpServer(config.http, {
            build: config.build,
            api: config.api.enabled ? { apiKey: config.api.apiKey, collections } : undefined,
            webhook: webhookRelayModule?.httpHandler,
        })
        : undefined;
    if (httpServer) {
        const parts = [config.api.enabled && 'REST API (/api/v1)', webhookRelayModule && 'webhook relay (/services)'].filter(Boolean);
        console.log(`HTTP server listening on ${config.http.host ?? ''}:${config.http.port}: ${parts.join(', ')}`);
    }

    console.log('⚡️ Bolt app is running!');

    const shutdown = async () => {
        console.log('Shutting down...');
        await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
        await app.stop();
        await dbClient.close();
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
})();
