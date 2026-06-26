import type { BotSettings, PatchSettingsBody } from '../modules/settings/store';
import type { ComplianceResult } from '../modules/google-drive/types';

export type { BotSettings, PatchSettingsBody };

export interface PaginationQuery {
    limit?: number;
    before?: string;
}

export interface ListResponse<T> {
    data: T[];
    total: number;
    hasMore: boolean;
}

export interface DriveJobResponse {
    _id: string;
    fileId: string;
    url: string;
    channel: string;
    thread_ts: string;
    requestedAt: string;
    status: 'pending' | 'completed' | 'error';
    result?: ComplianceResult;
    completedAt?: string;
}
