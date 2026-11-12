import { App, type types } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { buildWebhookUrl, permittedChannels } from './core';
import { WebhookDoc, WebhookInput, WebhookStore } from './store';

type KnownBlock = types.KnownBlock;
type View = types.View;

const OWNER_TTL_MS = 5 * 60 * 1000;
const MAX_LISTED = 40; // App Home allows 100 blocks; each webhook uses two.

const FORM_CALLBACK = 'webhook_form';
const ROTATE_CALLBACK = 'webhook_rotate_confirm';
const DELETE_CALLBACK = 'webhook_delete_confirm';

const B = {
    name: 'wh_name',
    defaultChannel: 'wh_default_channel',
    allowedChannels: 'wh_allowed_channels',
    username: 'wh_username',
    iconEmoji: 'wh_icon_emoji',
    iconUrl: 'wh_icon_url',
    allowOverride: 'wh_allow_override',
} as const;

export type RepublishHome = (client: WebClient, userId: string) => Promise<void>;

/** App Home section and modals for managing webhooks. Only Slack workspace owners may use them. */
export class WebhookAdmin {
    private ownerCache = new Map<string, { owner: boolean; at: number }>();

    constructor(
        private app: App,
        private store: WebhookStore,
        private publicBaseUrl: string,
        private republishHome: RepublishHome,
    ) { }

    /**
     * Whether the user is a workspace owner. The cache is only for rendering the App Home;
     * anything that changes a webhook passes `fresh` so a just-demoted owner is refused.
     */
    async isOwner(client: WebClient, userId: string, { fresh = false } = {}): Promise<boolean> {
        const cached = this.ownerCache.get(userId);
        if (!fresh && cached && cached.at + OWNER_TTL_MS > Date.now()) return cached.owner;
        const res = await client.users.info({ user: userId });
        const owner = !!(res.user?.is_owner || res.user?.is_primary_owner);
        this.ownerCache.set(userId, { owner, at: Date.now() });
        return owner;
    }

