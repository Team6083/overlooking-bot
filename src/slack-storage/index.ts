import { App, ignoreSelf, KnownEventFromType, subtype } from "@slack/bolt";
import { Job } from "bull";

import { getFileArrayBufFromSlack } from "../utils/slack";
import { ConversationFetchService, FetchFileResult, FetchFileTask, FetchHistoryResult, FetchHistoryTask, FetchRepliesResult, FetchRepliesTask } from "../conversation-fetch";
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

            this.fetchChannel(command.channel_id, command.text === 'force');

            respond({
                response_type: 'ephemeral',
                text: `Fetching channel ${command.channel_id}`,
            });
        });

        this.fetchService.onFetchHistoryComplete(this.handleHistoryJobDone.bind(this));
        this.fetchService.onFetchRepliesComplete(this.handleReplyJobDone.bind(this));
        this.fetchService.onFetchFileComplete(this.handleFileJobDone.bind(this));
    }

    async fetchChannel(channel: string, alwaysFetch = false) {
        const latest = await this.repo.findLatestMessage(channel);

        const afterTs = latest?.ts;
        if (!alwaysFetch && afterTs) {
            this.fetchService.fetchChannel(channel, undefined, afterTs);
        } else {
            this.fetchService.fetchChannel(channel);
        }
    }

    async fetchWorkspace() {
        const resp = await this.app.client.conversations.list({
            limit: 999,
            types: 'public_channel,private_channel',
        });

        if (resp.ok) {
            resp.channels?.forEach((v) => {
                console.log()
            });
        }

    }

    private async handleHistoryJobDone(job: Job<FetchHistoryTask>, result: FetchHistoryResult) {
        const task = job.data;

        await this.repo.saveMessages(result.messages.map((v) => {
            const ts = v.ts;
            if (!ts) {
                console.warn(`Hist: Message without ts@${task.channelId}: ${v.text}`);
            }

            return {
                ...v,
                ts: ts ?? '0',
                channel: task.channelId,
            };
        }));
    }

    private async handleReplyJobDone(job: Job<FetchRepliesTask>, result: FetchRepliesResult) {
        const task = job.data;

        await this.repo.saveMessages(result.messages.map((v) => {
            const ts = v.ts;
            if (!ts) {
                console.warn(`Replies: Message without ts@${task.channelId}: ${v.text}`);
            }

            return {
                ...v,
                ts: ts ?? '0',
                channel: task.channelId,
            };
        }));
    }

    private async handleFileJobDone(job: Job<FetchFileTask>, result: FetchFileResult) {
        const task = job.data;
        const meta = task.meta;
        const fileId = meta.id;

        if (!fileId) {
            console.error('File task without meta.id');
            return;
        }

        if (result.buf) {
            await this.repo.saveFile(result.buf, {
                ...meta, id: fileId
            });
        }
    }
}
