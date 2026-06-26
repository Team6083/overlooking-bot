import { Router } from 'express';
import { ObjectId } from 'mongodb';
import type { DbCollections } from '../../db';
import type { DriveJobResponse, ListResponse, PaginationQuery } from '../types';

const VALID_STATUSES = ['pending', 'completed', 'error'] as const;

export function createDriveRouter(collections: DbCollections): Router {
    const router = Router();

    router.get('/jobs', async (req, res) => {
        const { limit: limitStr, before, status } = req.query as PaginationQuery & { status?: string };
        const limit = Math.min(parseInt(String(limitStr || '50'), 10) || 50, 200);

        const filter: Record<string, any> = {};

        if (status) {
            if (!VALID_STATUSES.includes(status as any)) {
                res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
                return;
            }
            filter.status = status;
        }

        if (before) {
            try {
                filter._id = { $lt: new ObjectId(before) };
            } catch {
                res.status(400).json({ error: 'invalid before cursor' });
                return;
            }
        }

        const [data, total] = await Promise.all([
            collections.driveComplianceJobs.find(filter).sort({ _id: -1 }).limit(limit).toArray(),
            collections.driveComplianceJobs.countDocuments(filter),
        ]);

        const response: ListResponse<DriveJobResponse> = {
            data: data as unknown as DriveJobResponse[],
            total,
            hasMore: data.length === limit,
        };
        res.json(response);
    });

    router.get('/jobs/:id', async (req, res) => {
        let oid: ObjectId;
        try {
            oid = new ObjectId(req.params.id);
        } catch {
            res.status(400).json({ error: 'invalid id' });
            return;
        }

        const doc = await collections.driveComplianceJobs.findOne({ _id: oid });
        if (!doc) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json(doc);
    });

    return router;
}