    /** Blocks for the App Home; empty for non-owners. */
    async renderSection(client: WebClient, userId: string): Promise<KnownBlock[]> {
        if (!(await this.isOwner(client, userId))) return [];

        const webhooks = await this.store.list();
        const blocks: KnownBlock[] = [
            { type: 'divider' },
            {
                type: 'section',
                text: { type: 'mrkdwn', text: '*Webhooks*\nIncoming webhooks for external systems; messages are posted by this bot.' },
                accessory: {
                    type: 'button',
                    text: { type: 'plain_text', text: 'New webhook' },
                    style: 'primary',
                    action_id: 'webhook_create',
                },
            },
        ];

        if (webhooks.length === 0) {
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'No webhooks yet.' }] });
        }
        for (const w of webhooks.slice(0, MAX_LISTED)) {
            blocks.push(...renderRow(w));
        }
        if (webhooks.length > MAX_LISTED) {
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${webhooks.length - MAX_LISTED} more not shown.` }] });
        }
        return blocks;
    }

    /**
     * Run the work that follows an early ack. If it throws, replace the "Saving…" modal with an
     * error instead of leaving it spinning.
     */
    private async afterAck(update: (v: View) => Promise<unknown>, work: () => Promise<void>) {
        try {
            await work();
        } catch (err: any) {
            console.error('Webhook admin action failed', err);
            const code = err?.data?.error ?? err?.code ?? 'error';
            await update(renderMessage('Something went wrong', `:x: The change may not have been saved (\`${code}\`). Check the App Home and try again.`))
                .catch((e) => console.error('Failed to show error view', e));
        }
    }

    init() {
        this.app.action('webhook_create', async ({ ack, body, client }) => {
            await ack();
            if (body.type !== 'block_actions') return;
            if (!(await this.isOwner(client, body.user.id))) return;
            await client.views.open({ trigger_id: body.trigger_id, view: renderForm() });
        });

        this.app.action('webhook_row_menu', async ({ ack, body, action, client }) => {
            await ack();
            if (body.type !== 'block_actions' || action.type !== 'overflow') return;
            const userId = body.user.id;
            const [op, id] = action.selected_option.value.split(':');
            // Toggling changes state right away, so it needs an uncached owner check.
            if (!(await this.isOwner(client, userId, { fresh: op === 'toggle' }))) return;

            const webhook = await this.store.get(id);
            if (!webhook) return;

            if (op === 'edit') {
                await client.views.open({ trigger_id: body.trigger_id, view: renderForm({ editingId: webhook._id, values: webhook }) });
            } else if (op === 'rotate') {
                await client.views.open({ trigger_id: body.trigger_id, view: renderConfirm(ROTATE_CALLBACK, webhook, 'Regenerate URL', `Regenerate the URL of *${escape(webhook.name)}*? The current URL stops working immediately.`) });
            } else if (op === 'delete') {
                await client.views.open({ trigger_id: body.trigger_id, view: renderConfirm(DELETE_CALLBACK, webhook, 'Delete', `Delete *${escape(webhook.name)}*? This cannot be undone.`) });
            } else if (op === 'toggle') {
                await this.store.setEnabled(id, !webhook.enabled);
                await this.republishHome(client, userId);
            }
        });

        // Slack drops a view_submission response after 3s, and the membership checks below can take
        // longer. So only cheap validation happens before ack(); the rest updates the modal after.
        this.app.view(FORM_CALLBACK, async ({ ack, body, view, client }) => {
            const userId = body.user.id;
            const editingId = view.private_metadata;
            const input = readForm(view.state.values);

            const errors = validateForm(input);
            if (Object.keys(errors).length > 0) {
                await ack({ response_action: 'errors', errors });
                return;
            }
            await ack({ response_action: 'update', view: renderMessage(editingId ? 'Edit webhook' : 'New webhook', ':hourglass_flowing_sand: Saving…') });
            const update = (v: View) => client.views.update({ view_id: view.id, view: v });
            await this.afterAck(update, async () => {
                if (!(await this.isOwner(client, userId, { fresh: true }))) {
                    await update(renderMessage('Not allowed', 'Only Slack workspace owners can manage webhooks.'));
                    return;
                }

                const problems = await ensureMembership(client, input);
                if (problems) {
                    await update(renderForm({ editingId, values: input, error: problems }));
                    return;
                }

                if (editingId) {
                    await this.store.update(editingId, input);
                    await update(renderMessage('Edit webhook', `:white_check_mark: *${escape(input.name)}* saved.`));
                } else {
                    const { doc, secret } = await this.store.create(input, userId);
                    await update(renderSecret(doc, buildWebhookUrl(this.publicBaseUrl, doc._id, secret), 'Webhook created'));
                }
            });
            // Outside afterAck: a failure here must not replace a just-shown URL with an error.
            await this.republishHome(client, userId).catch((err) => console.error('Failed to refresh App Home', err));
        });

        this.app.view(ROTATE_CALLBACK, async ({ ack, body, view, client }) => {
            await ack({ response_action: 'update', view: renderMessage('Regenerate URL', ':hourglass_flowing_sand: Working…') });
            const update = (v: View) => client.views.update({ view_id: view.id, view: v });
            const userId = body.user.id;
            await this.afterAck(update, async () => {
                if (!(await this.isOwner(client, userId, { fresh: true }))) {
                    await update(renderMessage('Not allowed', 'Only Slack workspace owners can manage webhooks.'));
                    return;
                }
                const webhook = await this.store.get(view.private_metadata);
                const secret = webhook && await this.store.rotateSecret(webhook._id);
                if (!webhook || !secret) {
                    await update(renderMessage('Regenerate URL', 'This webhook no longer exists.'));
                    return;
                }
                await update(renderSecret(webhook, buildWebhookUrl(this.publicBaseUrl, webhook._id, secret), 'URL regenerated'));
            });
            // Outside afterAck: a failure here must not replace a just-shown URL with an error.
            await this.republishHome(client, userId).catch((err) => console.error('Failed to refresh App Home', err));
        });

        this.app.view(DELETE_CALLBACK, async ({ ack, body, view, client }) => {
            await ack();
            const userId = body.user.id;
            if (!(await this.isOwner(client, userId, { fresh: true }))) return;
            await this.store.delete(view.private_metadata);
            await this.republishHome(client, userId);
        });
    }
}

function validateForm(input: WebhookInput): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!input.name) errors[B.name] = 'Name is required.';
    if (!input.defaultChannel) errors[B.defaultChannel] = 'Default channel is required.';
    if (input.defaultIdentity.iconUrl && !/^https?:\/\//.test(input.defaultIdentity.iconUrl)) {
        errors[B.iconUrl] = 'Icon URL must start with http:// or https://.';
    }
    if (input.defaultIdentity.iconEmoji && !/^:[^:\s]+:$/.test(input.defaultIdentity.iconEmoji)) {
        errors[B.iconEmoji] = 'Use the :emoji_name: form.';
    }
    return errors;
}

