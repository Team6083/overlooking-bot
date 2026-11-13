import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markSurvivesRecheck, CLOSED_JOB_FILTER, OPEN_JOB_FILTER, clearsManualResolution, computeManualResolutionUpdate, overallStatusOfJobs, runRecheckStep, computeJobUpdate, computeRecheckUpdate, effectiveResult, diffResult, isMessageGoneError, overallStatus, reactionForStatus } from './recheck-core';
import type { ComplianceResult } from './types';

const res = (status: ComplianceResult['status'], violations: ComplianceResult['violations'] = []): ComplianceResult =>
    ({ fileId: 'f', url: 'u', status, violations });
const bad = res('violations', [{ kind: 'public_access', allowFileDiscovery: false }]);
const when = new Date('2026-01-01T00:00:00Z');

test('overallStatus: violations beat unchecked beat compliant', () => {
    assert.equal(overallStatus([res('compliant'), res('cannot_check'), bad]), 'violations');
    assert.equal(overallStatus([res('compliant'), res('not_accessible')]), 'cannot_check');
    assert.equal(overallStatus([res('compliant'), res('compliant')]), 'compliant');
});

test('reactionForStatus', () => {
    assert.equal(reactionForStatus('violations'), 'warning');
    assert.equal(reactionForStatus('cannot_check'), 'grey_question');
    assert.equal(reactionForStatus('compliant'), 'white_check_mark');
});

test('diffResult describes the change', () => {
    assert.equal(diffResult(bad, res('compliant')).kind, 'fixed');
    assert.equal(diffResult(bad, res('compliant')).text, '⚠️ → ✅ 已修正');
    assert.equal(diffResult(res('compliant'), bad).kind, 'regressed');
    assert.equal(diffResult(bad, bad).kind, 'unchanged');
    assert.equal(diffResult(bad, res('violations', [{ kind: 'domain_sharing' }])).kind, 'changed');
    assert.equal(diffResult(bad, res('cannot_check')).kind, 'changed');
    assert.equal(diffResult(undefined, bad).kind, 'new');
});

test('computeJobUpdate: initial check', () => {
    const u = computeJobUpdate({}, bad, 'system', when);
    assert.equal(u.$set.checkCount, 1);
    assert.equal(u.$set.status, 'completed');
    assert.equal(u.$set.lastCheckedAt, when);
    assert.deepEqual(u.$push.history, { checkedAt: when, checkedBy: 'system', status: 'violations', violations: bad.violations });
    assert.deepEqual(u.$unset, { resolvedAt: '', manualResolution: '' });
});

test('computeJobUpdate: resolvedAt set on fix, cleared on regression, kept otherwise', () => {
    const fixed = computeJobUpdate({ result: bad, checkCount: 1 }, res('compliant'), 'U1', when);
    assert.equal(fixed.$set.resolvedAt, when);
    assert.equal(fixed.$set.checkCount, 2);
    assert.equal(fixed.$unset, undefined);

    const regressed = computeJobUpdate({ result: res('compliant'), checkCount: 2, resolvedAt: when }, bad, 'U1', when);
    assert.deepEqual(regressed.$unset, { resolvedAt: '', manualResolution: '' });

    const stillOk = computeJobUpdate({ result: res('compliant'), checkCount: 1 }, res('compliant'), 'U1', when);
    assert.equal('resolvedAt' in stillOk.$set, false);
    assert.equal(stillOk.$unset, undefined);
});

test('computeJobUpdate: old docs without checkCount', () => {
    assert.equal(computeJobUpdate({ result: bad }, bad, 'U1', when).$set.checkCount, 2);
    assert.equal(computeJobUpdate({ result: res('cannot_check') }, bad, 'U1', when).$set.status, 'completed');
    assert.equal(computeJobUpdate({}, res('not_accessible'), 'system', when).$set.status, 'error');
});

test('isMessageGoneError', () => {
    assert.equal(isMessageGoneError({ data: { error: 'message_not_found' } }), true);
    assert.equal(isMessageGoneError({ data: { error: 'ratelimited' } }), false);
    assert.equal(isMessageGoneError(new Error('x')), false);
});

test('failed recheck keeps the stored result and only logs history', () => {
    const na = { ...res('not_accessible'), errorMessage: 'HTTP 403' };
    const job = { result: bad, checkCount: 1 };
    const u = computeRecheckUpdate(job, na, 'U1', when);
    assert.equal(u.$set, undefined);
    assert.equal(u.$unset, undefined);
    assert.deepEqual(u.$push.history, { checkedAt: when, checkedBy: 'U1', status: 'not_accessible', violations: [], failed: true, errorMessage: 'HTTP 403' });
    // a previously compliant file with a resolvedAt keeps it too
    const kept = computeRecheckUpdate({ result: res('compliant'), checkCount: 2, resolvedAt: when }, res('cannot_check'), 'U1', when);
    assert.equal(kept.$set, undefined);
    assert.equal(kept.$unset, undefined);
});

test('successful recheck and the initial check update as before', () => {
    const fixed = computeRecheckUpdate({ result: bad, checkCount: 1 }, res('compliant'), 'U1', when);
    assert.equal(fixed.$set!.resolvedAt, when);
    assert.equal(fixed.$push.history.failed, undefined);
    // no stored result yet: a failure is recorded as a normal result
    assert.equal(computeRecheckUpdate({}, res('not_accessible'), 'U1', when).$set!.status, 'error');
});

