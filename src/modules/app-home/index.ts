import { App, type types } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

/** Extra App Home blocks contributed by other modules, rendered per viewing user. */
export type HomeSection = (client: WebClient, userId: string) => Promise<types.KnownBlock[]>;

function renderAppHome(extraBlocks: types.KnownBlock[] = []): types.View {
    return {
        "type": "home",
        "blocks": [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": "Here's what you can do with Overlooking Bot:"
                }
            },
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "To-do List",
                            "emoji": true
                        },
                        "style": "primary",
                        "action_id": "todo_list-home_btn",
                    },
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "Help",
                            "emoji": true
                        },
                        "action_id": "help-home_btn"
                    }
                ]
            },
            ...extraBlocks,
        ]
    };
}

function renderAppHomeHelp(): types.View {
    return {
        "type": "modal",
        "close": {
            "type": "plain_text",
            "text": "Close",
            "emoji": true
        },
        "title": {
            "type": "plain_text",
            "text": "Help",
            "emoji": true
        },
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "plain_text",
                    "text": ":cry: Nothing here...",
                    "emoji": true
                }
            }
        ]
    };
}

export class AppHomeModule {
    private sections: HomeSection[] = [];

    constructor(private app: App) { }

    addSection(section: HomeSection) {
        this.sections.push(section);
    }

    async publish(client: WebClient, userId: string) {
        // A failing section is logged and skipped so the rest of the home still renders.
        const extra = (await Promise.all(this.sections.map((s) => s(client, userId).catch((err) => {
            console.error('App Home section failed', err);
            return [];
        })))).flat();
        await client.views.publish({ user_id: userId, view: renderAppHome(extra) });
    }

    async init() {
        // Listen for users opening your App Home
        this.app.event('app_home_opened', async ({ event, client, logger }) => {
            try {
                await this.publish(client, event.user);
            }
            catch (error) {
                logger.error(error);
            }
        });


        // Handle help button on App Home
        this.app.action('help-home_btn', async ({ ack, body, client, logger }) => {
            await ack();

            if (body.type === 'block_actions') {
                try {
                    // Call views.open with the built-in client
                    const result = await client.views.open({
                        // Pass a valid trigger_id within 3 seconds of receiving it
                        trigger_id: body.trigger_id,
                        // View payload
                        view: renderAppHomeHelp(),
                    });
                    logger.info(result);
                }
                catch (error) {
                    logger.error(error);
                }
            }
        });
    }
}
