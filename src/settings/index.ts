import { App } from "@slack/bolt";
import { ConversationsListResponse, WebClient } from "@slack/web-api";
import { actions, goto_dest } from "./actions";
import { getAddConversationsBlocks, getShowConversationsBlocks, getStorageSettingBlocks } from "./blocks";

const adminList = ['U1FQ5GP6D'];

const convListResps: { [key: string]: { resp: ConversationsListResponse, time: number } } = {};

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

    app.action(actions.addConversations, async ({ ack, action, body, respond }) => {
        await ack();

        if (action.type === 'button') {
            if (!adminList.includes(body.user.id)) {

                await respond({
                    response_type: 'ephemeral',
                    replace_original: false,
                    text: 'You are not admin.'
                });
                return;
            }

            await respond({
                response_type: 'ephemeral',
                blocks: getAddConversationsBlocks(),
            });
        }
    });

    app.action(actions.addConversationsSelect, async ({ ack, action, client, body, respond }) => {
        await ack();

        if (!body.team) return;

        if (action.type === 'multi_conversations_select') {
            const selected = action.selected_conversations;

            const convListResp = await getConversationLists(client, body.team.id);

            await respond({
                response_type: 'ephemeral',
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `Conversations added.\n${selected.map((v) => ` <#${v}>`)}`
                        }
                    }
                ]
            });
        }
    });
}
