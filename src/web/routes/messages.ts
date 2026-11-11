import { Router, type Request, type Response } from 'express';
import { ObjectId } from 'mongodb';
import type { DbCollections } from '../../db';
import { paginate } from '../pagination';

const VALID_COLLECTIONS = ['messages', 'changedMessages', 'deletedMessages'] as const;
type MessageCollection = typeof VALID_COLLECTIONS[number];

function resolveCollection(req: Request, res: Response): MessageCollection | undefined {
    const name = req.query.collection ?? 'messages';
    if (!VALID_COLLECTIONS.includes(name as MessageCollection)) {
        res.status(400).json({ error: `collection must be one of: ${VALID_COLLECTIONS.join(', ')}` });
        return undefined;
    }
    return name as MessageCollection;
}

export function createMessagesRouter(collections: DbCollections): Router {
    const router = Router();

    router.get('/', async (req, res) => {
        const name = resolveCollection(req, res);
        if (!name) return;
        const page = await paginate(req, res, collections[name], {});
        if (page) res.json(page);
    });

    router.get('/:id', async (req, res) => {
        const name = resolveCollection(req, res);
        if (!name) return;
        if (!ObjectId.isValid(req.params.id)) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }

        const doc = await collections[name].findOne({ _id: new ObjectId(req.params.id) });
        if (!doc) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json(doc);
    });

    return router;
}
