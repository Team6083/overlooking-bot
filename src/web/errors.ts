import type { Response } from 'express';
import type { ZodError } from 'zod';

export type ErrorCode = 'invalid_request' | 'unauthenticated' | 'not_found' | 'internal_error';

/** Sends the standard error body: `{ error: { code, message, details? } }`. */
export function sendError(
    res: Response,
    status: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
): void {
    res.status(status).json({ error: details ? { code, message, details } : { code, message } });
}

/** 400 invalid_request with one message per offending field in `details.fields`. */
export function sendValidationError(res: Response, err: ZodError): void {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
        const key = issue.path.join('.') || '_';
        fields[key] ??= issue.message;
    }
    sendError(res, 400, 'invalid_request', 'Invalid request parameters', { fields });
}
