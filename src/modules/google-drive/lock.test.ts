import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireReportLock, LOCK_TTL_MS, releaseReportLock } from './lock';

/** In-memory stand-in supporting just the operators the lock uses. */
function fakeJobs(docs: Record<string, any>[]) {
    const matches = (d: Record<string, any>, q: Record<string, any>): boolean => Object.entries(q).every(([k, v]) => {
        if (k === '$or') return (v as any[]).some(sub => matches(d, sub));
        if (v && typeof v === 'object' && '$exists' in v) return (k in d) === v.$exists;
        if (v && typeof v === 'object' && '$lt' in v) return d[k] !== undefined && d[k] !== null && d[k] < v.$lt;
        return d[k] === v;
    });
    return {
        docs,
        async countDocuments(q: any) { return docs.filter(d => matches(d, q)).length; },
        async updateMany(q: any, u: any) {
            const hit = docs.filter(d => matches(d, q));
            for (const d of hit) {
                Object.assign(d, u.$set ?? {});
                for (const k of Object.keys(u.$unset ?? {})) delete d[k];
            }
            return { modifiedCount: hit.length };
        },
    } as any;
}

const filter = { channel: 'C', thread_ts: '1' };
const report = () => [
    { channel: 'C', thread_ts: '1' },
    { channel: 'C', thread_ts: '1' },
    { channel: 'C', thread_ts: '2' },
];

test('acquires every doc of the report and releases them', async () => {
    const col = fakeJobs(report());
    assert.equal(await acquireReportLock(col, filter, 'a'), 'acquired');
    assert.equal(col.docs.filter((d: any) => d.recheckingToken === 'a').length, 2);
    assert.equal(col.docs[2].recheckingToken, undefined);
    await releaseReportLock(col, filter, 'a');
    assert.ok(col.docs.every((d: any) => !('recheckingAt' in d)));
});

test('a second caller is busy and leaves the first lock intact', async () => {
    const col = fakeJobs(report());
    assert.equal(await acquireReportLock(col, filter, 'a'), 'acquired');
    assert.equal(await acquireReportLock(col, filter, 'b'), 'busy');
    assert.ok(col.docs.slice(0, 2).every((d: any) => d.recheckingToken === 'a'));
});

test('a partially locked report releases only the caller\'s own partial lock', async () => {
    const col = fakeJobs(report());
    col.docs[0].recheckingAt = new Date();
    col.docs[0].recheckingToken = 'other';
    assert.equal(await acquireReportLock(col, filter, 'b'), 'busy');
    assert.equal(col.docs[0].recheckingToken, 'other');
    assert.equal(col.docs[1].recheckingToken, undefined);
});

test('a stale lock is taken over', async () => {
    const col = fakeJobs(report());
    const now = new Date('2026-01-01T00:10:00Z');
    col.docs[0].recheckingAt = new Date(now.getTime() - LOCK_TTL_MS - 1);
    col.docs[0].recheckingToken = 'dead';
    col.docs[1].recheckingAt = null;
    assert.equal(await acquireReportLock(col, filter, 'b', now), 'acquired');
    assert.equal(col.docs[0].recheckingToken, 'b');
});

test('an unknown report is missing', async () => {
    assert.equal(await acquireReportLock(fakeJobs([]), filter, 'a'), 'missing');
});
