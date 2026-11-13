import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markJobHandled } from './store';

/** Fake with the operators markJobHandled's atomic filter uses. */
function fakeJobs(docs: Record<string, any>[]) {
    const get = (d: any, k: string) => k.split('.').reduce((o: any, part) => o?.[part], d);
    const matches = (d: any, q: Record<string, any>) => Object.entries(q).every(([k, v]) => {
        const actual = get(d, k);
        if (v && typeof v === 'object' && Object.keys(v).some(op => op.startsWith('$'))) {
            return (!('$ne' in v) || actual !== v.$ne) && (!('$exists' in v) || (actual !== undefined) === v.$exists);
        }
        return actual === v;
    });
    return {
        docs,
        async findOne(q: any) { return docs.find(d => matches(d, q)) ?? null; },
        async updateOne(q: any, u: any) {
            const d = docs.find(x => matches(x, q));
            if (!d) return { modifiedCount: 0 };
            Object.assign(d, u.$set);
            (d.history ??= []).push(u.$push.history);
            return { modifiedCount: 1 };
        },
    } as any;
}

const when = new Date('2026-01-01T00:00:00Z');
const bad = { fileId: 'f', url: 'u', status: 'violations', violations: [{ kind: 'domain_sharing' }] };

test('marks an open item, keeping the result and logging the real status', async () => {
    const col = fakeJobs([{ _id: 'a', result: bad }]);
    const r = await markJobHandled(col, 'a', 'U1', when, 'deleted');
    assert.equal(r.outcome, 'marked');
    assert.deepEqual(col.docs[0].manualResolution, { by: 'U1', at: when, note: 'deleted' });
    assert.equal(col.docs[0].result, bad);
    assert.equal(col.docs[0].history[0].status, 'violations');
});

test('refuses items that are compliant, handled, without a result, or missing', async () => {
    const col = fakeJobs([
        { _id: 'ok', result: { ...bad, status: 'compliant', violations: [] } },
        { _id: 'done', result: bad, manualResolution: { by: 'U0', at: when, note: 'x' } },
        { _id: 'new' },
    ]);
    assert.equal((await markJobHandled(col, 'ok', 'U1', when, 'n')).outcome, 'compliant');
    assert.equal((await markJobHandled(col, 'done', 'U1', when, 'n')).outcome, 'already_handled');
    assert.equal((await markJobHandled(col, 'new', 'U1', when, 'n')).outcome, 'no_result');
    assert.equal((await markJobHandled(col, 'nope', 'U1', when, 'n')).outcome, 'not_found');
    assert.ok(col.docs.every((d: any) => d.history === undefined));
});

test('a result that turned compliant between read and write is refused by the atomic filter', async () => {
    const col = fakeJobs([{ _id: 'a', result: bad }]);
    const realFindOne = col.findOne.bind(col);
    let reads = 0;
    col.findOne = async (q: any) => {
        const doc = await realFindOne(q);
        if (reads++ > 0) return doc;
        // The first read sees the open item; a recheck then makes it compliant before the write.
        const snapshot = { ...doc };
        col.docs[0].result = { ...bad, status: 'compliant', violations: [] };
        return snapshot;
    };
    const r = await markJobHandled(col, 'a', 'U1', when, 'n');
    assert.equal(r.outcome, 'compliant');
    assert.equal(col.docs[0].manualResolution, undefined);
    assert.equal(col.docs[0].history, undefined);
});
