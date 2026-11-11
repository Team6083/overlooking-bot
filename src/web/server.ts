import express, { Router } from 'express';
import * as http from 'http';
import type { DbCollections } from '../db';
import type { SettingsStore } from '../modules/settings/store';
import { requireApiKey } from './middleware/auth';
import { createMessagesRouter } from './routes/messages';
import { createDriveRouter } from './routes/drive';
import { createSettingsRouter } from './routes/settings';

/** Starts the REST API; rejects (e.g. on EADDRINUSE) instead of crashing the process later. */
export async function createWebServer(
    api: { port: number; apiKey: string },
    collections: DbCollections,
    store: SettingsStore,
    options: { driveCredentialsConfigured: boolean },
): Promise<http.Server> {
    const app = express();
    app.use(express.json());

    const router = Router();
    router.use(requireApiKey(api.apiKey));
    router.use('/messages', createMessagesRouter(collections));
    router.use('/drive', createDriveRouter(collections));
    router.use('/settings', createSettingsRouter(store, options));

    app.use('/api', router);

    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(api.port, () => resolve());
    });
    server.on('error', (err) => console.error('Web server error:', err));
    console.log(`Web server listening on port ${api.port}`);
    return server;
}
