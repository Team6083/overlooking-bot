import { config } from 'dotenv';
config();

import { getBoltLogLevel } from './utils/slack';

export interface Config {
    slack: {
        botToken: string;
        signingSecret: string;
        appToken: string;
        userToken: string;
        logLevel: ReturnType<typeof getBoltLogLevel>;
    };
    db: {
        connString: string;
    };
    app: {
        fileSavePrefix: string;
        autoJoinChannels: boolean;
    };
    features: {
        useReactionCheck: boolean;
        reactionUserIgnoreList: string[];
        useGoogleDriveCheck: boolean;
        googleDriveAllowedSharedDriveIds: string[];
        googleDriveAllowedFolderIds: string[];
        googleDriveAllowDomainSharing: boolean;
        googleDriveMaxParentTraversalDepth: number;
        googleDriveReportOnlyViolations: boolean;
        googleDriveAuditChannel?: string;
        googleServiceAccountKeyFile?: string;
        googleServiceAccountKeyJson?: string;
    };
    /** REST API under /api; disabled unless API_KEY is set. */
    api:
        | { enabled: false }
        | { enabled: true; port: number; apiKey: string };
    webhookRelay:
        | { enabled: false }
        | { enabled: true; port: number; publicBaseUrl: string };
}

function required(name: string): string {
    const val = process.env[name];
    if (!val) throw new Error(`Env ${name} is required.`);
    return val;
}

function optional(name: string): string | undefined {
    return process.env[name] || undefined;
}

function port(name: string, fallback: number): number {
    const raw = process.env[name];
    const val = raw ? Number(raw) : fallback;
    if (!Number.isInteger(val) || val <= 0 || val > 65535) throw new Error(`Env ${name} must be a port number.`);
    return val;
}

export function loadConfig(): Config {
    const useGoogleDriveCheck = process.env.USE_GOOGLE_DRIVE_CHECK === 'true';

    if (useGoogleDriveCheck && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_KEY_JSON is required when USE_GOOGLE_DRIVE_CHECK=true.');
    }

    const apiKey = optional('API_KEY');
    const api: Config['api'] = apiKey
        ? { enabled: true, port: port('API_PORT', 3001), apiKey }
        : { enabled: false };

    let webhookRelay: Config['webhookRelay'] = { enabled: false };
    if (process.env.USE_WEBHOOK_RELAY === 'true') {
        const publicBaseUrl = optional('WEBHOOK_PUBLIC_BASE_URL');
        if (!publicBaseUrl) throw new Error('Env WEBHOOK_PUBLIC_BASE_URL is required when USE_WEBHOOK_RELAY=true.');
        const webhookPort = port('WEBHOOK_PORT', 3000);
        if (api.enabled && webhookPort === api.port) {
            throw new Error(`WEBHOOK_PORT and API_PORT must differ (both are ${webhookPort}).`);
        }
        webhookRelay = { enabled: true, port: webhookPort, publicBaseUrl };
    }

    return {
        slack: {
            botToken: required('SLACK_BOT_TOKEN'),
            signingSecret: required('SLACK_SIGNING_SECRET'),
            appToken: required('SLACK_APP_TOKEN'),
            userToken: required('SLACK_USER_TOKEN'),
            logLevel: getBoltLogLevel(process.env.LOG_LEVEL),
        },
        db: {
            connString: required('DB_CONN_STRING'),
        },
        app: {
            fileSavePrefix: required('SLACK_FILE_SAVE_PREFIX'),
            autoJoinChannels: process.env.AUTO_JOIN_CHANNELS === 'true',
        },
        features: {
            useReactionCheck: process.env.USE_REACTION_CHECK === 'true',
            reactionUserIgnoreList: process.env.REACTION_USER_IGN_LIST
                ? process.env.REACTION_USER_IGN_LIST.split(',')
                : [],
            useGoogleDriveCheck,
            googleDriveAllowedSharedDriveIds: (process.env.GOOGLE_DRIVE_ALLOWED_SHARED_DRIVE_IDS || '').split(',').filter(Boolean),
            googleDriveAllowedFolderIds: (process.env.GOOGLE_DRIVE_ALLOWED_FOLDER_IDS || '').split(',').filter(Boolean),
            googleDriveAllowDomainSharing: process.env.GOOGLE_DRIVE_ALLOW_DOMAIN_SHARING === 'true',
            googleDriveMaxParentTraversalDepth: 10,
            googleDriveReportOnlyViolations: process.env.GOOGLE_DRIVE_REPORT_ONLY_VIOLATIONS !== 'false',
            googleDriveAuditChannel: optional('GOOGLE_DRIVE_AUDIT_CHANNEL'),
            googleServiceAccountKeyFile: optional('GOOGLE_SERVICE_ACCOUNT_KEY_FILE'),
            googleServiceAccountKeyJson: optional('GOOGLE_SERVICE_ACCOUNT_KEY_JSON'),
        },
        api,
        webhookRelay,
    };
}
