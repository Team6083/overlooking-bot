import { config } from 'dotenv';
config();
import { App, LogLevel } from '@slack/bolt';
import * as mongoDB from 'mongodb';
import { getChangedMsgCollection, getDeletedMsgCollection, getMessageCollection } from './mongodb/collections';
import { registerStorageSettings } from './settings';
import { getLogLevel } from './utils/get_log_level';


const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN,
    logLevel: getLogLevel(process.env.LOG_LEVEL),
    socketMode: true,
    ignoreSelf: false,
    deferInitialization: true,
});

app.use(async ({ next }) => {
    await next!();
});

const fileSavePrefix = process.env.SLACK_FILE_SAVE_PREFIX;

(async () => {

    if (!process.env.DB_CONN_STRING) throw new Error('Env DB_CONN_STRING is required.');
    const client = new mongoDB.MongoClient(process.env.DB_CONN_STRING);
    await client.connect();

    const msgCollection = getMessageCollection(client.db());
    const changedMsgCollection = getChangedMsgCollection(client.db());
    const deletedMsgCollection = getDeletedMsgCollection(client.db());

    // // Start your app
    // await app.start();

    // // process self channel join and apply ignore self
    // app.use(async (args) => {

    //     if (args.payload.type === 'message') {
    //         const payload = args.payload as KnownEventFromType<'message'>

    //         // delete join message
    //         if (payload.subtype === 'channel_join' && payload.user === args.context.botUserId) {
    //             await args.client.chat.delete({
    //                 token: process.env.SLACK_USER_TOKEN,
    //                 channel: payload.channel,
    //                 ts: payload.ts,
    //             });
    //         }
    //     }

    //     await ignoreSelf()(args);
    // });

    // app.message('', async ({ message }) => {
    //     await msgCollection.insertOne(message);

    //     if (message.subtype === 'file_share' && message.files && fileSavePrefix) {
    //         await Promise.all(message.files.map(async (v) => {
    //             if (v.url_private_download) {
    //                 const dirPath = `${fileSavePrefix}/${message.user}/${v.id}`;
    //                 await mkdir(dirPath, { recursive: true });

    //                 const filePath = `${dirPath}/${v.name}`;
    //                 await downloadFileFromSlack(v.url_private_download, filePath);

    //                 console.log(`saving file ${v.permalink} to ${filePath}`);
    //             }
    //         }));
    //     }
    // });

    // app.message(subtype('message_changed'), async ({ event }) => {
    //     await changedMsgCollection.insertOne(event);
    // });

    // app.message(subtype('message_deleted'), async ({ event }) => {
    //     await deletedMsgCollection.insertOne(event);
    // });

    // app.message('hello', async ({ message, say }) => {
    //     if (message.channel_type === 'im' && isGenericMessageEvent(message)) {
    //         await say({
    //             blocks: [
    //                 {
    //                     type: "section",
    //                     text: {
    //                         type: "mrkdwn",
    //                         text: `早安 <@${message.user}>!`
    //                     },
    //                     accessory: {
    //                         type: "button",
    //                         text: {
    //                             type: "plain_text",
    //                             text: "趕快點我"
    //                         },
    //                         action_id: "button_click"
    //                     }
    //                 }
    //             ],
    //             text: `早安 <@${message.user}>!`,
    //         });
    //     }
    // });

    // app.action('button_click', async ({ body, ack, say }) => {
    //     // Acknowledge the action
    //     await ack();
    //     await say(`<@${body.user.id}> 點了按鈕`);
    // });

    // await fetchHistory(web, 'CC2LH7T1N', async (messages) => {
    //     const coll = getMessageCollection(client.db());
    //     await Promise.all(messages.map(async (v) => {
    //         const r = await coll.findOne({ channel: v.channel, ts: v.ts });
    //         if (!r) {
    //             console.log(`creating ${v.ts} @ ${v.channel}: ${(v as any).text ?? 'n/a'}`);
    //             await coll.insertOne(v);
    //         } else {
    //             await coll.updateOne({ _id: r._id }, {
    //                 $set: v,
    //             });
    //         }
    //     }));
    // });

    await registerStorageSettings(app);

    console.log('⚡️ Bolt app is running!');
})();