import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeJobUpdate, diffResult, isMessageGoneError, overallStatus, reactionForStatus } from './recheck-core';
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
    assert.deepEqual(u.$unset, { resolvedAt: '' });
});

test('computeJobUpdate: resolvedAt set on fix, cleared on regression, kept otherwise', () => {
    const fixed = computeJobUpdate({ result: bad, checkCount: 1 }, res('compliant'), 'U1', when);
    assert.equal(fixed.$set.resolvedAt, when);
    assert.equal(fixed.$set.checkCount, 2);
    assert.equal(fixed.$unset, undefined);

    const regressed = computeJobUpdate({ result: res('compliant'), checkCount: 2, resolvedAt: when }, bad, 'U1', when);
    assert.deepEqual(regressed.$unset, { resolvedAt: '' });

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
