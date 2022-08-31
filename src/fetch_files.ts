import { config } from 'dotenv';
config();
import * as mongoDB from 'mongodb';
import args from 'args';

import { getMessageCollection } from './mongodb/collections';
import { exit } from 'process';
import { mkdir } from 'fs/promises';
import { downloadFileFromSlack } from './slack/file';
import { existsSync } from 'fs';
import { eachLimitWithRate } from './utils/async_rate_limit';
import cliProgress from 'cli-progress';

const fileSavePrefix = process.env.SLACK_FILE_SAVE_PREFIX;

(async () => {
    args
        .option('channel', 'ID of the channel to fetch');

    const { channel } = args.parse(process.argv);
    if (typeof channel !== 'string' || channel.length === 0) {
        throw new Error('channel is required');
    }

    if (!process.env.DB_CONN_STRING) throw new Error('Env DB_CONN_STRING is required.');
    const client = new mongoDB.MongoClient(process.env.DB_CONN_STRING);
    await client.connect();

    const msgCollection = getMessageCollection(client.db());

    const msgsWithFiles = await msgCollection.find({
        channel,
        files: { $exists: true },
    }).toArray();

    type DownloadTarget = {
        url: string,
        filePath: string,
        dirPath: string,
        permalink: string
    }
    const files: DownloadTarget[] = msgsWithFiles.map((msg) => {
        if (Array.isArray(msg.files)) {
            return msg.files.map((v) => {
                if (v.url_private_download) {
                    const dirPath = `${fileSavePrefix}/${msg.user}/${v.id}`;
                    const filePath = `${dirPath}/${v.name}`;

                    return {
                        dirPath,
                        filePath,
                        url: v.url_private_download,
                        permalink: v.permalink,
                    };
                }
                return undefined;
            }).filter((v): v is DownloadTarget => v ? !existsSync(v?.filePath) : false);
        }
        return [];
    }).flat();

    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(files.length, 0);

    await eachLimitWithRate(
        files.map((v, i) => ({ i, v })), 1,
        ({ v: { dirPath, filePath, url, permalink }, i }, cb) => {
            (async () => {
                if (!existsSync(dirPath)) {
                    await mkdir(dirPath, { recursive: true });
                }

                await downloadFileFromSlack(url, filePath);

                bar.update(i + 1);
            })().then(() => cb());
        },
        2000
    )
    
    console.log();
    console.log('Done.');
    exit(0);
})();
