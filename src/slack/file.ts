import fetch, { Headers } from 'node-fetch'
import { writeFile, mkdir } from 'fs/promises';

export async function downloadFileFromSlack(url: string, filename: string) {
    const x = await fetch(url, {
        headers: new Headers({
            'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
        }),
    });

    const x_1 = await x.arrayBuffer();

    return await writeFile(filename, Buffer.from(x_1));
}
