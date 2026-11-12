import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
    DriveJob,
    DriveJobPage,
    ErrorResponse,
    GetMessageQuery,
    ListDriveJobsQuery,
    ListMessagesQuery,
    MessagePage,
    MessageRecord,
    ObjectIdParam,
} from './schemas';

const json = (schema: z.ZodType, description: string) => ({ description, content: { 'application/json': { schema } } });

const errors = {
    400: json(ErrorResponse, 'Invalid parameters (`invalid_request`, field errors in `details.fields`)'),
    401: json(ErrorResponse, 'Missing or invalid API key (`unauthenticated`)'),
    500: json(ErrorResponse, 'Unexpected failure (`internal_error`)'),
};
const notFound = { 404: json(ErrorResponse, 'No such record (`not_found`)') };

/** Builds the OpenAPI 3.1 document from the request/response schemas. */
export function buildOpenApiDocument() {
    const registry = new OpenAPIRegistry();
    const bearer = registry.registerComponent('securitySchemes', 'apiKey', {
        type: 'http',
        scheme: 'bearer',
        description: 'The value of API_KEY.',
    });
    const security = [{ [bearer.name]: [] }];

    registry.registerPath({
        method: 'get', path: '/api/v1/messages', summary: 'List archived messages, newest first', security,
        request: { query: ListMessagesQuery },
        responses: { 200: json(MessagePage, 'One page of messages'), ...errors },
    });
    registry.registerPath({
        method: 'get', path: '/api/v1/messages/{id}', summary: 'Get one archived message', security,
        request: { params: ObjectIdParam, query: GetMessageQuery },
        responses: { 200: json(MessageRecord, 'The message'), ...errors, ...notFound },
    });
    registry.registerPath({
        method: 'get', path: '/api/v1/drive/jobs', summary: 'List Google Drive compliance checks, newest first', security,
        request: { query: ListDriveJobsQuery },
        responses: { 200: json(DriveJobPage, 'One page of checks'), ...errors },
    });
    registry.registerPath({
        method: 'get', path: '/api/v1/drive/jobs/{id}', summary: 'Get one Google Drive compliance check', security,
        request: { params: ObjectIdParam },
        responses: { 200: json(DriveJob, 'The check'), ...errors, ...notFound },
    });

    return new OpenApiGeneratorV31(registry.definitions).generateDocument({
        openapi: '3.1.0',
        info: {
            title: 'overlooking-bot API',
            version: '1.0.0',
            description: 'Read-only access to archived Slack messages and Google Drive compliance checks. Every response carries X-App-Version, X-App-Commit and X-Request-ID.',
        },
    });
}
