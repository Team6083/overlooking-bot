import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import * as http from 'http';
import { ObjectId } from 'mongodb';
import { isValidKey, parseListenAddr } from '../config';
import type { DbCollections } from '../db';
import { OPENAPI_PATH, renderOpenApi } from '../scripts/generate-openapi';
import { decodeCursor, encodeCursor } from './pagination';
import { createHttpApp } from './server';

const API_KEY = Buffer.alloc(32, 7).toString('base64');

/** Minimal in-memory stand-in for the Mongo collection calls the API makes. */
function fakeCollection(docs: Record<string, any>[]) {
    const matches = (doc: Record<string, any>, q: Record<string, any>) => Object.entries(q).every(([k, v]) => {
        if (k === '_id' && v instanceof ObjectId) return doc._id.equals(v);
        if (k === '_id' && v.$lt) return doc._id.toHexString() < v.$lt.toHexString();
        return doc[k] === v;
    });
    return {
        find(q: Record<string, any>) {
            let out = docs.filter((d) => matches(d, q));
            const cursor = {
                sort() { out = [...out].sort((a, b) => (a._id.toHexString() < b._id.toHexString() ? 1 : -1)); return cursor; },
                limit(n: number) { out = out.slice(0, n); return cursor; },
                async toArray() { return out; },
            };
            return cursor;
        },
        async findOne(q: Record<string, any>) { return docs.find((d) => matches(d, q)) ?? null; },
    };
}

const ids = Array.from({ length: 5 }, (_, i) => new ObjectId((i + 1).toString(16).padStart(24, '0')));
const messages = ids.map((_id, i) => ({
    _id, type: 'message', channel: 'C1', user: 'U1', text: `hello ${i}`, ts: `1700000000.00000${i}`, thread_ts: '1700000000.000000',
    files: [{ id: 'F1', name: 'a.png', mimetype: 'image/png', size: 3, url_private: 'x' }],
    ...(i === 4 ? { overlooking_webhook: { id: 'W1', name: 'CI' } } : {}),
}));
const changed = [{ _id: ids[0], type: 'message', subtype: 'message_changed', channel: 'C1', ts: '2.0', message: { ts: '1.0', text: 'new', user: 'U1' }, previous_message: { text: 'old' } }];
const deleted = [{ _id: ids[0], type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '3.0', deleted_ts: '1.0', previous_message: { text: 'gone', user: 'U2' } }];
const jobs = [
    { _id: ids[0], fileId: 'f', url: 'u', channel: 'C1', thread_ts: '1.0', status: 'completed', requestedAt: new Date('2026-01-01T00:00:00Z'), completedAt: new Date('2026-01-01T00:00:01Z'), result: { fileId: 'f', url: 'u', status: 'compliant', violations: [] } },
    { _id: ids[1], fileId: 'g', url: 'v', channel: 'C1', thread_ts: '2.0', status: 'pending', requestedAt: new Date('2026-01-02T00:00:00Z') },
];

const collections = {
    messages: fakeCollection(messages),
    changedMessages: fakeCollection(changed),
    deletedMessages: fakeCollection(deleted),
    driveComplianceJobs: fakeCollection(jobs),
    webhooks: fakeCollection([]),
} as unknown as DbCollections;

let server: http.Server;
let base = '';
const webhookCalls: string[] = [];

