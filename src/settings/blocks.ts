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
                },
                {
                    type: "button",
                    text: {
                        type: "plain_text",
                        text: "Join public channels"
                    },
                    action_id: actions.joinPublicChannels,
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

export function getAddChannelsBlocks(channels: Channel[]): (Block | KnownBlock)[] {

    const blocks: (Block | KnownBlock)[] = [
        {
            type: "input",
            element: {
                type: "multi_static_select",
                placeholder: {
                    type: "plain_text",
                    text: "Select channels..."
                },
                options: channels.filter((v) => !!v.id).map((v) => {
                    return {
                        text: {
                            type: "plain_text",
                            text: v.name ?? v.id!,
                        },
                        value: v.id!
                    };
                }),
                action_id: actions.joinPublicChannelsSelect,
            },
            label: {
                type: "plain_text",
                text: "Select channels..."
            }
        },
        {
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: {
                        type: "plain_text",
                        text: "Submit"
                    },
                    action_id: actions.joinPublicChannelsSubmit
                },
                {
                    type: "button",
                    text: {
                        type: "plain_text",
                        text: "Add All"
                    },
                    action_id: actions.joinPublicChannelsAddAll
                },
                {
                    type: "button",
                    text: {
                        type: "plain_text",
                        text: "Back"
                    },
                    action_id: actions.goto,
                    value: goto_dest.menu,

                }
            ]
        }
    ];

    return blocks;
}
