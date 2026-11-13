/**
 * Request and response schemas of the REST API. They validate requests at runtime and are the
 * single source api/openapi.yaml is generated from (`npm run openapi`).
 */
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

const limit = z.coerce
    .number({ error: 'must be a positive integer' })
    .int('must be a positive integer')
    .min(1, 'must be a positive integer')
    .default(DEFAULT_LIMIT)
    .transform((n) => Math.min(n, MAX_LIMIT))
    .openapi({
        type: 'integer',
        minimum: 1,
        default: DEFAULT_LIMIT,
        description: `Page size. Default ${DEFAULT_LIMIT}; values above ${MAX_LIMIT} are clamped to ${MAX_LIMIT}.`,
    });

const cursor = z.string().optional().openapi({
    description: 'Opaque cursor from the previous page\'s `nextCursor`.',
});

export const MESSAGE_COLLECTIONS = ['messages', 'changed_messages', 'deleted_messages'] as const;
export type MessageCollectionName = typeof MESSAGE_COLLECTIONS[number];

const collection = z.enum(MESSAGE_COLLECTIONS).default('messages').openapi({
    description: '`messages`: every message received; `changed_messages`: edits; `deleted_messages`: deletions.',
});

export const DRIVE_JOB_STATUSES = ['pending', 'completed', 'error'] as const;

export const ObjectIdParam = z.object({
    id: z.string().regex(/^[0-9a-f]{24}$/, 'must be a 24-character hex id').openapi({ param: { name: 'id', in: 'path' } }),
});

export const ListMessagesQuery = z.object({ collection, limit, cursor });
export const GetMessageQuery = z.object({ collection });
export const COMPLIANCE_STATUSES = ['compliant', 'violations', 'cannot_check', 'not_accessible'] as const;

export const ListDriveJobsQuery = z.object({
    status: z.enum(DRIVE_JOB_STATUSES).optional(),
    complianceStatus: z.enum(COMPLIANCE_STATUSES).optional().openapi({ description: 'Filter on the latest check result (`result.status`).' }),
    limit,
    cursor,
});

export const ErrorResponse = z.object({
    error: z.object({
        code: z.string().openapi({ example: 'invalid_request' }),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
    }),
}).openapi('ErrorResponse');

const SlackFile = z.object({
    id: z.string(),
    name: z.string().optional(),
    mimetype: z.string().optional(),
    size: z.number().int().optional(),
}).openapi('SlackFile');

export const MessageRecord = z.object({
    id: z.string(),
    channel: z.string(),
    ts: z.string().openapi({ description: 'Slack ts of this record: the message, or the edit/deletion event.' }),
    messageTs: z.string().optional().openapi({ description: 'For edits and deletions: ts of the message that changed.' }),
    threadTs: z.string().optional(),
    user: z.string().optional(),
    botId: z.string().optional(),
    subtype: z.string().optional(),
    text: z.string().optional().openapi({ description: 'Message text; for edits, the new text.' }),
    previousText: z.string().optional().openapi({ description: 'For edits and deletions: text before the change.' }),
    files: z.array(SlackFile).optional(),
    webhook: z.object({ id: z.string(), name: z.string() }).optional().openapi({
        description: 'Set when the message was posted through the webhook relay.',
    }),
    slackEvent: z.record(z.string(), z.unknown()).openapi({
        description: 'The Slack event as stored, unchanged. Its fields keep Slack\'s own snake_case names.',
    }),
}).openapi('MessageRecord');

const ComplianceViolation = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('public_access'), allowFileDiscovery: z.boolean() }),
    z.object({ kind: z.literal('domain_sharing') }),
    z.object({ kind: z.literal('wrong_location') }),
]).openapi('ComplianceViolation');

const ComplianceResult = z.object({
    fileId: z.string(),
    url: z.string(),
    status: z.enum(COMPLIANCE_STATUSES),
    fileName: z.string().optional(),
    violations: z.array(ComplianceViolation),
    errorMessage: z.string().optional(),
}).openapi('ComplianceResult');

const DriveCheckHistoryEntry = z.object({
    checkedAt: z.iso.datetime(),
    checkedBy: z.string().openapi({ description: 'Slack user id of whoever triggered the check, or `system` for the initial check.' }),
    status: z.enum(COMPLIANCE_STATUSES),
    violations: z.array(ComplianceViolation),
}).openapi('DriveCheckHistoryEntry');

export const DriveJob = z.object({
    id: z.string(),
    fileId: z.string(),
    url: z.string(),
    channel: z.string(),
    messageTs: z.string().openapi({ description: 'ts of the message that contained the link.' }),
    status: z.enum(DRIVE_JOB_STATUSES),
    requestedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    result: ComplianceResult.optional(),
    user: z.string().optional().openapi({ description: 'Slack user id of whoever posted the link.' }),
    auditMessage: z.object({ channel: z.string(), ts: z.string() }).optional()
        .openapi({ description: 'The audit channel message that reported this check.' }),
    lastCheckedAt: z.iso.datetime().optional(),
    checkCount: z.number().int().optional().openapi({ description: 'How many times the file was checked, the initial check included.' }),
    history: z.array(DriveCheckHistoryEntry).optional().openapi({ description: 'Every check, oldest first.' }),
    resolvedAt: z.iso.datetime().optional().openapi({ description: 'When the result turned compliant after a non-compliant one; absent while non-compliant.' }),
}).openapi('DriveJob');

export function page<T extends z.ZodType>(item: T, name: string) {
    return z.object({
        items: z.array(item),
        nextCursor: z.string().nullable().openapi({ description: 'Cursor for the next page; null on the last page.' }),
    }).openapi(name);
}

export const MessagePage = page(MessageRecord, 'MessagePage');
export const DriveJobPage = page(DriveJob, 'DriveJobPage');
