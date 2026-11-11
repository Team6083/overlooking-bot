import type { Request, Response } from 'express';
import { Collection, ObjectId } from 'mongodb';
import type { ListResponse } from './types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Lists `col` newest first with an `_id` cursor (`?limit=&before=`). `total` counts every doc
 * matching `filter`, independent of the cursor. Sends a 400 and returns undefined on bad input.
 */
export async function paginate(
    req: Request,
    res: Response,
    col: Collection,
    filter: Record<string, unknown>,
): Promise<ListResponse<any> | undefined> {
    const { limit: limitStr, before } = req.query;
    let limit = DEFAULT_LIMIT;
    if (limitStr !== undefined) {
        limit = Number(limitStr);
        if (!Number.isInteger(limit) || limit < 1) {
            res.status(400).json({ error: 'limit must be a positive integer' });
            return undefined;
        }
        limit = Math.min(limit, MAX_LIMIT);
    }

    const pageFilter: Record<string, unknown> = { ...filter };
    if (before !== undefined) {
        if (typeof before !== 'string' || !ObjectId.isValid(before)) {
            res.status(400).json({ error: 'invalid before cursor' });
            return undefined;
        }
        pageFilter._id = { $lt: new ObjectId(before) };
    }

    // Fetch one extra doc to know whether another page exists.
    const [docs, total] = await Promise.all([
        col.find(pageFilter).sort({ _id: -1 }).limit(limit + 1).toArray(),
        col.countDocuments(filter),
    ]);
    return { data: docs.slice(0, limit), total, hasMore: docs.length > limit };
}
