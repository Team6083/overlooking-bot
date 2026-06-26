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
    api: {
        port: number;
        apiKey: string;
    };
}

function required(name: string): string {
    const val = process.env[name];
    if (!val) throw new Error(`Env ${name} is required.`);
    return val;
}

function optional(name: string): string | undefined {
    return process.env[name] || undefined;
}

export function loadConfig(): Config {
    const useGoogleDriveCheck = process.env.USE_GOOGLE_DRIVE_CHECK === 'true';

    if (useGoogleDriveCheck && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_KEY_JSON is required when USE_GOOGLE_DRIVE_CHECK=true.');
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
            autoJoinChannels: process.env.AUTO_JOIN_CHANNELS !== 'false',
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
        api: {
            port: parseInt(process.env.API_PORT || '3000', 10),
            apiKey: required('API_KEY'),
        },
    };
}
