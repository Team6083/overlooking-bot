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
