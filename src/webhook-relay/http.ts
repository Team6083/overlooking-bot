import type { IncomingMessage, ServerResponse } from 'http';
import { ErrorCode, WebClient } from '@slack/web-api';
import type { Collection, Document } from 'mongodb';
import {
    buildPostArgs,
    isResponse,
    mapSlackError,
    MAX_BODY_BYTES,
    METHOD_NOT_ALLOWED,
    needsNameLookup,
    NO_SERVICE,
    OK,
    parseBody,
    PAYLOAD_TOO_LARGE,
    permittedChannels,
    rateLimited,
    selectChannel,
    verifySecret,
    WebhookResponse,
} from './core';
import { WebhookStore } from './store';

type RouteRequest = IncomingMessage & { params?: Record<string, string | string[] | undefined> };

type Logger = { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };

const NAME_TTL_MS = 5 * 60 * 1000;

export class WebhookHttpHandler {
    private nameCache = new Map<string, { name?: string; at: number }>();

    constructor(
        private store: WebhookStore,
        /** Client with retries disabled and rate-limited calls rejected, so callers see 429s. */
        private client: WebClient,
        private msgCollection: Collection<Document>,
        private logger: Logger = console,
    ) { }

    /**
     * Route a raw request. The path is matched with a plain regex and never URL-decoded, so a
     * malformed escape such as `%E0%A4%A` cannot throw (IDs and secrets are alphanumeric anyway).
     */
    async route(req: IncomingMessage, res: ServerResponse) {
        const path = (req.url ?? '').split('?')[0];
        const m = /^\/services\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)\/?$/.exec(path);
        if (!m) {
            req.resume();
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not_found');
            return;
        }
        await this.handle(Object.assign(req, { params: { id: m[1], secret: m[2] } }), res);
    }

    async handle(req: RouteRequest, res: ServerResponse) {
        let result: WebhookResponse;
        try {
            result = await this.process(req);
        } catch (err) {
            this.logger.error('Webhook relay failed', err);
            result = { status: 500, body: 'internal_error' };
        }
        if (!res.headersSent) {
            res.writeHead(result.status, { 'Content-Type': 'text/plain; charset=utf-8', ...result.headers });
            res.end(result.body);
        }
    }

    private async process(req: RouteRequest): Promise<WebhookResponse> {
        if (req.method !== 'POST') return METHOD_NOT_ALLOWED;

        const id = String(req.params?.id ?? '');
        const secret = String(req.params?.secret ?? '');
        const webhook = id ? await this.store.get(id) : null;
        if (!webhook || !webhook.enabled || !verifySecret(secret, webhook.secretHash)) {
            req.resume();
            return NO_SERVICE;
        }

        const raw = await readBody(req, MAX_BODY_BYTES);
        if (raw === null) return PAYLOAD_TOO_LARGE;

        const payload = parseBody(req.headers['content-type'], raw);
        if (isResponse(payload)) return payload;

        const lookup = needsNameLookup(payload.channel)
            ? await this.channelNames(permittedChannels(webhook))
            : { names: {} };
        const channel = selectChannel(webhook, payload.channel, lookup.names);
        if (isResponse(channel) && lookup.failure) {
            // The name may belong to a channel whose lookup failed: ask the caller to retry
            // instead of claiming the channel does not exist.
            return lookup.failure;
        }
        if (isResponse(channel)) {
            await this.store.recordError(webhook._id, channel.body);
            return channel;
        }

        const args = buildPostArgs(webhook, payload, channel);
        if (isResponse(args)) return args;

        let posted;
        try {
            posted = await this.client.chat.postMessage(args as any);
        } catch (err: any) {
            if (err?.code === ErrorCode.RateLimitedError) {
                await this.store.recordError(webhook._id, 'rate_limited');
                return rateLimited(err.retryAfter);
            }
            if (err?.code === ErrorCode.PlatformError) {
                const code: string = err.data?.error ?? 'unknown';
                this.logger.warn(`Webhook ${webhook._id} postMessage failed: ${code}`);
                await this.store.recordError(webhook._id, code);
                return mapSlackError(code);
            }
            throw err;
        }

        // The message is in Slack now: bookkeeping failures must not turn this into a 5xx,
        // or the caller retries and the message is posted twice.
        await this.store.recordSuccess(webhook._id)
            .catch((err) => this.logger.error('Failed to record webhook success', err));
        if (posted.message) {
            await this.msgCollection.insertOne({
                ...posted.message,
                channel: posted.channel,
                ts: posted.ts,
                overlooking_webhook: { id: webhook._id, name: webhook.name },
            }).catch((err) => this.logger.error('Failed to archive webhook message', err));
        }
        return OK;
    }

    /** Names of the given channel IDs. Successful lookups are cached; failures are not. */
    private async channelNames(ids: string[]): Promise<{ names: Record<string, string | undefined>; failure?: WebhookResponse }> {
        const out: Record<string, string | undefined> = {};
        let failure: WebhookResponse | undefined;
        await Promise.all(ids.map(async (id) => {
            const cached = this.nameCache.get(id);
            if (cached && cached.at + NAME_TTL_MS > Date.now()) {
                out[id] = cached.name;
                return;
            }
            try {
                const info = await this.client.conversations.info({ channel: id });
                out[id] = info.channel?.name;
                this.nameCache.set(id, { name: out[id], at: Date.now() });
            } catch (err: any) {
                this.logger.warn(`Channel name lookup failed for ${id}: ${err?.code ?? err}`);
                out[id] = undefined;
                failure = err?.code === ErrorCode.RateLimitedError
                    ? rateLimited(err.retryAfter)
                    : failure ?? { status: 500, body: 'internal_error' };
            }
        }));
        return { names: out, failure };
    }
}

/**
 * Read the request body as UTF-8, or null if it exceeds `limit` bytes. Rejects if the client
 * disconnects before the body is complete, so an aborted upload cannot leave the promise pending.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (chunk: Buffer) => {
            if (tooLarge) return;
            size += chunk.length;
            if (size > limit) {
                tooLarge = true;
                chunks.length = 0;
                resolve(null);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
        req.on('error', reject);
        // 'close' after 'end' is a no-op because the promise has already settled.
        req.on('close', () => { if (!req.complete) reject(new Error('Request aborted')); });
    });
}
