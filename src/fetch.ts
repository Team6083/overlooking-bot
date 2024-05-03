import { WebClient } from "@slack/web-api";
import * as MongoDB from 'mongodb';

import 'dotenv/config'
import async from 'async';
import { exit } from "process";
import inquirer from 'inquirer';
import blessed from 'blessed';
import blessedContrib from 'blessed-contrib';
import { MongoDBSlackStorageRepository } from "./message-repository/mongo-repo";
import { ConversationFetchService } from "./conversation-fetch";
import { readFileSync, readdirSync, writeFileSync } from "fs";

(async function () {
    if (!process.env.DB_CONN_STRING) throw new Error('Env DB_CONN_STRING is required.');
    const mongoClient = new MongoDB.MongoClient(process.env.DB_CONN_STRING);
    await mongoClient.connect();

    const msgCollection = mongoClient.db().collection('messages');
    const changedMsgCollection = mongoClient.db().collection('changedMessages');
    const deletedMsgCollection = mongoClient.db().collection('deletedMessages');
    const fileMetadataCollection = mongoClient.db().collection('file_metadata');

    const fileSavePrefix = process.env.SLACK_FILE_SAVE_PREFIX;
    if (!fileSavePrefix) throw new Error('Env SLACK_FILE_SAVE_PREFIX is required.');

    const repo = new MongoDBSlackStorageRepository(msgCollection, changedMsgCollection, deletedMsgCollection, fileMetadataCollection, fileSavePrefix);
    // const slackAPIClient = new WebClient(process.env.SLACK_BOT_TOKEN);
    const slackAPIClient = new WebClient(process.env.SLACK_USER_TOKEN);

    // const screen = blessed.screen({
    //     smartCSR: true
    // });

    // const mainBoxHeight = 70;
    // const mainBox = blessed.box({
    //     top: '0',
    //     left: 'center',
    //     width: '100%',
    //     height: (mainBoxHeight + 2).toString() + '%',
    //     scrollable: true,
    //     tags: true,
    //     scrollbar: {
    //         ch: ' '
    //     },
    //     style: {
    //         scrollbar: {
    //             bg: 'blue'
    //         },
    //     }
    // });

    // const logFunc = (...args: any[]) => {
    //     mainBox.pushLine(args.join(' '));
    // }

    const jsonFiles = readdirSync('./job_updates').filter((f) => f.endsWith('.json'));

    const jobUpdates = jsonFiles
        .map((f) => {
            const channelId = f.split('_')[0];

            const data = JSON.parse(readFileSync(`./job_updates/${f}`, 'utf-8'));
            if (data['remaining'].length === 0) {
                return { id: channelId, finished: true };
            }

            return { id: channelId, finished: false };
        });


    const fetchService = new ConversationFetchService(slackAPIClient, repo);//, logFunc, logFunc, logFunc);

    const chansResp = await slackAPIClient.conversations.list({ types: 'public_channel,private_channel,mpim,im', limit: 999 });
    if (!chansResp.ok || !chansResp.channels) throw new Error('Failed to fetch channels');

    writeFileSync('./channels.json', JSON.stringify(chansResp, null, 2));

    const channels = chansResp.channels.map((v) => {
        const juIdx = jobUpdates.findIndex((j) => j.id === v.id);
        if (juIdx !== -1) {
            if (jobUpdates[juIdx].finished) {
                return { id: v.id, name: v.name, state: 'finished' };
            } else {
                return { id: v.id, name: v.name, state: 'not_finished' };
            }
        }

        return { id: v.id, name: v.name, state: 'not_started' };
    });

    channels.sort((a, b) => {
        if (a.state === 'not_started' && b.state !== 'not_started') {
            return -1;
        } else if (a.state !== 'not_started' && b.state === 'not_started') {
            return 1;
        }

        return 0;
    });

    const answers = await inquirer.prompt([{
        type: 'checkbox',
        name: 'channels',
        message: 'Select channels to fetch',
        choices: channels
            .map((chan) => {
                let str = chan.name ?? chan.id;

                if (chan.state !== 'not_started') {
                    if (chan.state === 'finished') {
                        str += ' (Finished)';
                    } else {
                        str += ' (Not Finished)';
                    }
                }

                return {
                    name: str,
                    value: chan.id
                };
            })
    }]);

    // screen.append(mainBox);

    // screen.key(['escape', 'q', 'C-c'], function (ch, key) {
    //     return process.exit(0);
    // });

    // const jobsTable = blessedContrib.table({
    //     top: (mainBoxHeight).toString() + '%',
    //     left: 0,
    //     width: '35%',
    //     height: (100 - mainBoxHeight + 1).toString() + '%',
    //     fg: 'white',
    //     label: 'Jobs',
    //     border: {
    //         type: 'line',
    //         fg: 'white'
    //     },
    //     columnSpacing: 1,
    //     columnWidth: [40, 5, 5, 5]
    // });

    // screen.append(jobsTable);

    // const queueSparkline = blessedContrib.sparkline({
    //     top: (mainBoxHeight).toString() + '%',
    //     left: '35%',
    //     width: '65%',
    //     height: (100 - mainBoxHeight + 1).toString() + '%',
    //     label: 'Queue Stats',
    //     tags: true,
    //     border: {
    //         type: 'line',
    //     },
    //     style: {
    //         fg: 'blue',
    //         titleFg: 'white'
    //     }
    // });

    // screen.append(queueSparkline);

    // setInterval(() => {
    //     jobsTable.setData({
    //         headers: ['Channel', 'Hist', 'Repl', 'File'],
    //         data: [
    //             ['channel1', '2', '3', '4'],
    //             ['channel2', '2', '3', '4'],
    //         ]
    //     });

    //     queueSparkline.setData(['History', 'Response', 'File'], [
    //         [1, 2, 3, 4, 5],
    //         [5, 4, 3, 2, 1],
    //         [1, 2, 3, 4, 5]
    //     ]);

    //     mainBox.pushLine('test');

    //     screen.render();
    // }, 100);

    const queue = async.queue(async (channelId: string, cb) => {
        try {
            const chan = chansResp.channels!.find((c) => c.id === channelId);

            console.log(`Fetching channel ${chan?.name ?? 'n/a'} (${channelId})`);
            await fetchService.fetchChannel(channelId, {
                downloadFiles: true,
            });
            cb(null);
        } catch (error: any) {
            cb(error);
        }
    }, 3);

    for (const channelId of answers.channels) {
        queue.push(channelId, (error) => {
            if (error) {
                console.error(`Error on channel ${channelId}: ${error}`);
            }
        });
    }

    queue.drain(() => {
        console.log('All channels fetched');
        exit(0);
    });

})();
