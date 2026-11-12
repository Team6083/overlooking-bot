import express, { ErrorRequestHandler, Router } from 'express';
import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ListenAddr } from '../config';
import type { DbCollections } from '../db';
import { sendError } from './errors';
import { requireApiKey } from './middleware/auth';
import { BuildInfo, requestContext, routeName } from './middleware/request-context';
import { createDriveRouter } from './routes/drive';
import { createMessagesRouter } from './routes/messages';

export type HttpServerOptions = {
    build: BuildInfo;
    /** REST API under /api/v1. */
    api?: { apiKey: string; collections: DbCollections };
    /** Webhook relay under /services/<id>/<secret>; gets the raw request (Slack-compatible responses, D27). */
    webhook?: { route(req: IncomingMessage, res: ServerResponse): Promise<void> };
};

export function createApiRouter(apiKey: string, collections: DbCollections): Router {
    const router = Router();
    router.use(requireApiKey(apiKey));
    router.use('/messages', createMessagesRouter(collections));
    router.use('/drive', createDriveRouter(collections));
    return router;
}

export function createHttpApp(options: HttpServerOptions): express.Express {
    const app = express();
    app.disable('x-powered-by');
    app.use(requestContext(options.build));

    if (options.webhook) {
        const webhook = options.webhook;
        // No body parser runs before this: the relay reads and limits the body itself.
        app.all(/^\/services\//, routeName('/services/:id/:secret'), (req, res) => webhook.route(req, res));
    }
    if (options.api) {
        app.use('/api/v1', createApiRouter(options.api.apiKey, options.api.collections));
    }

    app.use((_req, res) => sendError(res, 404, 'not_found', 'No such route'));

    const onError: ErrorRequestHandler = (err, _req, res, _next) => {
        console.error('HTTP request failed', err);
        if (res.headersSent) return;
        sendError(res, 500, 'internal_error', 'Internal server error');
    };
    app.use(onError);
    return app;
}

/** Starts the shared HTTP server; rejects on listen errors (e.g. EADDRINUSE) so startup fails. */
export async function startHttpServer(addr: ListenAddr, options: HttpServerOptions): Promise<http.Server> {
    const server = http.createServer(createHttpApp(options));
    server.headersTimeout = 10_000;   // ReadHeaderTimeout
    server.keepAliveTimeout = 120_000; // IdleTimeout
    server.requestTimeout = 30_000;   // bounds slow webhook bodies; no long downloads here

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(addr.port, addr.host, () => resolve());
    });
    server.on('error', (err) => console.error('HTTP server error:', err));
    return server;
}
