import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPostArgs,
    buildWebhookUrl,
    CHANNEL_NOT_FOUND,
    generateSecret,
    generateWebhookId,
    hashSecret,
    INVALID_PAYLOAD,
    isResponse,
    mapSlackError,
    needsNameLookup,
    NO_TEXT,
    parseBody,
    rateLimited,
    selectChannel,
    selectIdentity,
    verifySecret,
} from './core';

const webhook = {
    defaultChannel: 'C0DEFAULT1',
    allowedChannels: ['C0ALLOWED1'],
    defaultIdentity: { username: 'Grafana', iconEmoji: ':chart:' },
    allowIdentityOverride: false,
};

test('parseBody accepts raw JSON', () => {
    assert.deepEqual(parseBody('application/json', '{"text":"hi"}'), { text: 'hi' });
});

test('parseBody accepts JSON without a content type', () => {
    assert.deepEqual(parseBody(undefined, '{"text":"hi"}'), { text: 'hi' });
});

test('parseBody accepts form-encoded payload=', () => {
    const body = 'payload=' + encodeURIComponent(JSON.stringify({ text: 'a&b', channel: '#x' }));
    assert.deepEqual(parseBody('application/x-www-form-urlencoded; charset=utf-8', body), { text: 'a&b', channel: '#x' });
});

test('parseBody rejects form without payload, bad JSON and wrong types', () => {
    assert.equal(parseBody('application/x-www-form-urlencoded', 'text=hi'), INVALID_PAYLOAD);
    assert.equal(parseBody('application/json', '{nope'), INVALID_PAYLOAD);
    assert.equal(parseBody('application/json', '[1]'), INVALID_PAYLOAD);
    assert.equal(parseBody('application/json', '"hi"'), INVALID_PAYLOAD);
    assert.equal(parseBody('application/json', '{"text":5}'), INVALID_PAYLOAD);
    assert.equal(parseBody('application/json', '{"blocks":"x"}'), INVALID_PAYLOAD);
    assert.equal(parseBody('application/json', '{"mrkdwn":"yes"}'), INVALID_PAYLOAD);
});

test('selectChannel uses the default when no channel is given', () => {
    assert.equal(selectChannel(webhook, undefined), 'C0DEFAULT1');
    assert.equal(selectChannel(webhook, '  '), 'C0DEFAULT1');
});

test('selectChannel accepts permitted IDs and rejects others', () => {
    assert.equal(selectChannel(webhook, 'C0ALLOWED1'), 'C0ALLOWED1');
    assert.equal(selectChannel(webhook, 'C0DEFAULT1'), 'C0DEFAULT1');
    assert.equal(selectChannel(webhook, 'C0OTHER123'), CHANNEL_NOT_FOUND);
});

test('selectChannel resolves names among permitted channels only', () => {
    const names = { C0DEFAULT1: 'alerts', C0ALLOWED1: 'ops' };
    assert.equal(selectChannel(webhook, '#ops', names), 'C0ALLOWED1');
    assert.equal(selectChannel(webhook, 'OPS', names), 'C0ALLOWED1');
    assert.equal(selectChannel(webhook, '#general', names), CHANNEL_NOT_FOUND);
    assert.equal(selectChannel(webhook, '@someone', names), CHANNEL_NOT_FOUND);
});

test('needsNameLookup only for names', () => {
    assert.equal(needsNameLookup(undefined), false);
    assert.equal(needsNameLookup('C0ALLOWED1'), false);
    assert.equal(needsNameLookup('#ops'), true);
    assert.equal(needsNameLookup('ops'), true);
});

test('selectIdentity ignores overrides when not allowed', () => {
    assert.deepEqual(
        selectIdentity(webhook, { username: 'Evil', icon_url: 'https://x/y.png' }),
        { username: 'Grafana', icon_emoji: ':chart:' },
    );
});

test('selectIdentity applies overrides when allowed', () => {
    const w = { ...webhook, allowIdentityOverride: true };
    assert.deepEqual(selectIdentity(w, { username: 'CI' }), { username: 'CI', icon_emoji: ':chart:' });
    assert.deepEqual(selectIdentity(w, { icon_url: 'https://x/y.png' }), { username: 'Grafana', icon_url: 'https://x/y.png' });
    assert.deepEqual(selectIdentity(w, { icon_emoji: ':ok:', icon_url: 'https://x/y.png' }), { username: 'Grafana', icon_emoji: ':ok:' });
});

test('selectIdentity with no defaults posts as the bot', () => {
    assert.deepEqual(selectIdentity({ defaultIdentity: {}, allowIdentityOverride: false }, {}), {});
});

test('buildPostArgs requires some content', () => {
    assert.equal(buildPostArgs(webhook, {}, 'C0DEFAULT1'), NO_TEXT);
    assert.equal(buildPostArgs(webhook, { text: '' }, 'C0DEFAULT1'), NO_TEXT);
    assert.equal(buildPostArgs(webhook, { blocks: [] }, 'C0DEFAULT1'), NO_TEXT);
    assert.ok(!isResponse(buildPostArgs(webhook, { attachments: [{ text: 'x' }] }, 'C0DEFAULT1')));
});

test('buildPostArgs passes supported fields and drops the rest', () => {
    const args = buildPostArgs(webhook, {
        text: 'hi', thread_ts: '1.2', mrkdwn: false, unfurl_links: true, channel: '#ignored',
        username: 'Evil', ...({ as_user: true, token: 'x' } as object),
    }, 'C0DEFAULT1');
    assert.deepEqual(args, {
        channel: 'C0DEFAULT1', username: 'Grafana', icon_emoji: ':chart:',
        text: 'hi', thread_ts: '1.2', mrkdwn: false, unfurl_links: true,
    });
});

test('mapSlackError mirrors webhook error codes', () => {
    assert.deepEqual(mapSlackError('not_in_channel'), CHANNEL_NOT_FOUND);
    assert.deepEqual(mapSlackError('is_archived'), { status: 410, body: 'channel_is_archived' });
    assert.deepEqual(mapSlackError('restricted_action'), { status: 403, body: 'action_prohibited' });
    assert.deepEqual(mapSlackError('something_new'), { status: 500, body: 'internal_error' });
});

test('rateLimited sets Retry-After', () => {
    assert.deepEqual(rateLimited(30), { status: 429, body: 'rate_limited', headers: { 'Retry-After': '30' } });
    assert.equal(rateLimited(undefined).headers?.['Retry-After'], '1');
});

test('secrets verify only against their own hash', () => {
    const secret = generateSecret();
    assert.equal(secret.length, 32);
    const hash = hashSecret(secret);
    assert.ok(verifySecret(secret, hash));
    assert.ok(!verifySecret(secret + 'x', hash));
    assert.ok(!verifySecret('', hash));
    assert.ok(!verifySecret(secret, 'not-hex'));
});

test('ids and urls', () => {
    assert.match(generateWebhookId(), /^W[0-9A-Z]{10}$/);
    assert.equal(buildWebhookUrl('https://h.example/', 'WABC', 's3cr3t'), 'https://h.example/services/WABC/s3cr3t');
});
