import fetch, { Headers } from 'node-fetch';
import { writeFile } from "fs/promises";
import { LogLevel } from '@slack/bolt';

export async function downloadFileFromSlack(url: string, savePath: string, slack_token?: string) {
    const x = await fetch(url, {
        headers: new Headers(slack_token ? { 'Authorization': `Bearer ${slack_token}` } : {}),
    });

    const x_1 = await x.arrayBuffer();

    return await writeFile(savePath, Buffer.from(x_1));
}

export function getBoltLogLevel(logLevel: string | undefined): LogLevel {
    if (logLevel === LogLevel.ERROR) return LogLevel.ERROR;
    if (logLevel === LogLevel.WARN) return LogLevel.WARN;
    if (logLevel === LogLevel.INFO) return LogLevel.INFO;
    if (logLevel === LogLevel.DEBUG) return LogLevel.DEBUG;

    return LogLevel.WARN;
}
