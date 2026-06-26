import express, { Router } from 'express';
import * as http from 'http';
import type { Config } from '../config';
import type { DbCollections } from '../db';
import type { SettingsStore } from '../modules/settings/store';
import { requireApiKey } from './middleware/auth';
import { createMessagesRouter } from './routes/messages';
import { createDriveRouter } from './routes/drive';
import { createSettingsRouter } from './routes/settings';

export function createWebServer(
    config: Config,
    collections: DbCollections,
    store: SettingsStore,
): http.Server {
    const app = express();
    app.use(express.json());

    const api = Router();
    api.use(requireApiKey(config.api.apiKey));
    api.use('/messages', createMessagesRouter(collections));
    api.use('/drive', createDriveRouter(collections));
    api.use('/settings', createSettingsRouter(store));

    app.use('/api', api);

    return app.listen(config.api.port, () => {
        console.log(`Web server listening on port ${config.api.port}`);
    });
}
