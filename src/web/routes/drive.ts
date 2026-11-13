import { Router } from 'express';
import { ObjectId } from 'mongodb';
import type { DbCollections } from '../../db';
import { toDriveJob } from '../dto';
import { sendError, sendValidationError } from '../errors';
import { routeName } from '../middleware/request-context';
import { decodeCursor, findPage } from '../pagination';
import { ListDriveJobsQuery, ObjectIdParam } from '../schemas';

export function createDriveRouter(collections: DbCollections): Router {
    const router = Router();

    router.get('/jobs', routeName('/api/v1/drive/jobs'), async (req, res) => {
        const query = ListDriveJobsQuery.safeParse(req.query);
        if (!query.success) return sendValidationError(res, query.error);

        const after = query.data.cursor !== undefined ? decodeCursor(query.data.cursor) : undefined;
        if (query.data.cursor !== undefined && !after) {
            return sendError(res, 400, 'invalid_request', 'Invalid request parameters', { fields: { cursor: 'invalid cursor' } });
        }

        const conditions: Record<string, unknown>[] = [];
        if (query.data.status) conditions.push({ status: query.data.status });
        if (query.data.complianceStatus) conditions.push({ 'result.status': query.data.complianceStatus });
        if (query.data.open === 'true') {
            conditions.push({ 'result.status': { $ne: 'compliant' } }, { manualResolution: { $exists: false } });
        } else if (query.data.open === 'false') {
            conditions.push({ $or: [{ 'result.status': 'compliant' }, { manualResolution: { $exists: true } }] });
        }
        const filter = conditions.length > 0 ? { $and: conditions } : {};
        const { docs, nextCursor } = await findPage(collections.driveComplianceJobs, filter, query.data.limit, after);
        res.json({ items: docs.map(toDriveJob), nextCursor });
    });

    router.get('/jobs/:id', routeName('/api/v1/drive/jobs/:id'), async (req, res) => {
        const params = ObjectIdParam.safeParse(req.params);
        if (!params.success) return sendValidationError(res, params.error);

        const doc = await collections.driveComplianceJobs.findOne({ _id: new ObjectId(params.data.id) });
        if (!doc) return sendError(res, 404, 'not_found', 'Drive job not found');
        res.json(toDriveJob(doc));
    });

    return router;
}
