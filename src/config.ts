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
    /** The HTTP server shared by the REST API and the webhook relay (LISTEN_ADDR). */
    http: ListenAddr;
    /** Sent as X-App-Version / X-App-Commit; injected at image build time. */
    build: { version: string; commit: string };
    /** REST API under /api/v1; disabled unless API_KEY is set. */
    api:
        | { enabled: false }
        | { enabled: true; apiKey: string };
    webhookRelay:
        | { enabled: false }
        | { enabled: true; publicBaseUrl: string };
}

export type ListenAddr = { host?: string; port: number };

/** Parses `:8080`, `0.0.0.0:8080` or `[::]:8080`; an empty host means every interface. */
export function parseListenAddr(raw: string): ListenAddr {
    const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(raw);
    const port = m ? Number(m[3]) : NaN;
    if (!m || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Env LISTEN_ADDR must look like :8080 or host:8080 (got ${JSON.stringify(raw)}).`);
    }
    const host = m[1] ?? m[2];
    return host ? { host, port } : { port };
}

/** A `<purpose>_KEY` secret: base64 (or base64url) of at least 32 bytes. */
export function isValidKey(value: string): boolean {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length >= 32;
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

    // Replaced by the single LISTEN_ADDR; fail loudly instead of silently listening elsewhere.
    for (const old of ['WEBHOOK_PORT', 'API_PORT']) {
        if (optional(old)) throw new Error(`Env ${old} is no longer used; set LISTEN_ADDR (e.g. :8080) instead.`);
    }
    const http = parseListenAddr(optional('LISTEN_ADDR') ?? ':8080');

    const apiKey = optional('API_KEY');
    if (apiKey && !isValidKey(apiKey)) {
        throw new Error('Env API_KEY must be base64 of at least 32 bytes (e.g. `openssl rand -base64 32`).');
    }
    const api: Config['api'] = apiKey ? { enabled: true, apiKey } : { enabled: false };

    let webhookRelay: Config['webhookRelay'] = { enabled: false };
    if (process.env.USE_WEBHOOK_RELAY === 'true') {
        const publicBaseUrl = optional('WEBHOOK_PUBLIC_BASE_URL');
        if (!publicBaseUrl) throw new Error('Env WEBHOOK_PUBLIC_BASE_URL is required when USE_WEBHOOK_RELAY=true.');
        webhookRelay = { enabled: true, publicBaseUrl };
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
        http,
        build: {
            version: optional('APP_VERSION') ?? 'dev',
            commit: optional('APP_COMMIT') ?? 'unknown',
        },
        api,
        webhookRelay,
    };
}
