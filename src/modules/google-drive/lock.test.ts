import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireReportLock, LOCK_TTL_MS, releaseReportLock } from './lock';

/**
 * In-memory stand-in supporting just the operators the lock uses. updateMany yields between
 * documents (each doc is still checked and updated atomically) so concurrent callers interleave,
 * like they can against a real server; `failAfter` makes it throw after that many updates.
 */
function fakeJobs(docs: Record<string, any>[], { failAfter }: { failAfter?: number } = {}) {
    const matches = (d: Record<string, any>, q: Record<string, any>): boolean => Object.entries(q).every(([k, v]) => {
        if (k === '$or') return (v as any[]).some(sub => matches(d, sub));
        if (v && typeof v === 'object' && '$exists' in v) return (k in d) === v.$exists;
        if (v && typeof v === 'object' && '$lt' in v) return d[k] !== undefined && d[k] !== null && d[k] < v.$lt;
        return d[k] === v;
    });
    let failBudget = failAfter;
    return {
        docs,
        async countDocuments(q: any) { return docs.filter(d => matches(d, q)).length; },
        async updateMany(q: any, u: any) {
            let modified = 0;
            for (const d of docs) {
                await new Promise(resolve => setImmediate(resolve));
                if (!matches(d, q)) continue;
                if (u.$set && failBudget !== undefined) {
                    if (failBudget === 0) throw new Error('connection lost');
                    failBudget--;
                }
                Object.assign(d, u.$set ?? {});
                for (const k of Object.keys(u.$unset ?? {})) delete d[k];
                modified++;
            }
            return { modifiedCount: modified };
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

test('concurrent callers: at most one acquires and nothing stays locked after releases', async () => {
    for (let round = 0; round < 5; round++) {
        const col = fakeJobs([...report(), { channel: 'C', thread_ts: '1' }]);
        const tokens = ['a', 'b', 'c'];
        const results = await Promise.all(tokens.map(t => acquireReportLock(col, filter, t)));
        assert.ok(results.filter(r => r === 'acquired').length <= 1);
        await Promise.all(tokens.map((t, i) => results[i] === 'acquired' ? releaseReportLock(col, filter, t) : undefined));
        assert.ok(col.docs.every((d: any) => !('recheckingAt' in d) && !('recheckingToken' in d)));
    }
});

test('updateMany failing mid-way releases the partial lock and rethrows', async () => {
    const col = fakeJobs(report(), { failAfter: 1 });
    await assert.rejects(acquireReportLock(col, filter, 'a'), /connection lost/);
    assert.ok(col.docs.every((d: any) => !('recheckingAt' in d) && !('recheckingToken' in d)));
});
