import { WebClient } from "@slack/web-api";
import { FetchFileResult, FetchFileTask, FetchHistoryResult, FetchHistoryTask, FetchRepliesResult, FetchRepliesTask, SlackAPIError } from "./types";
import { getFileArrayBufFromSlack } from "../utils/slack";

export async function fetchHistory(webAPI: WebClient, task: FetchHistoryTask): Promise<FetchHistoryResult> {
    const { channelId, cursor, before, after } = task;

    const result = await webAPI.conversations.history({
        channel: channelId,
        include_all_metadata: true,
        limit: 999,
        cursor,
        latest: before,
        oldest: after,
    });

    if (result.ok) {
        const nextCursor = result.response_metadata?.next_cursor;

        return {
            messages: result.messages ?? [],
            nextCursor,
        }
    } else {
        throw new SlackAPIError(result.error ?? "unknown");
    }
}

export async function fetchReplies(webAPI: WebClient, task: FetchRepliesTask): Promise<FetchRepliesResult> {
    const { channelId, ts, cursor } = task;

    const result = await webAPI.conversations.replies({
        channel: channelId,
        ts,
        cursor,
    });

    if (result.ok) {
        const nextCursor = result.response_metadata?.next_cursor;

        return {
            messages: result.messages ?? [],
            nextCursor,
        }
    } else {
        throw new SlackAPIError(result.error ?? "unknown");
    }
}

export async function fetchFile(webAPI: WebClient, task: FetchFileTask): Promise<FetchFileResult> {
    const { url_private_download: url } = task;

    return {
        buf: await getFileArrayBufFromSlack(url, webAPI.token),
    };
}
