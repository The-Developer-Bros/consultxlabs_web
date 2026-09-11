import { TAppointment } from "@/types/appointment";

/**
 * Types for the consultant dashboard API response
 * Matches the API in /api/dashboard/consultant/[consultantId]/route.ts
 *
 * Naming convention: T prefix for types (e.g., TConsultantActivity)
 */

// Activity type for recent client activities
// Matches the API response from /api/dashboard/consultant/[consultantId]/route.ts
interface TConsultantActivity {
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

// Approval type for pending consultation/subscription requests
interface TConsultantApproval {
  id: string;
  name: string;
  type: string;
  date: string;
  time: string;
}

// Performance snapshot for consultant dashboard KPIs
export interface TPerformanceSnapshot {
  /** Earnings this month in paise (divide by 100 for INR) */
  earningsThisMonth: number;
  /** Earnings last month in paise (divide by 100 for INR) */
  earningsLastMonth: number;
  earningsTrend: number;
  /** Session completion rate (last 30 days). null when no data. */
  completionRate: number | null;
  averageRating: number;
  totalReviews: number;
  /** Trial conversion rate (last 90 days). null when no data. */
  trialConversionRate: number | null;
}

// Financial summary for consultant dashboard home
export interface TFinancialSummary {
  /** Net earnings in paise (divide by 100 for INR) */
  netEarnings: number;
  /** Next payout amount in paise (divide by 100 for INR) */
  nextPayout: number;
  payoutStatus: string;
  activeClients: number;
  activePrograms: number;
}

// Full API response type for consultant dashboard
export interface TConsultantDashboardResponse {
  appointments: TAppointment[];
  activities: TConsultantActivity[];
  approvals: TConsultantApproval[];
  /** Total pending requests — `approvals` is a capped preview, so don't count it. */
  pendingRequestsCount: number;
  performanceSnapshot: TPerformanceSnapshot;
  financialSummary: TFinancialSummary;
}
