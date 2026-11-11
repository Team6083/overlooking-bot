import { Router } from 'express';
import { ObjectId } from 'mongodb';
import type { DbCollections } from '../../db';
import { paginate } from '../pagination';

const VALID_STATUSES = ['pending', 'completed', 'error'] as const;

export function createDriveRouter(collections: DbCollections): Router {
    const router = Router();

    router.get('/jobs', async (req, res) => {
        const { status } = req.query;
        const filter: Record<string, unknown> = {};
        if (status !== undefined) {
            if (!VALID_STATUSES.includes(status as any)) {
                res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
                return;
            }
            filter.status = status;
        }

        const page = await paginate(req, res, collections.driveComplianceJobs, filter);
        if (page) res.json(page);
    });

    router.get('/jobs/:id', async (req, res) => {
        if (!ObjectId.isValid(req.params.id)) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }

        const doc = await collections.driveComplianceJobs.findOne({ _id: new ObjectId(req.params.id) });
        if (!doc) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json(doc);
    });

    return router;
}
