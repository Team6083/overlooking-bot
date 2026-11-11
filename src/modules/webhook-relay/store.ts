import { Collection } from 'mongodb';
import { generateSecret, generateWebhookId, hashSecret, WebhookConfig, WebhookIdentity } from './core';

export type WebhookDoc = WebhookConfig & {
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
    lastUsedAt?: Date;
    lastError?: { code: string; at: Date };
};

export type WebhookInput = {
    name: string;
    defaultChannel: string;
    allowedChannels: string[];
    defaultIdentity: WebhookIdentity;
    allowIdentityOverride: boolean;
};

export class WebhookStore {
    constructor(private collection: Collection<WebhookDoc>) { }

    get(id: string) {
        return this.collection.findOne({ _id: id });
    }

    list() {
        return this.collection.find({}).sort({ createdAt: 1 }).toArray();
    }

    /** Create a webhook and return it with its plaintext secret (shown once, never stored). */
    async create(input: WebhookInput, createdBy: string): Promise<{ doc: WebhookDoc; secret: string }> {
        const secret = generateSecret();
        const now = new Date();
        const doc: WebhookDoc = {
            _id: generateWebhookId(),
            ...input,
            secretHash: hashSecret(secret),
            enabled: true,
            createdBy,
            createdAt: now,
            updatedAt: now,
        };
        await this.collection.insertOne(doc);
        return { doc, secret };
    }

    async update(id: string, input: WebhookInput) {
        await this.collection.updateOne({ _id: id }, { $set: { ...input, updatedAt: new Date() } });
    }

    /** Replace the secret; the webhook ID and history stay. Returns the new plaintext secret. */
    async rotateSecret(id: string): Promise<string | null> {
        const secret = generateSecret();
        const res = await this.collection.updateOne(
            { _id: id },
            { $set: { secretHash: hashSecret(secret), updatedAt: new Date() } },
        );
        return res.matchedCount ? secret : null;
    }

    async setEnabled(id: string, enabled: boolean) {
        await this.collection.updateOne({ _id: id }, { $set: { enabled, updatedAt: new Date() } });
    }

    async delete(id: string) {
        await this.collection.deleteOne({ _id: id });
    }

    async recordSuccess(id: string) {
        await this.collection.updateOne({ _id: id }, { $set: { lastUsedAt: new Date() }, $unset: { lastError: '' } });
    }

    async recordError(id: string, code: string) {
        const now = new Date();
        await this.collection.updateOne({ _id: id }, { $set: { lastUsedAt: now, lastError: { code, at: now } } });
    }
}
