import { Collection } from 'mongodb';

export interface BotSettings {
    useReactionCheck: boolean;
    useGoogleDriveCheck: boolean;
    autoJoinChannels: boolean;
    reactionUserIgnoreList: string[];
    googleDriveReportOnlyViolations: boolean;
    googleDriveAuditChannel?: string;
    googleDriveAllowedSharedDriveIds: string[];
    googleDriveAllowedFolderIds: string[];
    updatedAt: Date;
}

export type PatchSettingsBody = Partial<Omit<BotSettings, 'updatedAt'>>;

const SETTINGS_DOC_ID = 'main';

export class SettingsStore {
    private cache?: BotSettings;

    constructor(private col: Collection) {}

    /**
     * Precedence: the env-derived `defaults` only seed fields the stored document lacks (first boot,
     * or a field added in a later release). Once a field is stored, the DB value wins, so later env
     * changes to it have no effect; change it with PATCH /api/settings instead. Modules read
     * settings at startup, so a PATCH takes effect on the next restart.
     */
    async load(defaults: Omit<BotSettings, 'updatedAt'>): Promise<BotSettings> {
        const existing = await this.col.findOne<BotSettings>({ _id: SETTINGS_DOC_ID as any });
        if (existing) {
            const missing = Object.fromEntries(
                Object.entries(defaults).filter(([k, v]) => v !== undefined && !(k in existing)),
            );
            if (Object.keys(missing).length > 0) {
                await this.col.updateOne({ _id: SETTINGS_DOC_ID as any }, { $set: missing });
            }
            this.cache = { ...existing, ...missing };
        } else {
            const initial: BotSettings = { ...defaults, updatedAt: new Date() };
            await this.col.insertOne({ _id: SETTINGS_DOC_ID as any, ...initial });
            this.cache = initial;
        }
        return this.cache;
    }

    get(): BotSettings {
        if (!this.cache) throw new Error('SettingsStore not loaded. Call load() first.');
        return this.cache;
    }

    async patch(update: PatchSettingsBody): Promise<BotSettings> {
        const now = new Date();
        await this.col.updateOne(
            { _id: SETTINGS_DOC_ID as any },
            { $set: { ...update, updatedAt: now } },
        );
        this.cache = { ...this.get(), ...update, updatedAt: now };
        return this.cache;
    }
}
