import { drive_v3 } from 'googleapis';
import { ComplianceCheckerOptions, ComplianceResult, ComplianceViolation } from './types';

export * from './types';

export async function checkDriveCompliance(
    fileId: string,
    url: string,
    driveClient: drive_v3.Drive,
    options: ComplianceCheckerOptions,
    logger?: { error: (msg: string, ...args: any[]) => void },
): Promise<ComplianceResult> {
    let fileName: string | undefined;
    try {
        // Separate calls: files.get for metadata, permissions.list for sharing settings
        const [fileRes, permissions] = await Promise.all([
            driveClient.files.get({
                fileId,
                fields: 'id,name,parents,driveId',
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            } as drive_v3.Params$Resource$Files$Get),
            listAllPermissions(fileId, driveClient),
        ]);

        const file = fileRes.data;
        fileName = file.name ?? undefined;

        if (permissions === null) {
            logger?.error(`[drive-checker] permissions.list failed for ${fileId}`);
            return { fileId, url, status: 'cannot_check', fileName, violations: [], errorMessage: 'permissions.list failed' };
        }

        const violations: ComplianceViolation[] = [];

        // Permission check
        for (const perm of permissions) {
            if (perm.type === 'anyone') {
                violations.push({
                    kind: 'public_access',
                    allowFileDiscovery: perm.allowFileDiscovery === true,
                });
            } else if (perm.type === 'domain' && !options.allowDomainSharing) {
                violations.push({ kind: 'domain_sharing' });
            }
        }

        // Location check (only when at least one allowed location is configured)
        const hasLocationRules =
            options.allowedSharedDriveIds.length > 0 || options.allowedFolderIds.length > 0;

        if (hasLocationRules) {
            const locationOk = await isLocationCompliant(file, driveClient, options);
            if (!locationOk) {
                violations.push({ kind: 'wrong_location' });
            }
        }

        return {
            fileId,
            url,
            status: violations.length > 0 ? 'violations' : 'compliant',
            fileName,
            violations,
        };
    } catch (err: any) {
        const httpStatus = err?.response?.status as number | undefined;
        const errorMessage = String(err?.message ?? err);
        logger?.error(`[drive-checker] API error for ${fileId} — HTTP ${httpStatus ?? 'unknown'}: ${errorMessage}`);
        const status = httpStatus === 403 || httpStatus === 404 ? 'not_accessible' : 'cannot_check';
        return { fileId, url, status, fileName, violations: [], errorMessage };
    }
}

async function listAllPermissions(
    fileId: string,
    driveClient: drive_v3.Drive,
): Promise<drive_v3.Schema$Permission[] | null> {
    const results: drive_v3.Schema$Permission[] = [];
    let pageToken: string | undefined;
    try {
        do {
            const res = await driveClient.permissions.list({
                fileId,
                supportsAllDrives: true,
                fields: 'nextPageToken,permissions(id,type,role,allowFileDiscovery,domain)',
                pageToken,
            });
            results.push(...(res.data.permissions ?? []));
            pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
        return results;
    } catch {
        return null;
    }
}

async function isLocationCompliant(
    file: drive_v3.Schema$File,
    driveClient: drive_v3.Drive,
    options: ComplianceCheckerOptions,
): Promise<boolean> {
    // Check if file is in an allowed Shared Drive
    if (file.driveId && options.allowedSharedDriveIds.includes(file.driveId)) {
        return true;
    }

    // Check if file is under an allowed folder by traversing parents
    if (options.allowedFolderIds.length === 0) {
        return false;
    }

    const visited = new Set<string>();
    let currentParents: string[] = file.parents ?? [];

    for (let depth = 0; depth < options.maxParentTraversalDepth; depth++) {
        if (currentParents.length === 0) break;

        if (currentParents.some(id => options.allowedFolderIds.includes(id))) {
            return true;
        }

        const nextParents: string[] = [];
        for (const parentId of currentParents) {
            if (visited.has(parentId)) continue;
            visited.add(parentId);
            try {
                const res = await driveClient.files.get({
                    fileId: parentId,
                    fields: 'id,parents',
                    supportsAllDrives: true,
                } as drive_v3.Params$Resource$Files$Get);
                nextParents.push(...(res.data.parents ?? []));
            } catch {
                // skip inaccessible parent
            }
        }
        currentParents = nextParents;
    }

    return false;
}