// ---------- membership ----------

/**
 * Make sure the bot can post to every permitted channel: join public channels it is not in,
 * and report private ones it has not been invited to. Returns a mrkdwn problem summary, or
 * null when every channel is usable.
 */
async function ensureMembership(client: WebClient, input: WebhookInput): Promise<string | null> {
    const problems: string[] = [];

    await Promise.all(permittedChannels(input).map(async (id) => {
        let info;
        try {
            info = await client.conversations.info({ channel: id });
        } catch (err: any) {
            if (err?.data?.error === 'channel_not_found') {
                // The bot cannot see private channels it has not been invited to.
                problems.push(`<#${id}>: private channel, invite the bot first (\`/invite @bot\`)`);
            } else {
                problems.push(`<#${id}>: could not check the channel (\`${err?.data?.error ?? err?.code ?? 'error'}\`), try again`);
            }
            return;
        }
        const ch = info.channel;
        if (!ch) return;
        if (ch.is_archived) {
            problems.push(`<#${id}>: archived`);
        } else if (ch.is_member) {
            return;
        } else if (ch.is_private) {
            problems.push(`<#${id}>: private channel, invite the bot first (\`/invite @bot\`)`);
        } else {
            try {
                await client.conversations.join({ channel: id });
            } catch (err: any) {
                problems.push(`<#${id}>: the bot could not join (\`${err?.data?.error ?? 'error'}\`)`);
            }
        }
    }));

    return problems.length ? `:warning: The bot cannot post to:\n• ${problems.join('\n• ')}` : null;
}

// ---------- rendering ----------

function escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slackDate(d: Date): string {
    const unix = Math.floor(d.getTime() / 1000);
    return `<!date^${unix}^{date_short_pretty} {time}|${d.toISOString()}>`;
}

function describeIdentity(w: WebhookDoc): string {
    const parts: string[] = [];
    parts.push(w.defaultIdentity.username ? escape(w.defaultIdentity.username) : 'bot name');
    if (w.defaultIdentity.iconEmoji) parts.push(w.defaultIdentity.iconEmoji);
    else if (w.defaultIdentity.iconUrl) parts.push('custom icon');
    return parts.join(' ') + (w.allowIdentityOverride ? ' (overridable)' : '');
}

function renderRow(w: WebhookDoc): KnownBlock[] {
    const extra = w.allowedChannels.filter((c) => c !== w.defaultChannel);
    const channels = `<#${w.defaultChannel}>` + (extra.length ? ` (also: ${extra.map((c) => `<#${c}>`).join(', ')})` : '');
    const status = w.enabled ? '' : ' · :no_entry: *disabled*';

    const meta: string[] = [`Created by <@${w.createdBy}>`];
    meta.push(w.lastUsedAt ? `last used ${slackDate(w.lastUsedAt)}` : 'never used');
    if (w.lastError) meta.push(`:warning: last error \`${w.lastError.code}\` ${slackDate(w.lastError.at)}`);

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: `*${escape(w.name)}*${status}\n${channels} · as ${describeIdentity(w)}` },
            accessory: {
                type: 'overflow',
                action_id: 'webhook_row_menu',
                options: [
                    { text: { type: 'plain_text', text: 'Edit' }, value: `edit:${w._id}` },
                    { text: { type: 'plain_text', text: 'Regenerate URL' }, value: `rotate:${w._id}` },
                    { text: { type: 'plain_text', text: w.enabled ? 'Disable' : 'Enable' }, value: `toggle:${w._id}` },
                    { text: { type: 'plain_text', text: 'Delete' }, value: `delete:${w._id}` },
                ],
            },
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: meta.join(' · ') }] },
    ];
}

function textInput(blockId: string, label: string, opts: { initial?: string; optional?: boolean; placeholder?: string; hint?: string } = {}): KnownBlock {
    return {
        type: 'input',
        block_id: blockId,
        optional: opts.optional,
        label: { type: 'plain_text', text: label },
        hint: opts.hint ? { type: 'plain_text', text: opts.hint } : undefined,
        element: {
            type: 'plain_text_input',
            action_id: 'value',
            initial_value: opts.initial || undefined,
            placeholder: opts.placeholder ? { type: 'plain_text', text: opts.placeholder } : undefined,
        },
    };
}

