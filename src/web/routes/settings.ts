import { Router } from 'express';
import type { SettingsStore } from '../../modules/settings/store';
import type { PatchSettingsBody } from '../types';

type FieldKind = 'boolean' | 'string' | 'string[]';

const FIELDS: Record<keyof PatchSettingsBody, FieldKind> = {
    useReactionCheck: 'boolean',
    useGoogleDriveCheck: 'boolean',
    autoJoinChannels: 'boolean',
    reactionUserIgnoreList: 'string[]',
    googleDriveReportOnlyViolations: 'boolean',
    googleDriveAuditChannel: 'string',
    googleDriveAllowedSharedDriveIds: 'string[]',
    googleDriveAllowedFolderIds: 'string[]',
};

function matches(kind: FieldKind, value: unknown): boolean {
    switch (kind) {
        case 'boolean': return typeof value === 'boolean';
        case 'string': return typeof value === 'string';
        case 'string[]': return Array.isArray(value) && value.every(v => typeof v === 'string');
    }
}

export function createSettingsRouter(store: SettingsStore, options: { driveCredentialsConfigured: boolean }): Router {
    const router = Router();

    router.get('/', (_req, res) => {
        res.json(store.get());
    });

    router.patch('/', async (req, res) => {
        const body: unknown = req.body;
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            res.status(400).json({ error: 'body must be a JSON object (Content-Type: application/json)' });
            return;
        }

        const errors: string[] = [];
        const update: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(body)) {
            const kind = FIELDS[key as keyof PatchSettingsBody];
            if (!kind) errors.push(`unknown field: ${key}`);
            else if (!matches(kind, value)) errors.push(`${key} must be ${kind}`);
            else update[key] = value;
        }
        if (update.useGoogleDriveCheck === true && !options.driveCredentialsConfigured) {
            errors.push('useGoogleDriveCheck needs GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_KEY_JSON');
        }
        if (errors.length > 0) {
            res.status(400).json({ error: errors.join('; ') });
            return;
        }

        const updated = await store.patch(update as PatchSettingsBody);
        res.json(updated);
    });

    return router;
}
