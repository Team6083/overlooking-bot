import { Router } from 'express';
import type { SettingsStore } from '../../modules/settings/store';
import type { PatchSettingsBody, BotSettings } from '../types';

const ALLOWED_KEYS: Array<keyof PatchSettingsBody> = [
    'useReactionCheck',
    'useGoogleDriveCheck',
    'autoJoinChannels',
    'reactionUserIgnoreList',
    'googleDriveReportOnlyViolations',
    'googleDriveAuditChannel',
    'googleDriveAllowedSharedDriveIds',
    'googleDriveAllowedFolderIds',
];

export function createSettingsRouter(store: SettingsStore): Router {
    const router = Router();

    router.get('/', (_req, res) => {
        res.json(store.get());
    });

    router.patch('/', async (req, res) => {
        const body = req.body as Record<string, unknown>;
        const unknownKeys = Object.keys(body).filter(k => !ALLOWED_KEYS.includes(k as any));
        if (unknownKeys.length > 0) {
            res.status(400).json({ error: `unknown fields: ${unknownKeys.join(', ')}` });
            return;
        }

        const update: PatchSettingsBody = {};
        for (const key of ALLOWED_KEYS) {
            if (key in body) {
                (update as any)[key] = body[key];
            }
        }

        const updated = await store.patch(update);
        res.json(updated);
    });

    return router;
}
