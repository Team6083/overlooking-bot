import type { WebClient } from '@slack/web-api';
import { isIgnorableReactionError, STATUS_REACTIONS, StatusReaction } from './recheck-core';

async function tolerant(call: () => Promise<unknown>) {
    try {
        await call();
    } catch (err) {
        if (!isIgnorableReactionError(err)) throw err;
    }
}

/** Adds the status reaction to a message that has none yet. */
export async function addStatusReaction(client: WebClient, channel: string, ts: string, reaction: StatusReaction) {
    await tolerant(() => client.reactions.add({ channel, timestamp: ts, name: reaction }));
}

/** Makes `reaction` the only bot status reaction on the message. */
export async function setStatusReaction(client: WebClient, channel: string, ts: string, reaction: StatusReaction) {
    for (const name of STATUS_REACTIONS) {
        if (name === reaction) continue;
        await tolerant(() => client.reactions.remove({ channel, timestamp: ts, name }));
    }
    await addStatusReaction(client, channel, ts, reaction);
}
