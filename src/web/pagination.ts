import { Collection, Document, ObjectId } from 'mongodb';

/** Cursors are the last `_id` of a page, base64url-encoded so clients treat them as opaque. */
export function encodeCursor(id: ObjectId): string {
    return Buffer.from(id.toHexString(), 'hex').toString('base64url');
}

export function decodeCursor(cursor: string): ObjectId | undefined {
    if (!/^[A-Za-z0-9_-]{16}$/.test(cursor)) return undefined;
    return new ObjectId(Buffer.from(cursor, 'base64url'));
}

/** One page of `col` newest first, starting after `after`. */
export async function findPage(
    col: Collection,
    filter: Record<string, unknown>,
    limit: number,
    after?: ObjectId,
): Promise<{ docs: Document[]; nextCursor: string | null }> {
    const query = after ? { ...filter, _id: { $lt: after } } : filter;
    // Fetch one extra doc to know whether another page exists.
    const docs = await col.find(query).sort({ _id: -1 }).limit(limit + 1).toArray();
    const hasMore = docs.length > limit;
    const pageDocs = docs.slice(0, limit);
    return {
        docs: pageDocs,
        nextCursor: hasMore ? encodeCursor(pageDocs[pageDocs.length - 1]._id as ObjectId) : null,
    };
}
