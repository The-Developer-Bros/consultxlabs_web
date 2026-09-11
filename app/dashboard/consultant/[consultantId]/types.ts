import { TConsultantProfile } from "@/types/consultant";
import { TAppointment } from "@/types/appointment";

export type DocumentUploadRole = "CONSULTEE" | "CONSULTANT";

export interface IDocument {
  id: string;
  appointmentId: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  storagePath?: string;
  description: string | null;
  reviewStatus:
    | "PENDING"
    | "IN_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "NEEDS_REVISION";
  reviewNotes: string | null;
  reviewedAt: Date | null;
  reviewedById?: string | null;
  uploadedAt: Date;
  // Upload role - who uploaded this document
  uploadedByRole: DocumentUploadRole;
  // Response document linking
  responseToDocumentId?: string | null;
  responseToDocument?: {
    id: string;
    originalName: string;
    uploadedByRole: DocumentUploadRole;
  } | null;
  responseDocuments?: IDocument[];
  // Threaded review versioning — 1 = original upload; the highest number in
  // a thread (rootDocumentId) is the current version.
  rootDocumentId?: string | null;
  versionNo?: number;
  // Client/appointment context
  clientName: string;
  clientId: string;
  appointmentTitle: string;
  appointmentType: string;
  // Legacy fields for existing UI compatibility
  title: string;
  invoiceNo: string;
  tag: string;
}

export interface IActivity {
  id: string;
  type: string;
  description: string;
  actorId: string;
  actorName: string;
  actorImage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  timeAgo: string;
}

export interface IApproval {
  id: string;
  name: string;
  type: string;
  date: string;
  time: string;
}

// Props for each tab component
export interface HomeTabProps {
  appointments: TAppointment[];
  onUpdate?: () => void;
}

export interface UnscheduledClass {
  id: string;
  status: string;
  schedulingPeriodStartsAt: string | null;
  schedulingPeriodEndsAt: string | null;
  classPlan: {
    id: string;
    title: string;
    sessionsPerWeek: number;
    sessionDurationInHours: number;
    totalSessions: number;
    consultantProfile?: {
      user?: {
        name: string;
        image: string | null;
      };
    };
  };
  appointments: unknown[];
}

export interface UnscheduledWebinar {
  id: string;
  status: string;
  webinarPlan: {
    id: string;
    title: string;
    durationInHours: number;
    consultantProfile?: {
      user?: {
        name: string;
        image: string | null;
      };
    };
  };
  appointment: null | undefined;
}

/**
 * Loading/error state for an auxiliary section fed by its own query
 * (trials / unscheduled classes / unscheduled webinars). Each section
 * renders its own skeleton and inline retry so one slow or failed query
 * can't blank the whole appointments page.
 */
export interface RequestsTabProps {
  approvals: IApproval[];
  onUpdate?: () => void;
}

/**
 * Pagination envelope returned by the consultant documents API (issue #346).
 * Defined here so both the fetch helper and the UI can import it.
 */
export interface DocumentsPagination {
  limit: number;
  offset: number;
  totalCount: number;
  totalPages: number;
  currentPage: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface DocumentsMetadata {
  pendingCount: number;
  reviewingCount: number;
  needsRevisionCount: number;
  completedCount: number;
}

export interface DocumentsPage {
  data: IDocument[];
  pagination: DocumentsPagination;
  metadata: DocumentsMetadata;
  count?: number;
  message?: string;
  consultant?: string;
  filters?: {
    status?: string | null;
    appointmentType?: string | null;
  };
}

export interface DocumentsTabProps {
  documentsPage: DocumentsPage | undefined;
  isPlaceholderData: boolean;

  // Pagination
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;

  // Filters (lifted up into the page component)
  statusFilter: string;
  typeFilter: string;
  onStatusFilterChange: (status: string) => void;
  onTypeFilterChange: (type: string) => void;
}

export interface ClientActivityProps {
  activities: IActivity[];
}

// Enum for section names
export enum DashboardSection {
  Home = "Home",
  Chats = "Chats",
  Appointments = "Appointments",
  Requests = "Requests",
  Trials = "Trials",
  Documents = "Documents for Review",
  Help = "Help",
  Settings = "Settings",
}

// Type for API responses
export type ApiResponse<T> = {
  data: T;
  error?: string;
  message?: string;
  count?: number;
  consultant?: string;
  appointmentTitle?: string;
  consultantName?: string;
  filters?: {
    status?: string;
    appointmentType?: string;
  };
  metadata?: {
    pendingCount?: number;
    reviewingCount?: number;
    completedCount?: number;
  };
  meta?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

// Type for sidebar props
export interface SidebarProps {
  activeSection: DashboardSection;
  setActiveSection: (section: DashboardSection) => void;
  consultant?: TConsultantProfile;
}
