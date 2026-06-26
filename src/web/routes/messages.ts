import { Router } from 'express';
import { ObjectId } from 'mongodb';
import type { DbCollections } from '../../db';
import type { ListResponse, PaginationQuery } from '../types';

const VALID_COLLECTIONS = ['messages', 'changedMessages', 'deletedMessages'] as const;
type MessageCollection = typeof VALID_COLLECTIONS[number];

export function createMessagesRouter(collections: DbCollections): Router {
    const router = Router();

    router.get('/', async (req, res) => {
        const collectionName = (req.query.collection as string) || 'messages';
        if (!VALID_COLLECTIONS.includes(collectionName as MessageCollection)) {
            res.status(400).json({ error: `collection must be one of: ${VALID_COLLECTIONS.join(', ')}` });
            return;
        }

        const { limit: limitStr, before } = req.query as PaginationQuery;
        const limit = Math.min(parseInt(String(limitStr || '50'), 10) || 50, 200);

        const col = collections[collectionName as MessageCollection];
        const filter: Record<string, any> = {};
        if (before) {
            try {
                filter._id = { $lt: new ObjectId(before) };
            } catch {
                res.status(400).json({ error: 'invalid before cursor' });
                return;
            }
        }

        const [data, total] = await Promise.all([
            col.find(filter).sort({ _id: -1 }).limit(limit).toArray(),
            col.countDocuments(filter),
        ]);

        const response: ListResponse<any> = {
            data,
            total,
            hasMore: data.length === limit,
        };
        res.json(response);
    });

    router.get('/:id', async (req, res) => {
        let oid: ObjectId;
        try {
            oid = new ObjectId(req.params.id);
        } catch {
            res.status(400).json({ error: 'invalid id' });
            return;
        }

        const doc = await collections.messages.findOne({ _id: oid });
        if (!doc) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json(doc);
    });

    return router;
}
