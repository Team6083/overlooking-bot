import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FILES_SHOWN, buildComplianceBlocks, buildRecheckReplyBlocks, decodeRecheckValue, encodeRecheckValue } from './report';
import type { ComplianceResult } from './types';

const bad: ComplianceResult = { fileId: 'f', url: 'https://x/f', status: 'violations', fileName: 'A & B', violations: [{ kind: 'domain_sharing' }] };
const ok: ComplianceResult = { ...bad, status: 'compliant', violations: [] };

test('recheck value round-trips', () => {
    assert.deepEqual(decodeRecheckValue(encodeRecheckValue('C1', '1.2')), { channel: 'C1', ts: '1.2' });
    assert.equal(decodeRecheckValue('nonsense'), undefined);
    assert.equal(decodeRecheckValue(undefined), undefined);
});

test('audit report has a recheck button only when given a value', () => {
    const withBtn = buildComplianceBlocks([bad], { userId: 'U1', channel: 'C1', recheckValue: 'C1|1.2' });
    const last: any = withBtn.at(-1);
    assert.equal(last.type, 'actions');
    assert.equal(last.elements[0].action_id, 'drive_recheck');
    assert.equal(last.elements[0].value, 'C1|1.2');
    assert.ok(!buildComplianceBlocks([bad]).some(b => b.type === 'actions'));
    assert.ok(!buildComplianceBlocks([bad], { userId: 'U1', channel: 'C1' }).some(b => b.type === 'actions'));
});

function res(status: ComplianceResult['status']): ComplianceResult { return { ...bad, status, violations: [] }; }

test('recheck reply shows the change, the trigger and a button', () => {
    const blocks = buildRecheckReplyBlocks([{ result: ok, previous: bad }], {
        triggeredBy: 'U9', checkedAt: new Date('2026-01-01T00:00:00Z'), recheckValue: 'C1|1.2',
    });
    const text = JSON.stringify(blocks);
    assert.ok(text.includes('<@U9>'));
    assert.ok(text.includes('⚠️ → ✅ 已修正'));
    assert.ok(text.includes('A &amp; B'));
    assert.equal((blocks.at(-1) as any).elements[0].action_id, 'drive_recheck');
});

test('many files stay under the 50-block limit with a truncation note', () => {
    const many = Array.from({ length: 60 }, () => bad);
    const audit = buildComplianceBlocks(many, { userId: 'U1', channel: 'C1', recheckValue: 'C1|1' });
    assert.ok(audit.length <= 50);
    assert.ok(JSON.stringify(audit).includes(`另有 ${60 - MAX_FILES_SHOWN} 個檔案未顯示`));
    const reply = buildRecheckReplyBlocks(many.map(result => ({ result, previous: bad })), { triggeredBy: 'U1', checkedAt: new Date(), recheckValue: 'C1|1' });
    assert.ok(reply.length <= 50);
    assert.equal((reply.at(-1) as any).type, 'actions');
});

test('a huge file name cannot push a section past 3000 chars', () => {
    const blocks = buildComplianceBlocks([{ ...bad, fileName: 'x'.repeat(5000) }]);
    for (const b of blocks) if (b.type === 'section') assert.ok(b.text!.text.length <= 3000);
});

test('when truncated, non-compliant files are shown before compliant ones', () => {
    const files = [
        ...Array.from({ length: 25 }, (_, i) => ({ ...ok, fileName: `ok${i}` })),
        { ...bad, fileName: 'LATE_BAD' },
        { ...bad, status: 'not_accessible' as const, violations: [], fileName: 'LATE_NA' },
    ];
    const text = JSON.stringify(buildComplianceBlocks(files));
    assert.ok(text.includes('LATE_BAD') && text.includes('LATE_NA'));
    assert.ok(text.indexOf('LATE_BAD') < text.indexOf('LATE_NA'));
    assert.ok(text.indexOf('LATE_NA') < text.indexOf('ok0'));
    assert.ok(!text.includes('ok24'));
});

