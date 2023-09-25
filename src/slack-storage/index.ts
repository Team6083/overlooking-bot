import { App, ignoreSelf, KnownEventFromType, subtype } from "@slack/bolt";
import { mkdir } from "fs/promises";
import { Collection } from "mongodb";
import { downloadFileFromSlack } from "../utils/slack";

export class SlackStorageModule {

    constructor(
        private app: App,
        private msgCollection: Collection,
        private changedMsgCollection: Collection,
        private deletedMsgCollection: Collection,
        private fileSavePrefix: string
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
                        token: process.env.SLACK_USER_TOKEN,
                    });
                }
            }

            await ignoreSelf()(args);
        });

        this.app.message('', async ({ message, logger }) => {
            await this.msgCollection.insertOne(message);

            if (message.subtype === 'file_share' && message.files && this.fileSavePrefix) {
                await Promise.all(message.files.map(async (v) => {
                    if (v.url_private_download) {
                        const dirPath = `${this.fileSavePrefix}/${message.user}/${v.id}`;
                        await mkdir(dirPath, { recursive: true });

                        const filePath = `${dirPath}/${v.name}`;
                        await downloadFileFromSlack(v.url_private_download, filePath, this.app.client.token);

                        logger.debug(`Saving file ${v.permalink} to ${filePath}`);
                    }
                }));
            }
        });

        this.app.message(subtype('message_changed'), async ({ event }) => {
            await this.changedMsgCollection.insertOne(event);
        });

        this.app.message(subtype('message_deleted'), async ({ event }) => {
            await this.deletedMsgCollection.insertOne(event);
        });
    }
}
