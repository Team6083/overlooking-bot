import { Block, KnownBlock } from "@slack/bolt";
import { Channel } from "@slack/web-api/dist/response/ConversationsListResponse";
import { actions } from "./actions";

export function getStorageSettingBlocks(channelCount: number | undefined): (Block | KnownBlock)[] {
    return [
        {
            type: "section",
            text: {
                type: "plain_text",
                text: `Listening ${channelCount ?? 'n/a'} channels.`
            }
        },
        {
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: {
                        type: "plain_text",
                        text: "Show Conversations"
                    },
                    action_id: actions.showConversations
                }
            ]
        }
    ];
}

export function getShowConversationsBlocks(channels: Channel[], next_cursor?: string): (Block | KnownBlock)[] {
    const blocks: (Block | KnownBlock)[] = [
        {
            type: "section",
            text: {
                type: "plain_text",
                text: "Here's all conversations that I'm listening."
            }
        },
        {
            type: "divider"
        },
        ...channels.map((v) => ({
            type: "section",
            text: {
                type: "mrkdwn",
                text: `*${v.id}*: <#${v.id}> (${v.name})`
            }
        }))
    ];

    if (next_cursor) {
        blocks.push(
            {
                type: "actions",
                elements: [
                    {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "Next Page"
                        },
                        value: next_cursor,
                        action_id: actions.showConversationsNextPage
                    }
                ]
            }
        );
    }

    return blocks;
}