test('mixed report and all-failed report: reaction follows the kept results', () => {
    const prev = [bad, res('compliant')];
    const mixed = [res('compliant'), res('not_accessible')]; // first fixed, second failed
    const kept = mixed.map((r, i) => effectiveResult(prev[i], r));
    assert.deepEqual(kept.map(r => r.status), ['compliant', 'compliant']);
    assert.equal(reactionForStatus(overallStatus(kept)), 'white_check_mark');

    const allFailed = [res('cannot_check'), res('not_accessible')].map((r, i) => effectiveResult(prev[i], r));
    assert.equal(reactionForStatus(overallStatus(allFailed)), reactionForStatus(overallStatus(prev)));
    assert.equal(reactionForStatus(overallStatus(allFailed)), 'warning');
});

const manual = { by: 'U7', at: when, note: 'deleted' };

test('manually handled files count as compliant for the overall status', () => {
    const na = res('not_accessible');
    assert.equal(overallStatusOfJobs([{ result: bad, manualResolution: manual }, { result: res('compliant') }]), 'compliant');
    assert.equal(reactionForStatus(overallStatusOfJobs([{ result: na, manualResolution: manual }])), 'white_check_mark');
    assert.equal(overallStatusOfJobs([{ result: bad, manualResolution: manual }, { result: na }]), 'cannot_check');
    assert.equal(overallStatusOfJobs([{ result: bad }, { result: na, manualResolution: manual }]), 'violations');
    assert.equal(overallStatusOfJobs([{}]), 'compliant');
});

test('computeManualResolutionUpdate leaves the result alone and logs history', () => {
    const u = computeManualResolutionUpdate({ result: bad }, 'U7', when, 'deleted');
    assert.deepEqual(u.$set, { manualResolution: manual });
    assert.equal(u.$unset, undefined);
    assert.deepEqual(u.$push.history, {
        kind: 'manual_resolution', checkedAt: when, checkedBy: 'U7', status: 'violations', violations: bad.violations, note: 'deleted',
    });
});

test('only a successful recheck that finds violations clears the manual mark', () => {
    const job = { result: res('not_accessible'), manualResolution: manual, checkCount: 1 };
    assert.equal(clearsManualResolution(job, bad), true);
    assert.deepEqual(computeRecheckUpdate(job, bad, 'U1', when).$unset, { resolvedAt: '', manualResolution: '' });
    // compliant: the mark stays as a record
    const ok = computeRecheckUpdate(job, res('compliant'), 'U1', when);
    assert.equal(ok.$unset, undefined);
    assert.equal(ok.$set!.resolvedAt, when);
    // failed recheck: nothing but history
    const failed = computeRecheckUpdate(job, res('not_accessible'), 'U1', when);
    assert.equal(failed.$set, undefined);
    assert.equal(failed.$unset, undefined);
    // violations unset the mark unconditionally, even when the job snapshot has none
    // (a mark may have been made after the snapshot was read)
    assert.deepEqual(computeRecheckUpdate({ result: res('compliant') }, bad, 'U1', when).$unset, { resolvedAt: '', manualResolution: '' });
    // cannot_check on a job with no stored result is a normal result and does not touch marks
    assert.equal(computeJobUpdate({}, res('cannot_check'), 'system', when).$unset!.manualResolution, undefined);
});

test('runRecheckStep: a rejected check fails only that file; the others are updated', async () => {
    const jobs = [
        { fileId: 'a', url: 'ua', result: bad, checkCount: 1 },
        { fileId: 'b', url: 'ub', result: bad, checkCount: 1 },
        { fileId: 'c', url: 'uc', result: res('not_accessible'), manualResolution: manual, checkCount: 1 },
    ];
    const step = await runRecheckStep(jobs, async job => {
        if (job.fileId === 'b') throw new Error('boom');
        return { fileId: job.fileId, url: job.url, status: job.fileId === 'a' ? 'compliant' : 'violations', violations: job.fileId === 'a' ? [] : bad.violations };
    }, 'U1', when);

    assert.deepEqual(step.failed, [false, true, false]);
    assert.equal(step.results[1].status, 'cannot_check');
    assert.equal(step.results[1].errorMessage, 'boom');
    // a: fixed
    assert.equal(step.updates[0].$set!.resolvedAt, when);
    // b: failed -> only a history push
    assert.equal(step.updates[1].$set, undefined);
    assert.equal(step.updates[1].$unset, undefined);
    assert.equal(step.updates[1].$push.history.failed, true);
    assert.equal(step.updates[1].$push.history.errorMessage, 'boom');
    // c: violations again -> mark cleared
    assert.deepEqual(step.updates[2].$unset, { resolvedAt: '', manualResolution: '' });
    assert.deepEqual(step.handledAfter, [false, false, false]);
});

test('runRecheckStep: all failed leaves the overall status as it was', async () => {
    const jobs = [{ fileId: 'a', url: 'u', result: bad }, { fileId: 'b', url: 'u', result: res('compliant') }];
    const step = await runRecheckStep(jobs, async () => { throw new Error('down'); }, 'U1', when);
    assert.deepEqual(step.failed, [true, true]);
    assert.ok(step.updates.every(u => u.$set === undefined));
    const kept = jobs.map((j, i) => ({ result: step.failed[i] ? j.result : step.results[i] }));
    assert.equal(overallStatusOfJobs(kept), overallStatusOfJobs(jobs));
});

test('open and closed job filters are complements', () => {
    assert.deepEqual(OPEN_JOB_FILTER['result.status'], { $exists: true, $ne: 'compliant' });
    assert.deepEqual(OPEN_JOB_FILTER.manualResolution, { $exists: false });
    assert.equal(CLOSED_JOB_FILTER.$or.length, 3);
});

test('markSurvivesRecheck: only violations void an existing mark', () => {
    assert.equal(markSurvivesRecheck(true, bad), false);
    assert.equal(markSurvivesRecheck(true, res('compliant')), true);
    assert.equal(markSurvivesRecheck(true, res('not_accessible')), true);
    assert.equal(markSurvivesRecheck(false, bad), false);
});