function renderForm({ editingId, values: w, error }: { editingId?: string; values?: WebhookInput; error?: string } = {}): View {
    const overrideOption = { text: { type: 'plain_text' as const, text: 'Let callers override username and icon' }, value: 'allow' };
    return {
        type: 'modal',
        callback_id: FORM_CALLBACK,
        private_metadata: editingId ?? '',
        title: { type: 'plain_text', text: editingId ? 'Edit webhook' : 'New webhook' },
        submit: { type: 'plain_text', text: editingId ? 'Save' : 'Create' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
            ...(error ? [{ type: 'section', text: { type: 'mrkdwn', text: error } } as KnownBlock] : []),
            textInput(B.name, 'Name', { initial: w?.name, placeholder: 'e.g. Grafana alerts' }),
            {
                type: 'input',
                block_id: B.defaultChannel,
                label: { type: 'plain_text', text: 'Default channel' },
                hint: { type: 'plain_text', text: 'Used when the caller does not send a channel.' },
                element: {
                    type: 'conversations_select',
                    action_id: 'value',
                    initial_conversation: w?.defaultChannel,
                    filter: { include: ['public', 'private'], exclude_bot_users: true },
                },
            },
            {
                type: 'input',
                block_id: B.allowedChannels,
                optional: true,
                label: { type: 'plain_text', text: 'Other allowed channels' },
                hint: { type: 'plain_text', text: 'Callers may pick these with the "channel" field. Any other channel is rejected.' },
                element: {
                    type: 'multi_conversations_select',
                    action_id: 'value',
                    initial_conversations: w?.allowedChannels.length ? w.allowedChannels : undefined,
                    filter: { include: ['public', 'private'], exclude_bot_users: true },
                },
            },
            { type: 'header', text: { type: 'plain_text', text: 'Identity' } },
            textInput(B.username, 'Display name', { initial: w?.defaultIdentity.username, optional: true, hint: 'Leave empty to post under the bot\'s name.' }),
            textInput(B.iconEmoji, 'Icon emoji', { initial: w?.defaultIdentity.iconEmoji, optional: true, placeholder: ':robot_face:' }),
            textInput(B.iconUrl, 'Icon URL', { initial: w?.defaultIdentity.iconUrl, optional: true, hint: 'Ignored when an icon emoji is set.' }),
            {
                type: 'input',
                block_id: B.allowOverride,
                optional: true,
                label: { type: 'plain_text', text: 'Overrides' },
                element: {
                    type: 'checkboxes',
                    action_id: 'value',
                    options: [overrideOption],
                    initial_options: w?.allowIdentityOverride ? [overrideOption] : undefined,
                },
            },
        ],
    };
}

function readForm(values: Record<string, Record<string, any>>): WebhookInput {
    const text = (block: string) => (values[block]?.value?.value ?? '').trim();
    const defaultChannel: string = values[B.defaultChannel]?.value?.selected_conversation ?? '';
    const allowed: string[] = values[B.allowedChannels]?.value?.selected_conversations ?? [];
    return {
        name: text(B.name),
        defaultChannel,
        allowedChannels: allowed.filter((c) => c !== defaultChannel),
        defaultIdentity: {
            username: text(B.username) || undefined,
            iconEmoji: text(B.iconEmoji) || undefined,
            iconUrl: text(B.iconUrl) || undefined,
        },
        allowIdentityOverride: (values[B.allowOverride]?.value?.selected_options ?? []).length > 0,
    };
}

function renderConfirm(callbackId: string, w: WebhookDoc, submit: string, text: string): View {
    return {
        type: 'modal',
        callback_id: callbackId,
        private_metadata: w._id,
        title: { type: 'plain_text', text: 'Are you sure?' },
        submit: { type: 'plain_text', text: submit },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    };
}

function renderMessage(title: string, text: string): View {
    return {
        type: 'modal',
        title: { type: 'plain_text', text: title },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    };
}

function renderSecret(w: WebhookDoc, url: string, title: string): View {
    return {
        type: 'modal',
        title: { type: 'plain_text', text: title },
        close: { type: 'plain_text', text: 'Done' },
        blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*${escape(w.name)}* webhook URL:` } },
            { type: 'section', text: { type: 'mrkdwn', text: '```' + url + '```' } },
            { type: 'context', elements: [{ type: 'mrkdwn', text: ':warning: This URL is shown only once. Copy it now; if it is lost, regenerate it.' }] },
        ],
    };
}
