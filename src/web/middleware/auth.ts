import { timingSafeEqual } from 'crypto';
import { RequestHandler } from 'express';
import { sendError } from '../errors';

/** Requires `Authorization: Bearer <API_KEY>`, compared in constant time. */
export function requireApiKey(apiKey: string): RequestHandler {
    const keyBuf = Buffer.from(apiKey);
    return (req, res, next) => {
        const header = req.headers['authorization'] ?? '';
        const tokenBuf = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
        if (tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
            res.set('WWW-Authenticate', 'Bearer');
            return sendError(res, 401, 'unauthenticated', 'Missing or invalid API key');
        }
        next();
    };
}