before(async () => {
    const app = createHttpApp({
        build: { version: '1.2.3', commit: 'abc1234' },
        api: { apiKey: API_KEY, collections },
        webhook: {
            async route(req, res) {
                webhookCalls.push(req.url ?? '');
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('ok');
            },
        },
    });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

const get = (path: string, auth = true) => fetch(base + path, { headers: auth ? { Authorization: `Bearer ${API_KEY}` } : {} });

describe('REST API', () => {
    it('rejects a missing key with 401 unauthenticated', async () => {
        const res = await get('/api/v1/messages', false);
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { error: { code: 'unauthenticated', message: 'Missing or invalid API key' } });
    });

    it('sends version, commit, request id and nosniff on every response', async () => {
        const res = await fetch(`${base}/nowhere`, { headers: { 'X-Request-ID': 'req-1' } });
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('x-app-version'), '1.2.3');
        assert.equal(res.headers.get('x-app-commit'), 'abc1234');
        assert.equal(res.headers.get('x-request-id'), 'req-1');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal((await res.json()).error.code, 'not_found');
    });

    it('pages messages newest first with an opaque cursor', async () => {
        const first = await (await get('/api/v1/messages?limit=2')).json();
        assert.deepEqual(first.items.map((m: any) => m.text), ['hello 4', 'hello 3']);
        assert.equal(typeof first.nextCursor, 'string');
        const second = await (await get(`/api/v1/messages?limit=2&cursor=${first.nextCursor}`)).json();
        assert.deepEqual(second.items.map((m: any) => m.text), ['hello 2', 'hello 1']);
        const last = await (await get(`/api/v1/messages?limit=2&cursor=${second.nextCursor}`)).json();
        assert.deepEqual(last.items.map((m: any) => m.text), ['hello 0']);
        assert.equal(last.nextCursor, null);
    });

    it('returns camelCase records and keeps the raw Slack event', async () => {
        const { items } = await (await get('/api/v1/messages?limit=1')).json();
        const m = items[0];
        assert.equal(m.threadTs, '1700000000.000000');
        assert.deepEqual(m.webhook, { id: 'W1', name: 'CI' });
        assert.deepEqual(m.files, [{ id: 'F1', name: 'a.png', mimetype: 'image/png', size: 3 }]);
        assert.equal(m.slackEvent.thread_ts, '1700000000.000000');
        assert.equal(m.slackEvent._id, undefined);
        assert.equal(m.slackEvent.overlooking_webhook, undefined);
    });

    it('maps edits and deletions', async () => {
        const c = await (await get(`/api/v1/messages/${ids[0]}?collection=changed_messages`)).json();
        assert.equal(c.messageTs, '1.0');
        assert.equal(c.text, 'new');
        assert.equal(c.previousText, 'old');
        const d = await (await get(`/api/v1/messages/${ids[0]}?collection=deleted_messages`)).json();
        assert.equal(d.messageTs, '1.0');
        assert.equal(d.user, 'U2');
        assert.equal(d.previousText, 'gone');
    });

    for (const [query, field] of [['limit=0', 'limit'], ['limit=abc', 'limit'], ['limit=1.5', 'limit'], ['cursor=nope', 'cursor'], ['collection=changedMessages', 'collection']]) {
        it(`rejects ${query} with 400 invalid_request`, async () => {
            const res = await get(`/api/v1/messages?${query}`);
            assert.equal(res.status, 400);
            const body = await res.json();
            assert.equal(body.error.code, 'invalid_request');
            assert.ok(body.error.details.fields[field], JSON.stringify(body));
        });
    }

    it('clamps limit to the maximum', async () => {
        const res = await get('/api/v1/messages?limit=100000');
        assert.equal(res.status, 200);
        assert.equal((await res.json()).items.length, 5);
    });

    it('returns 404 not_found for an unknown id and 400 for a malformed one', async () => {
        assert.equal((await (await get(`/api/v1/messages/${new ObjectId()}`)).json()).error.code, 'not_found');
        const bad = await get('/api/v1/messages/123');
        assert.equal(bad.status, 400);
        assert.ok((await bad.json()).error.details.fields.id);
    });

    it('lists and filters Drive jobs with RFC 3339 times', async () => {
        const all = await (await get('/api/v1/drive/jobs')).json();
        assert.equal(all.items.length, 2);
        const done = await (await get('/api/v1/drive/jobs?status=completed')).json();
        assert.deepEqual(done.items.map((j: any) => j.fileId), ['f']);
        assert.equal(done.items[0].requestedAt, '2026-01-01T00:00:00.000Z');
        assert.equal(done.items[0].messageTs, '1.0');
        assert.equal(done.items[0].thread_ts, undefined);
        assert.equal((await get('/api/v1/drive/jobs?status=done')).status, 400);
    });

    it('hands /services/... to the webhook relay untouched', async () => {
        const res = await fetch(`${base}/services/W1/s3cret?x=%E0%A4%A`, { method: 'POST' });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-app-commit'), 'abc1234');
        assert.equal(webhookCalls.at(-1), '/services/W1/s3cret?x=%E0%A4%A');
    });
});

describe('OpenAPI', () => {
    it('api/openapi.yaml matches the schemas (run `npm run openapi`)', () => {
        assert.equal(readFileSync(OPENAPI_PATH, 'utf8'), renderOpenApi());
    });
});

describe('helpers', () => {
    it('round-trips cursors and rejects junk', () => {
        assert.ok(decodeCursor(encodeCursor(ids[3]))!.equals(ids[3]));
        assert.equal(decodeCursor('not a cursor'), undefined);
    });

    it('parses LISTEN_ADDR', () => {
        assert.deepEqual(parseListenAddr(':8080'), { port: 8080 });
        assert.deepEqual(parseListenAddr('127.0.0.1:9000'), { host: '127.0.0.1', port: 9000 });
        assert.deepEqual(parseListenAddr('[::]:8080'), { host: '::', port: 8080 });
        assert.throws(() => parseListenAddr('8080'));
        assert.throws(() => parseListenAddr(':99999'));
    });

    it('requires API_KEY to be base64 of at least 32 bytes', () => {
        assert.ok(isValidKey(API_KEY));
        assert.ok(isValidKey(Buffer.alloc(32).toString('base64url')));
        assert.equal(isValidKey('short-key'), false);
        assert.equal(isValidKey('not base64 at all, even if it is long enough!!'), false);
    });
});
