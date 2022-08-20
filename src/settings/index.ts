import { App } from "@slack/bolt";
import { ConversationsListResponse, WebClient } from "@slack/web-api";
import { actions, goto_dest } from "./actions";
import { getAddChannelsBlocks, getShowConversationsBlocks, getStorageSettingBlocks } from "./blocks";

const adminList = ['U1FQ5GP6D'];

const convListResps: { [key: string]: { resp: ConversationsListResponse, time: number } } = {};

const add_channel_select: { [key: string]: string[] } = {};

async function getConversationLists(client: WebClient, team_id: string): Promise<ConversationsListResponse> {
    if (!convListResps[team_id] || Date.now() - convListResps[team_id].time > 30000) {
        console.log('fetching');

        const resp = await client.conversations.list({ types: 'public_channel,private_channel', team_id });;
        convListResps[team_id] = {
            resp,
            time: Date.now(),
        };
    }

    return convListResps[team_id].resp;
}

export async function registerStorageSettings(app: App) {
    app.command('/storage_settings', async ({ command, client, ack }) => {
        await ack();

        if (!adminList.includes(command.user_id)) {
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: command.user_id,
                text: 'You are not admin.'
            });
            return;
        }

        const convListResp = await getConversationLists(client, command.team_id);

        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            blocks: getStorageSettingBlocks(convListResp.channels?.filter((v) => v.is_member).length)
        });
    });

    app.action(actions.showConversations, async ({ ack, action, body, client, respond }) => {
        await ack();

        if (!body.team) return;

        if (action.type === 'button') {
            if (!adminList.includes(body.user.id)) {

                await respond({
                    response_type: 'ephemeral',
                    replace_original: false,
                    text: 'You are not admin.'
                });
                return;
            }

            const convListResp = await getConversationLists(client, body.team.id);

            if (convListResp.channels) {
                await respond({
                    response_type: 'ephemeral',
                    blocks: getShowConversationsBlocks(convListResp.channels.filter((v) => v.is_member), convListResp.response_metadata?.next_cursor),
                });
            }
        }
    });

    app.action(actions.goto, async ({ ack, action, body, client, respond }) => {
        await ack();

        if (!body.team) return;

        if (action.type === 'button') {
            if (!adminList.includes(body.user.id)) {

                await respond({
                    response_type: 'ephemeral',
                    replace_original: false,
                    text: 'You are not admin.'
                });
                return;
            }

            if (action.value === goto_dest.menu) {
                const convListResp = await getConversationLists(client, body.team.id);

                await respond({
                    response_type: 'ephemeral',
                    blocks: getStorageSettingBlocks(convListResp.channels?.filter((v) => v.is_member).length)
                });
            }
        }
    });

    app.action(actions.joinPublicChannels, async ({ ack, action, body, client, respond }) => {
        await ack();

        if (!body.team) return;

        if (action.type === 'button') {
            const convListResp = await getConversationLists(client, body.team.id);

            if (convListResp.channels) {
                const non_member_public_channels = convListResp.channels.filter((v) => v.is_channel && !v.is_private && !v.is_member && !v.is_archived);

                await respond({
                    response_type: 'ephemeral',
                    blocks: getAddChannelsBlocks(non_member_public_channels)
                });
            }
        }
    });

    app.action(actions.joinPublicChannelsSelect, async ({ ack, action, body }) => {
        await ack();

        if (action.type === 'multi_static_select') {
            add_channel_select[body.user.id] = action.selected_options.map((v) => v.value);
        }
    });

    app.action(actions.joinPublicChannelsSubmit, async ({ ack, action, body, client, respond }) => {
        await ack();

        if (action.type === 'button') {
            const channels = add_channel_select[body.user.id];

            console.log(channels);

            const results = await Promise.all(channels.map((v) => client.conversations.join({
                channel: v,
            })));

            await respond({
                response_type: 'ephemeral',
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `Conversations added.\n${results.map((v) => v.channel?.id ? ` <#${v.channel?.id}>` : '')}`
                        }
                    }
                ],
            });
        }
    });
}
