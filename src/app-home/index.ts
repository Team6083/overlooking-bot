import { App, View } from "@slack/bolt";

function renderAppHome(): View {
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
            }
        ]
    };
}

function renderAppHomeHelp(): View {
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
    constructor(private app: App) { }

    async init() {
        // Listen for users opening your App Home
        this.app.event('app_home_opened', async ({ event, client, logger }) => {
            try {
                // Call views.publish with the built-in client
                const result = await client.views.publish({
                    // Use the user ID associated with the event
                    user_id: event.user,
                    view: renderAppHome()
                });

                logger.info(result);
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