test('small lists keep their order', () => {
    const text = JSON.stringify(buildComplianceBlocks([{ ...ok, fileName: 'FIRST' }, { ...bad, fileName: 'SECOND' }]));
    assert.ok(text.indexOf('FIRST') < text.indexOf('SECOND'));
});

test('reply truncation prefers non-compliant, then changed, over unchanged compliant', () => {
    const entries = [
        ...Array.from({ length: 25 }, (_, i) => ({ result: { ...ok, fileName: `same${i}` }, previous: ok })),
        { result: { ...ok, fileName: 'FIXED' }, previous: bad },
        { result: { ...bad, fileName: 'STILL_BAD' }, previous: bad },
    ];
    const text = JSON.stringify(buildRecheckReplyBlocks(entries, { triggeredBy: 'U1', checkedAt: new Date(), recheckValue: 'C|1' }));
    assert.ok(text.indexOf('STILL_BAD') < text.indexOf('FIXED'));
    assert.ok(text.indexOf('FIXED') < text.indexOf('same0'));
    assert.ok(!text.includes('same24'));
});

test('failed recheck of a file is shown as kept, not as a status change', () => {
    const na: ComplianceResult = { ...bad, status: 'not_accessible', violations: [] };
    const info = { triggeredBy: 'U1', checkedAt: new Date(), recheckValue: 'C|1' };
    const mixed = JSON.stringify(buildRecheckReplyBlocks([
        { result: ok, previous: bad },
        { result: na, previous: bad },
    ], info));
    assert.ok(mixed.includes('已修正'));
    assert.ok(mixed.includes('❗ 複查失敗（無法存取），保留上次結果：發現違規'));
    assert.ok(mixed.includes('重新檢查結果'));

    const all = JSON.stringify(buildRecheckReplyBlocks([{ result: na, previous: bad }], info));
    assert.ok(all.includes('未變更任何結果'));
    assert.ok(!all.includes('已修正'));
});

test('reply: open non-compliant files get a mark-handled button; handled and compliant ones do not', () => {
    const info = { triggeredBy: 'U1', checkedAt: new Date(), recheckValue: 'C|1' };
    const blocks = buildRecheckReplyBlocks([
        { result: bad, previous: bad, jobId: 'J1' },
        { result: { ...bad, fileName: 'H' }, previous: bad, jobId: 'J2', hadManualResolution: true, handled: true },
        { result: ok, previous: bad, jobId: 'J3' },
    ], info);
    const buttons = blocks.flatMap((b: any) => b.accessory ? [b.accessory] : []);
    assert.deepEqual(buttons.map((b: any) => b.value), ['J1']);
    assert.ok(buttons[0].action_id.startsWith('drive_mark_handled:'));
    assert.ok(JSON.stringify(blocks).includes('已標記為已處理'));
    assert.ok(blocks.length <= 50);
});

test('reply says when a handled mark was cleared by new violations', () => {
    const text = JSON.stringify(buildRecheckReplyBlocks(
        [{ result: bad, previous: res('not_accessible'), jobId: 'J1', hadManualResolution: true, handled: false }],
        { triggeredBy: 'U1', checkedAt: new Date(), recheckValue: 'C|1' },
    ));
    assert.ok(text.includes('已處理標記已清除'));
});

test('a failed recheck of a handled file keeps showing it as handled, with no button', () => {
    const na: ComplianceResult = { ...bad, status: 'not_accessible', violations: [] };
    const blocks = buildRecheckReplyBlocks(
        [{ result: na, previous: na, jobId: 'J1', hadManualResolution: true, handled: true }],
        { triggeredBy: 'U1', checkedAt: new Date(), recheckValue: 'C|1' },
    );
    assert.ok(!blocks.some((b: any) => b.accessory));
    assert.ok(!JSON.stringify(blocks).includes('已處理標記已清除'));
});
