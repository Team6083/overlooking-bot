import { App, ignoreSelf, KnownEventFromType, subtype } from "@slack/bolt";
import { Job } from "bull";

import { getFileArrayBufFromSlack } from "../utils/slack";
import { ConversationFetchService } from "../conversation-fetch";
import { SlackStorageRepository } from "../message-repository";

export class SlackStorageModule {

    constructor(
        private app: App,
        private repo: SlackStorageRepository,
        private fetchService: ConversationFetchService,
        private slackUserToken: string,
    ) { }

    async init() {
        // process self channel join and apply ignore self
        this.app.use(async (args) => {

            if (args.payload.type === 'message') {
                const payload = args.payload as KnownEventFromType<'message'>

                // delete join message
                if (payload.subtype === 'channel_join' && payload.user === args.context.botUserId) {
                    await args.client.chat.delete({
                        channel: payload.channel,
                        ts: payload.ts,
                        token: this.slackUserToken,
                    });
                }
            }

            await ignoreSelf()(args);
        });

        this.app.message('', async ({ message, logger }) => {
            logger.debug(`Got ${message.ts} @ ${message.channel}`);

            await this.repo.onMessage(message);

            if (message.subtype === 'file_share' && message.files) {
                await Promise.all(message.files.map(async (v) => {
                    if (v.url_private_download) {

                        logger.debug(`Saving file ${v.permalink}`);

                        const buf = await getFileArrayBufFromSlack(v.url_private_download, this.app.client.token);

                        await this.repo.saveFile(buf, {
                            ...v,
                            name: v.name ?? undefined,
                        });
                    }
                }));
            }
        });

        this.app.message(subtype('message_changed'), async ({ event, logger }) => {
            if (event.subtype !== 'message_changed') {
                logger.error(`Got ${event.ts} @ ${event.channel} but not subtype message_changed`);
                return;
            }
            await this.repo.onMessageChanged(event);
        });

        this.app.message(subtype('message_deleted'), async ({ event, logger }) => {
            if (event.subtype !== 'message_deleted') {
                logger.error(`Got ${event.ts} @ ${event.channel} but not subtype message_deleted`);
                return;
            }
            await this.repo.onMessageDeleted(event);
        });

        this.app.command('/fetch_channel', async ({ command, ack, respond }) => {
            ack();

            if (command.text === "workspace") {
                this.fetchWorkspace();
                respond({
                    response_type: 'ephemeral',
                    text: `Fetching workspace`,
                });
                return;
            }

            const alwaysFetch = command.text.includes('force');
            const includeFiles = command.text.includes('file');

            this.fetchChannel(command.channel_id, alwaysFetch, includeFiles);

            respond({
                response_type: 'ephemeral',
                text: `Fetching channel ${command.channel_id}, alwaysFetch: ${alwaysFetch}, includeFiles: ${includeFiles}`,
            });
        });
    }

    async fetchChannel(channel: string, alwaysFetch = false, includeFiles = false) {
        const latest = await this.repo.findLatestMessage(channel);

        const afterTs = !alwaysFetch ? latest?.ts : undefined;

        this.fetchService.fetchChannel(channel, {
            after: afterTs,
            downloadFiles: includeFiles,
        });
    }

    async fetchWorkspace() {
        const resp = await this.app.client.conversations.list({
            limit: 999,
            types: 'public_channel,private_channel',
        });

        if (resp.ok && resp.channels) {
            const chans = [];

            Promise.all(resp.channels?.map(async (v) => {
                console.log(`${v.id} ${v.name}`);

                if (!v.id) {
                    console.error(`Channel ${v.name} has no id`);
                    return;
                }

                await this.fetchService.fetchChannel(v.id, {
                    downloadFiles: true,
                });
            }) ?? []);
        }
    }
}
