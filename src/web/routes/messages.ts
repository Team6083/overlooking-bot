import { Router } from 'express';
import { ObjectId } from 'mongodb';
import type { DbCollections } from '../../db';
import { toMessageRecord } from '../dto';
import { sendError, sendValidationError } from '../errors';
import { routeName } from '../middleware/request-context';
import { decodeCursor, findPage } from '../pagination';
import { GetMessageQuery, ListMessagesQuery, MessageCollectionName, ObjectIdParam } from '../schemas';

function collectionFor(collections: DbCollections, name: MessageCollectionName) {
    switch (name) {
        case 'messages': return collections.messages;
        case 'changed_messages': return collections.changedMessages;
        case 'deleted_messages': return collections.deletedMessages;
    }
}

export function createMessagesRouter(collections: DbCollections): Router {
    const router = Router();

    router.get('/', routeName('/api/v1/messages'), async (req, res) => {
        const query = ListMessagesQuery.safeParse(req.query);
        if (!query.success) return sendValidationError(res, query.error);

        const after = query.data.cursor !== undefined ? decodeCursor(query.data.cursor) : undefined;
        if (query.data.cursor !== undefined && !after) {
            return sendError(res, 400, 'invalid_request', 'Invalid request parameters', { fields: { cursor: 'invalid cursor' } });
        }

        const { collection, limit } = query.data;
        const { docs, nextCursor } = await findPage(collectionFor(collections, collection), {}, limit, after);
        res.json({ items: docs.map((d) => toMessageRecord(d, collection)), nextCursor });
    });

    router.get('/:id', routeName('/api/v1/messages/:id'), async (req, res) => {
        const params = ObjectIdParam.safeParse(req.params);
        if (!params.success) return sendValidationError(res, params.error);
        const query = GetMessageQuery.safeParse(req.query);
        if (!query.success) return sendValidationError(res, query.error);

        const { collection } = query.data;
        const doc = await collectionFor(collections, collection).findOne({ _id: new ObjectId(params.data.id) });
        if (!doc) return sendError(res, 404, 'not_found', 'Message not found');
        res.json(toMessageRecord(doc, collection));
    });

    return router;
}
