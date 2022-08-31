import { config } from 'dotenv';
config();

import { WebClient } from '@slack/web-api';
import Table from 'tty-table';
import { getLogLevel } from './utils/get_log_level';

(async () => {
    const web = new WebClient(process.env.SLACK_BOT_TOKEN, {
        logLevel: getLogLevel(process.env.LOG_LEVEL),
    });

    const r = await web.conversations.list();

    if (r.ok) {
        const rows: [string, string, string][] = r.channels?.map((v) => {
            const type = v.is_channel ?
                (v.is_private ? 'private' : 'channel') :
                (v.is_group ?
                    'group' :
                    v.is_im ? 'im' : 'unknown'
                );

            const archived = v.is_archived ? ' (archived)' : '';
            const member = v.is_member ? ' (member)' : ''

            return [v.id ?? '', v.name ?? '', (type + archived + member)];
        }) ?? [];

        const out = Table(
            [{ value: 'ID', width: 15 }, { value: 'Name', width: 50 }, { value: 'Type', width: 30 }],
            rows, {
            }
        ).render();

        console.log(out);
    } else {
        console.error(r.error);
    }
})();
