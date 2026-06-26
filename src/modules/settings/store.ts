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

    async load(defaults: Omit<BotSettings, 'updatedAt'>): Promise<BotSettings> {
        const existing = await this.col.findOne<BotSettings>({ _id: SETTINGS_DOC_ID as any });
        if (existing) {
            this.cache = existing;
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
