import 'dotenv/config';
import { WebClient } from '@slack/web-api';

// Lists every channel visible to SLACK_USER_TOKEN, then invites the bot user into each one.
// Usage: npx ts-node src/scripts/join-all-channels.ts [--dry-run]
// Env INVITE_DELAY_MS sets the pause between invites (default 1500).

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
    const userToken = process.env.SLACK_USER_TOKEN;
    if (!userToken) throw new Error('Env SLACK_USER_TOKEN is required.');
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) throw new Error('Env SLACK_BOT_TOKEN is required.');

    const dryRun = process.argv.includes('--dry-run');
    const delayMs = Number(process.env.INVITE_DELAY_MS ?? 1500);
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Env INVITE_DELAY_MS must be a non-negative number.');

    const userClient = new WebClient(userToken);
    const botClient = new WebClient(botToken);

    const botUserId = (await botClient.auth.test()).user_id;
    if (!botUserId) throw new Error('Cannot resolve bot user id.');
    console.log(`Bot user: ${botUserId}${dryRun ? ' (dry run)' : ''}`);

    // Channels the bot is already a member of (needs channels:read + groups:read on the bot token).
    const botChannelIds = new Set<string>();
    let botCursor: string | undefined;
    do {
        const res = await botClient.users.conversations({
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 200,
            cursor: botCursor,
        });
        for (const c of res.channels ?? []) {
            if (c.id) botChannelIds.add(c.id);
        }
        botCursor = res.response_metadata?.next_cursor || undefined;
    } while (botCursor);

    const channels: { id: string; name: string; userIsMember: boolean }[] = [];
    let cursor: string | undefined;
    do {
        const res = await userClient.conversations.list({
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 200,
            cursor,
        });
        for (const c of res.channels ?? []) {
            if (c.id) channels.push({ id: c.id, name: c.name ?? c.id, userIsMember: c.is_member === true });
        }
        cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);

    console.log(`Found ${channels.length} channels.`);

    let invited = 0, already = 0, skipped = 0, failed = 0;
    for (const [i, c] of channels.entries()) {
        const label = `[${i + 1}/${channels.length}] #${c.name} (${c.id})`;
        if (botChannelIds.has(c.id)) {
            already++;
            console.log(`${label} -> already in channel`);
            continue;
        }
        // conversations.invite requires the inviting user to be in the channel.
        if (!c.userIsMember) {
            skipped++;
            console.log(`${label} -> skipped (token user is not a member)`);
            continue;
        }
        if (dryRun) {
            invited++;
            console.log(`${label} -> would invite`);
            continue;
        }

        try {
            await userClient.conversations.invite({ channel: c.id, users: botUserId });
            invited++;
            console.log(`${label} -> invited`);
        } catch (err: any) {
            const code = err?.data?.error;
            if (code === 'already_in_channel') {
                already++;
                console.log(`${label} -> already in channel`);
            } else {
                failed++;
                console.error(`${label} -> failed: ${code ?? err?.message ?? err}`);
            }
        }

        await sleep(delayMs);
    }

    console.log(`Done. ${dryRun ? 'would_invite' : 'invited'}=${invited} already=${already} skipped=${skipped} failed=${failed}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
