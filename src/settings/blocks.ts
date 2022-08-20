import { Block, KnownBlock } from "@slack/bolt";
import { Channel } from "@slack/web-api/dist/response/ConversationsListResponse";
import { actions, goto_dest } from "./actions";

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

    const buttons: Block | KnownBlock = {
        type: "actions",
        elements: [
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: "Back"
                },
                value: goto_dest.menu,
                action_id: actions.goto
            }
        ]
    };

    if (next_cursor) {
        buttons.elements.push({
            type: "button",
            text: {
                type: "plain_text",
                text: "Next Page"
            },
            value: next_cursor,
            action_id: actions.showConversationsNextPage
        });
    }

    blocks.push(buttons);

    return blocks;
}
