export type PermissionViolation =
    | { kind: 'public_access'; allowFileDiscovery: boolean }
    | { kind: 'domain_sharing' };

export type LocationViolation = { kind: 'wrong_location' };

export type ComplianceViolation = PermissionViolation | LocationViolation;

export type ComplianceStatus = 'compliant' | 'violations' | 'cannot_check' | 'not_accessible';

export type ComplianceResult = {
    fileId: string;
    url: string;
    status: ComplianceStatus;
    fileName?: string;
    violations: ComplianceViolation[];
    errorMessage?: string;
};

export type ComplianceCheckerOptions = {
    allowedSharedDriveIds: string[];
    allowedFolderIds: string[];
    allowDomainSharing: boolean;
    maxParentTraversalDepth: number;
};
