// Pure logic for the webhook relay: no Slack, HTTP or MongoDB here, so it can be unit tested.
// Behaviour mirrors Slack's own incoming webhooks so callers cannot tell the difference.

import { createHash, timingSafeEqual } from 'crypto';
import { customAlphabet } from 'nanoid';

export type WebhookIdentity = {
    username?: string;
    iconEmoji?: string;
    iconUrl?: string;
};

export type WebhookConfig = {
    _id: string;
    name: string;
    secretHash: string;
    defaultChannel: string;
    allowedChannels: string[];
    defaultIdentity: WebhookIdentity;
    allowIdentityOverride: boolean;
    enabled: boolean;
};

export type WebhookResponse = {
    status: number;
    body: string;
    headers?: Record<string, string>;
};

/** Fields a caller may send, same as Slack incoming webhooks (legacy fields included). */
export type IncomingPayload = {
    text?: string;
    blocks?: unknown[];
    attachments?: unknown[];
    thread_ts?: string;
    mrkdwn?: boolean;
    unfurl_links?: boolean;
    unfurl_media?: boolean;
    link_names?: boolean | number;
    parse?: string;
    channel?: string;
    username?: string;
    icon_emoji?: string;
    icon_url?: string;
};

export const MAX_BODY_BYTES = 1024 * 1024;

export const OK: WebhookResponse = { status: 200, body: 'ok' };
export const NO_SERVICE: WebhookResponse = { status: 404, body: 'no_service' };
export const INVALID_PAYLOAD: WebhookResponse = { status: 400, body: 'invalid_payload' };
export const NO_TEXT: WebhookResponse = { status: 400, body: 'no_text' };
export const CHANNEL_NOT_FOUND: WebhookResponse = { status: 404, body: 'channel_not_found' };
export const PAYLOAD_TOO_LARGE: WebhookResponse = { status: 413, body: 'payload_too_large', headers: { Connection: 'close' } };
export const METHOD_NOT_ALLOWED: WebhookResponse = { status: 405, body: 'method_not_allowed', headers: { Allow: 'POST' } };

// ---------- secrets ----------

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const newIdRaw = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);
const newSecretRaw = customAlphabet(ALNUM, 32);

export function generateWebhookId(): string {
    return `W${newIdRaw()}`;
}

export function generateSecret(): string {
    return newSecretRaw();
}

