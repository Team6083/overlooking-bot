import { timingSafeEqual } from 'crypto';
import { RequestHandler } from 'express';

export function requireApiKey(apiKey: string): RequestHandler {
    const keyBuf = Buffer.from(apiKey);
    return (req, res, next) => {
        const header = req.headers['authorization'] ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        let valid = false;
        try {
            const tokenBuf = Buffer.from(token);
            valid = tokenBuf.length === keyBuf.length && timingSafeEqual(tokenBuf, keyBuf);
        } catch {
            valid = false;
        }
        if (!valid) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }
        next();
    };
}
