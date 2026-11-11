import type { ComplianceResult } from '../modules/google-drive/types';

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