export function hashSecret(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function verifySecret(secret: string, storedHash: string): boolean {
    const given = Buffer.from(hashSecret(secret), 'hex');
    const stored = Buffer.from(storedHash, 'hex');
    if (given.length !== stored.length) return false;
    return timingSafeEqual(given, stored);
}

export function buildWebhookUrl(baseUrl: string, id: string, secret: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/services/${id}/${secret}`;
}

// ---------- body parsing ----------

/**
 * Parse a request body the way Slack does: form-encoded `payload=<json>` or a raw JSON body.
 * Returns the payload, or an error response.
 */
export function parseBody(contentType: string | undefined, raw: string): IncomingPayload | WebhookResponse {
    let jsonText = raw;
    const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
    if (type === 'application/x-www-form-urlencoded') {
        const payload = new URLSearchParams(raw).get('payload');
        if (payload === null) return INVALID_PAYLOAD;
        jsonText = payload;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return INVALID_PAYLOAD;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return INVALID_PAYLOAD;

    const p = parsed as Record<string, unknown>;
    const isStr = (v: unknown) => v === undefined || typeof v === 'string';
    const isBool = (v: unknown) => v === undefined || typeof v === 'boolean';
    const isArr = (v: unknown) => v === undefined || Array.isArray(v);

    if (!isStr(p.text) || !isStr(p.thread_ts) || !isStr(p.parse) || !isStr(p.channel)
        || !isStr(p.username) || !isStr(p.icon_emoji) || !isStr(p.icon_url)) return INVALID_PAYLOAD;
    if (!isBool(p.mrkdwn) || !isBool(p.unfurl_links) || !isBool(p.unfurl_media)) return INVALID_PAYLOAD;
    if (!isArr(p.blocks) || !isArr(p.attachments)) return INVALID_PAYLOAD;
    if (p.link_names !== undefined && typeof p.link_names !== 'boolean' && typeof p.link_names !== 'number') return INVALID_PAYLOAD;

    return p as IncomingPayload;
}

export function isResponse(v: unknown): v is WebhookResponse {
    return typeof v === 'object' && v !== null && 'status' in v && 'body' in v;
}

// ---------- policy ----------

const CHANNEL_ID_RE = /^[CG][A-Z0-9]{6,}$/;

export function permittedChannels(webhook: Pick<WebhookConfig, 'defaultChannel' | 'allowedChannels'>): string[] {
    return Array.from(new Set([webhook.defaultChannel, ...webhook.allowedChannels]));
}

/** Whether resolving `requested` needs channel names (it is a #name rather than an ID). */
export function needsNameLookup(requested: string | undefined): boolean {
    if (!requested) return false;
    return !CHANNEL_ID_RE.test(requested.trim());
}

/**
 * Pick the target channel ID. `namesById` maps permitted channel IDs to their names and is only
 * needed when the caller asked for a channel by name. Anything outside the permitted set
 * (including DMs like "@user") is rejected.
 */
export function selectChannel(
    webhook: Pick<WebhookConfig, 'defaultChannel' | 'allowedChannels'>,
    requested: string | undefined,
    namesById: Record<string, string | undefined> = {},
): string | WebhookResponse {
    const permitted = permittedChannels(webhook);
    const req = requested?.trim();
    if (!req) return webhook.defaultChannel;

    if (CHANNEL_ID_RE.test(req)) {
        return permitted.includes(req) ? req : CHANNEL_NOT_FOUND;
    }
    if (req.startsWith('@')) return CHANNEL_NOT_FOUND;

    const name = req.replace(/^#/, '').toLowerCase();
    const match = permitted.find((id) => namesById[id]?.toLowerCase() === name);
    return match ?? CHANNEL_NOT_FOUND;
}

/** Identity fields for chat.postMessage. Overrides are silently ignored unless allowed. */
export function selectIdentity(
    webhook: Pick<WebhookConfig, 'defaultIdentity' | 'allowIdentityOverride'>,
    payload: IncomingPayload,
): { username?: string; icon_emoji?: string; icon_url?: string } {
    const d = webhook.defaultIdentity;
    let username = d.username || undefined;
    let icon_emoji = d.iconEmoji || undefined;
    let icon_url = d.iconUrl || undefined;

    if (webhook.allowIdentityOverride) {
        if (payload.username) username = payload.username;
        if (payload.icon_emoji || payload.icon_url) {
            icon_emoji = payload.icon_emoji || undefined;
            icon_url = payload.icon_emoji ? undefined : payload.icon_url || undefined;
        }
    }
    // Slack prefers icon_emoji when both are given; send only one to be explicit.
    if (icon_emoji) icon_url = undefined;

    const out: { username?: string; icon_emoji?: string; icon_url?: string } = {};
    if (username) out.username = username;
    if (icon_emoji) out.icon_emoji = icon_emoji;
    if (icon_url) out.icon_url = icon_url;
    return out;
}

/** Build chat.postMessage arguments, or an error if the message has no content. */
export function buildPostArgs(
    webhook: Pick<WebhookConfig, 'defaultIdentity' | 'allowIdentityOverride'>,
    payload: IncomingPayload,
    channel: string,
): Record<string, unknown> | WebhookResponse {
    const hasText = typeof payload.text === 'string' && payload.text.length > 0;
    const hasBlocks = Array.isArray(payload.blocks) && payload.blocks.length > 0;
    const hasAttachments = Array.isArray(payload.attachments) && payload.attachments.length > 0;
    if (!hasText && !hasBlocks && !hasAttachments) return NO_TEXT;

    const args: Record<string, unknown> = { channel, ...selectIdentity(webhook, payload) };
    for (const key of ['text', 'blocks', 'attachments', 'thread_ts', 'mrkdwn', 'unfurl_links', 'unfurl_media', 'link_names', 'parse'] as const) {
        if (payload[key] !== undefined) args[key] = payload[key];
    }
    return args;
}

// ---------- Slack error mapping ----------

const ERROR_MAP: Record<string, WebhookResponse> = {
    channel_not_found: CHANNEL_NOT_FOUND,
    not_in_channel: CHANNEL_NOT_FOUND,
    is_archived: { status: 410, body: 'channel_is_archived' },
    no_text: NO_TEXT,
    too_many_attachments: { status: 400, body: 'too_many_attachments' },
    msg_too_long: INVALID_PAYLOAD,
    invalid_blocks: { status: 400, body: 'invalid_blocks' },
    invalid_blocks_format: { status: 400, body: 'invalid_blocks_format' },
    invalid_attachments: INVALID_PAYLOAD,
    restricted_action: { status: 403, body: 'action_prohibited' },
    restricted_action_read_only_channel: { status: 403, body: 'action_prohibited' },
    restricted_action_thread_only_channel: { status: 403, body: 'action_prohibited' },
    restricted_action_non_threadable_channel: { status: 403, body: 'action_prohibited' },
    cannot_reply_to_message: { status: 403, body: 'action_prohibited' },
    posting_to_general_channel_denied: { status: 403, body: 'posting_to_general_channel_denied' },
    team_access_not_granted: { status: 403, body: 'action_prohibited' },
};

/** Map a chat.postMessage platform error code to the response a Slack webhook would give. */
export function mapSlackError(code: string): WebhookResponse {
    return ERROR_MAP[code] ?? { status: 500, body: 'internal_error' };
}

export function rateLimited(retryAfterSeconds: number | undefined): WebhookResponse {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds ?? 1));
    return { status: 429, body: 'rate_limited', headers: { 'Retry-After': String(seconds) } };
}
