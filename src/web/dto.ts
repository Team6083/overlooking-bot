import type { Document } from 'mongodb';
import type { z } from 'zod';
import type { DriveJob, MessageCollectionName, MessageRecord } from './schemas';

type Doc = Document & Record<string, any>;

function str(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}

function iso(v: unknown): string | undefined {
    return v instanceof Date ? v.toISOString() : undefined;
}

/** The stored Slack event without our own bookkeeping fields. */
function slackEvent(doc: Doc): Record<string, unknown> {
    const { _id, overlooking_webhook, ...event } = doc;
    return event;
}

export function toMessageRecord(doc: Doc, collection: MessageCollectionName): z.infer<typeof MessageRecord> {
    const base = { id: String(doc._id), channel: String(doc.channel ?? ''), slackEvent: slackEvent(doc) };

    if (collection === 'changed_messages') {
        const msg: Doc = doc.message ?? {};
        return {
            ...base,
            ts: String(doc.ts ?? ''),
            messageTs: str(msg.ts),
            threadTs: str(msg.thread_ts),
            user: str(msg.user),
            subtype: str(doc.subtype),
            text: str(msg.text),
            previousText: str(doc.previous_message?.text),
        };
    }

    if (collection === 'deleted_messages') {
        return {
            ...base,
            ts: String(doc.ts ?? ''),
            messageTs: str(doc.deleted_ts),
            threadTs: str(doc.previous_message?.thread_ts),
            user: str(doc.previous_message?.user),
            subtype: str(doc.subtype),
            previousText: str(doc.previous_message?.text),
        };
    }

    const webhook = doc.overlooking_webhook;
    return {
        ...base,
        ts: String(doc.ts ?? ''),
        threadTs: str(doc.thread_ts),
        user: str(doc.user),
        botId: str(doc.bot_id),
        subtype: str(doc.subtype),
        text: str(doc.text),
        files: Array.isArray(doc.files)
            ? doc.files.map((f: Doc) => ({
                id: String(f.id),
                name: str(f.name),
                mimetype: str(f.mimetype),
                size: typeof f.size === 'number' ? f.size : undefined,
            }))
            : undefined,
        webhook: webhook ? { id: String(webhook.id), name: String(webhook.name) } : undefined,
    };
}

export function toDriveJob(doc: Doc): z.infer<typeof DriveJob> {
    return {
        id: String(doc._id),
        fileId: String(doc.fileId),
        url: String(doc.url),
        channel: String(doc.channel),
        messageTs: String(doc.thread_ts),
        status: doc.status,
        requestedAt: iso(doc.requestedAt) ?? '',
        completedAt: iso(doc.completedAt),
        result: doc.result,
        user: str(doc.user),
        auditMessage: doc.auditMessage && typeof doc.auditMessage === 'object'
            ? { channel: String(doc.auditMessage.channel), ts: String(doc.auditMessage.ts) }
            : undefined,
        lastCheckedAt: iso(doc.lastCheckedAt),
        checkCount: typeof doc.checkCount === 'number' ? doc.checkCount : undefined,
        history: Array.isArray(doc.history)
            ? doc.history.map((h: Doc) => ({
                checkedAt: iso(h.checkedAt) ?? '',
                checkedBy: String(h.checkedBy),
                status: h.status,
                violations: h.violations ?? [],
            }))
            : undefined,
        resolvedAt: iso(doc.resolvedAt),
    };
}
