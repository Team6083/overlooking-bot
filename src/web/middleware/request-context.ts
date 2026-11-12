import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import type { RequestHandler } from 'express';

export type BuildInfo = { version: string; commit: string };

export type AccessLogEntry = {
    msg: 'http_request';
    method: string;
    route: string;
    status: number;
    duration_ms: number;
    request_id: string;
};

/** One JSON line on stdout. The route is a template, so secrets in paths and query strings never reach the log. */
export function writeAccessLog(entry: AccessLogEntry): void {
    process.stdout.write(JSON.stringify({ level: 'info', time: new Date().toISOString(), ...entry }) + '\n');
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Applies to every response of the shared server: request id (X-Request-ID, taken from the
 * caller when well-formed), X-App-Version / X-App-Commit, nosniff, and one access log line.
 */
export function requestContext(build: BuildInfo, log: (e: AccessLogEntry) => void = writeAccessLog): RequestHandler {
    return (req, res, next) => {
        const started = performance.now();
        const incoming = req.get('x-request-id');
        const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.locals.requestId = requestId;
        res.set({
            'X-Request-ID': requestId,
            'X-App-Version': build.version,
            'X-App-Commit': build.commit,
            'X-Content-Type-Options': 'nosniff',
        });
        res.on('finish', () => {
            log({
                msg: 'http_request',
                method: req.method,
                route: typeof res.locals.route === 'string' ? res.locals.route : 'unmatched',
                status: res.statusCode,
                duration_ms: Math.round(performance.now() - started),
                request_id: requestId,
            });
        });
        next();
    };
}

/** Names the matched route for the access log. */
export function routeName(route: string): RequestHandler {
    return (_req, res, next) => {
        res.locals.route = route;
        next();
    };
}
