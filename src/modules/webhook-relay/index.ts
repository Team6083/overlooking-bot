import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type { Collection, Document } from 'mongodb';
import { AppHomeModule } from '../app-home';
import { WebhookAdmin } from './admin';
import { WebhookHttpHandler } from './http';
import { WebhookDoc, WebhookStore } from './store';

export type WebhookRelayOptions = {
    botToken: string;
    /** Public HTTPS base URL that reaches the shared HTTP server, used to show full webhook URLs. */
    publicBaseUrl: string;
};

/**
 * Stand-in for Slack incoming webhooks: external systems POST Slack-webhook payloads here and the
 * bot posts them, so they do not use up app slots. Owners manage webhooks from the App Home.
 *
 * Requests arrive through the shared HTTP server (src/web/server.ts), which hands `/services/...`
 * to `httpHandler.route` untouched. It is not mounted on Bolt's customRoutes: Bolt URL-decodes
 * route params outside any try/catch, so one malformed request would crash the whole bot.
 */
export class WebhookRelayModule {
    private store: WebhookStore;
    readonly httpHandler: WebhookHttpHandler;

    constructor(
        webhookCollection: Collection<WebhookDoc>,
        msgCollection: Collection<Document>,
        private options: WebhookRelayOptions,
    ) {
        this.store = new WebhookStore(webhookCollection);
        // Separate client: no automatic retries, so rate limits reach the caller as 429s right away.
        const postClient = new WebClient(options.botToken, {
            retryConfig: { retries: 0 },
            rejectRateLimitedCalls: true,
        });
        this.httpHandler = new WebhookHttpHandler(this.store, postClient, msgCollection);
    }

    async init(app: App, appHome: AppHomeModule) {
        const admin = new WebhookAdmin(app, this.store, this.options.publicBaseUrl, (client, userId) => appHome.publish(client, userId));
        admin.init();
        appHome.addSection((client, userId) => admin.renderSection(client, userId));
    }
}
