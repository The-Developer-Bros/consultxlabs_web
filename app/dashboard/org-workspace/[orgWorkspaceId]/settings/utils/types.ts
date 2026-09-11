/**
 * Shared types for the OrgWorkspace settings page.
 *
 * Mirrors the wire shape returned by GET /api/org-workspace/[id]/settings.
 * Enum kept inline rather than imported from `@prisma/client` so the
 * client bundle doesn't pull Prisma's generated machinery.
 */

export type NotificationRoutingMode =
  | "BELL_AND_EMAIL"
  | "BELL_ONLY"
  | "EMAIL_ONLY"
  | "NEITHER";

interface OrgWorkspaceSettings {
  id: string;
  defaultLandingOrganizationId: string | null;
  notificationRoutingMode: NotificationRoutingMode;
  locale: string | null;
  currencyDisplayCode: string | null;
  updatedAt: string;
}

export interface CandidateOrg {
  id: string;
  name: string;
  status: string;
}

export interface SettingsGetResponse {
  profile: OrgWorkspaceSettings;
  candidateOrgs: CandidateOrg[];
}

export interface PatchSettingsBody {
  defaultLandingOrganizationId?: string | null;
  notificationRoutingMode?: NotificationRoutingMode;
  locale?: string | null;
  currencyDisplayCode?: string | null;
}
