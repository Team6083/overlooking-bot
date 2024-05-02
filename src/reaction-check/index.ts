import { App } from "@slack/bolt";
import { Member } from "@slack/web-api/dist/response/UsersListResponse";


export class ReactionCheckModule {
    constructor(
        private app: App,
        userIgnoreList: string[],
    ) {
        this.ignoredUsers = new Set(userIgnoreList);
    }

    private userList?: Member[];
    private userListTS?: number;

    private ignoredUsers = new Set<string>();

    private async getUsers(): Promise<Member[] | undefined> {
        if (this.userListTS && this.userList && this.userListTS + 10 * 60 * 1000 >= Date.now()) {
            return this.userList;
        }

        const users = (await this.app.client.users.list())
            .members?.filter((v) => !v.is_invited_user && !v.is_app_user && !v.is_bot && !v.deleted && v.id !== 'USLACKBOT');

        this.userList = users;
        this.userListTS = Date.now();
        return users;
    }

    async init() {
        this.app.shortcut('reaction_check', async ({ shortcut, ack, client, payload, logger }) => {
            // Acknowledge shortcut request
            await ack();

            const { type } = payload;
            if (type === 'message_action') {
                const { channel, message } = payload;

                const res = await client.conversations.history({
                    channel: channel.id,
                    latest: message.ts,
                    inclusive: true,
                    include_all_metadata: true,
                    limit: 1
                });


                const users = await this.getUsers();
                if (!users) {
                    logger.error('Failed to get users');
                    return;
                }

                if (res.messages?.length && res.messages?.length > 0) {
                    const reactionSet = new Set<string>(
                        res.messages[0].reactions?.flatMap(({ users }) => users ?? [])
                    );

                    const noReactUsers = users.filter((v) => v.id &&
                        !reactionSet.has(v.id) && !this.ignoredUsers.has(v.id));

                    await client.views.open({
                        trigger_id: shortcut.trigger_id,
                        view: {
                            type: "modal",
                            title: {
                                type: "plain_text",
                                text: "My App"
                            },
                            close: {
                                type: "plain_text",
                                text: "Close"
                            },
                            blocks: [
                                {
                                    type: "section",
                                    text: {
                                        type: "plain_text",
                                        emoji: true,
                                        text: "Following users didn't react:"
                                    }
                                },
                                {
                                    type: "divider"
                                },
                                {
                                    "type": "section",
                                    "text": {
                                        "type": "mrkdwn",
                                        "text": noReactUsers.map((v) => `<@${v.id}>`).join(','),
                                    }
                                }
                            ]
                        }
                    });
                }
            }
        });
    }
}
