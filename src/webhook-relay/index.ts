import { createServer, type Server } from 'http';
import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type { Collection, Document } from 'mongodb';
import { AppHomeModule } from '../app-home';
import { WebhookAdmin } from './admin';
import { WebhookHttpHandler } from './http';
import { WebhookDoc, WebhookStore } from './store';

export type WebhookRelayOptions = {
    botToken: string;
    port: number;
    /** Public HTTPS base URL that reaches WEBHOOK_PORT, used to show full webhook URLs. */
    publicBaseUrl: string;
};

/**
 * Stand-in for Slack incoming webhooks: external systems POST Slack-webhook payloads here and the
 * bot posts them, so they do not use up app slots. Owners manage webhooks from the App Home.
 *
 * It runs its own Node HTTP server rather than Bolt's customRoutes: Bolt URL-decodes route params
 * outside any try/catch, so one malformed request would crash the whole bot.
 */
export class WebhookRelayModule {
    private store: WebhookStore;
    private handler: WebhookHttpHandler;
    private server?: Server;

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
        this.handler = new WebhookHttpHandler(this.store, postClient, msgCollection);
    }

    async init(app: App, appHome: AppHomeModule) {
        const admin = new WebhookAdmin(app, this.store, this.options.publicBaseUrl, (client, userId) => appHome.publish(client, userId));
        admin.init();
        appHome.addSection((client, userId) => admin.renderSection(client, userId));

        this.server = createServer((req, res) => { void this.handler.route(req, res); });
        // Bound slow or stalled clients.
        this.server.requestTimeout = 30_000;
        this.server.headersTimeout = 10_000;
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(this.options.port, () => resolve());
        });
    }

    async stop() {
        await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    }
}
