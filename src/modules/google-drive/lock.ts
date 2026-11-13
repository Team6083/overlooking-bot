import type { Collection, Document } from 'mongodb';

export const LOCK_TTL_MS = 2 * 60 * 1000;

export type LockResult = 'acquired' | 'busy' | 'missing';

type LockCollection = Pick<Collection<Document>, 'countDocuments' | 'updateMany'>;

/**
 * All-or-nothing lock on every job doc of a report. Each doc is locked atomically, so two
 * concurrent callers may each win part of a multi-file report; whoever did not get every doc
 * releases the ones carrying its own token and reports `busy`.
 */
export async function acquireReportLock(
    col: LockCollection,
    reportFilter: Document,
    token: string,
    now: Date = new Date(),
): Promise<LockResult> {
    const total = await col.countDocuments(reportFilter);
    if (total === 0) return 'missing';
    let locked;
    try {
        locked = await col.updateMany(
            {
                ...reportFilter,
                $or: [
                    { recheckingAt: { $exists: false } },
                    { recheckingAt: null },
                    { recheckingAt: { $lt: new Date(now.getTime() - LOCK_TTL_MS) } },
                ],
            },
            { $set: { recheckingAt: now, recheckingToken: token } },
        );
    } catch (err) {
        // The update may have locked some docs before failing; free the ones that are ours.
        await releaseReportLock(col, reportFilter, token).catch(() => undefined);
        throw err;
    }
    if (locked.modifiedCount === total) return 'acquired';
    await releaseReportLock(col, reportFilter, token);
    return 'busy';
}

export async function releaseReportLock(col: LockCollection, reportFilter: Document, token: string) {
    await col.updateMany(
        { ...reportFilter, recheckingToken: token },
        { $unset: { recheckingAt: '', recheckingToken: '' } },
    );
}
