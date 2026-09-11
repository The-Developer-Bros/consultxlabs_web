"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { cn } from "@/utils/tailwind";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CreditCard,
  Clock,
  RefreshCw,
  AlertTriangle,
  DollarSign,
  Calendar,
  Wallet,
  Play,
  Loader2,
  Trash2,
  Database,
  Bell,
  History,
  CheckCircle2,
  XCircle,
} from "lucide-react";

// Job configuration
export interface SystemJob {
  id: string;
  name: string;
  description: string;
  schedule: string;
  category:
    | "Payments"
    | "Refunds"
    | "Disputes"
    | "Earnings"
    | "Appointments"
    | "Payouts"
    | "Cleanup"
    | "Reconciliation"
    | "Alerts";
}

const SYSTEM_JOBS: SystemJob[] = [
  // Payments
  {
    id: "cleanup-abandoned-payments",
    name: "Cleanup Abandoned Payments",
    description: "Cancel abandoned payment intents and expire pending payments",
    schedule: "Every 15 minutes",
    category: "Payments",
  },
  {
    id: "cleanup-approval-payments",
    name: "Cleanup Approval Payments",
    description: "Expire 48h+ pending approval payments",
    schedule: "Hourly",
    category: "Payments",
  },
  // Refunds
  {
    id: "reconcile-refunds",
    name: "Reconcile Pending Refunds",
    description: "Sync refund status with payment gateways (Stripe, Razorpay)",
    schedule: "Every 15 minutes",
    category: "Refunds",
  },
  // Disputes
  {
    id: "reconcile-disputes",
    name: "Reconcile Disputes",
    description: "Sync dispute status with Stripe and track urgent deadlines",
    schedule: "Every 6 hours",
    category: "Disputes",
  },
  {
    id: "handle-lost-disputes",
    name: "Handle Lost Disputes",
    description:
      "Reverse earnings on lost disputes (CRITICAL alerts if already paid)",
    schedule: "Every 6 hours",
    category: "Disputes",
  },
  // Earnings
  {
    id: "cascade-refund-earnings",
    name: "Cascade Refund to Earnings",
    description: "Mark earnings as REFUNDED when associated refund succeeds",
    schedule: "Every 15 minutes",
    category: "Earnings",
  },
  {
    id: "sync-payment-earnings",
    name: "Sync Payment to Earnings",
    description: "Create missing earnings records for succeeded payments",
    schedule: "Hourly",
    category: "Earnings",
  },
  {
    id: "release-earnings",
    name: "Release Earnings from Hold",
    description: "Move PENDING earnings to READY after hold period",
    schedule: "Hourly",
    category: "Earnings",
  },
  // Appointments
  {
    id: "cleanup-invalid-appointments",
    name: "Cleanup Invalid Appointments",
    description:
      "Cancel duplicate and invalid-duration consultations/subscriptions",
    schedule: "Hourly",
    category: "Appointments",
  },
  // Payouts
  {
    id: "create-payout-batch",
    name: "Create Payout Batch",
    description: "Create weekly payout batches for eligible consultants",
    schedule: "Weekly (Mon 8PM UTC)",
    category: "Payouts",
  },
  {
    id: "process-payouts",
    name: "Process Payouts",
    description: "Send approved payouts via RazorpayX and Stripe Connect",
    schedule: "Weekly (Mon 9PM UTC)",
    category: "Payouts",
  },
  {
    id: "handle-stuck-payouts",
    name: "Handle Stuck Payouts",
    description: "Retry payouts stuck in PROCESSING >24h, query gateway status",
    schedule: "Every 4 hours",
    category: "Payouts",
  },
  {
    id: "reconcile-payout-status",
    name: "Reconcile Payout Status",
    description: "Sync PENDING/PROCESSING payout status with gateways",
    schedule: "Every 6 hours",
    category: "Reconciliation",
  },
  // Alerts
  {
    id: "alert-orphaned-payments",
    name: "Alert Orphaned Payments",
    description: "Find SUCCEEDED payments with no appointment (CRITICAL)",
    schedule: "Every 6 hours",
    category: "Alerts",
  },
  {
    id: "alert-dispute-deadlines",
    name: "Alert Dispute Deadlines",
    description: "Alert when dispute dueBy is within 48h (URGENT)",
    schedule: "Hourly",
    category: "Alerts",
  },
  // Cleanup
  {
    id: "auth-tokens",
    name: "Auth Token Cleanup",
    description:
      "Delete expired sessions, verification tokens, password reset tokens",
    schedule: "Daily",
    category: "Cleanup",
  },
  {
    id: "tentative-slots",
    name: "Tentative Slot Cleanup",
    description: "Release slots held for abandoned booking flows >7 days",
    schedule: "Every 2 hours",
    category: "Cleanup",
  },
  {
    id: "stale-pending-consultations",
    name: "Stale Pending Consultations",
    description: "Cancel APPROVED consultations with no payment >7 days",
    schedule: "Hourly",
    category: "Cleanup",
  },
  {
    id: "expire-stale-requests",
    name: "Expire Stale Requests",
    description:
      "Auto-expire PENDING requests >30 days, APPROVED_PENDING_PAYMENT >7 days",
    schedule: "Daily",
    category: "Cleanup",
  },
  {
    id: "archive-webhook-events",
    name: "Archive Webhook Events",
    description: "Delete processed webhook events >30 days",
    schedule: "Weekly",
    category: "Cleanup",
  },
  {
    id: "deactivate-expired-discounts",
    name: "Deactivate Expired Discounts",
    description: "Deactivate discount codes past expiresAt or at max uses",
    schedule: "Daily",
    category: "Cleanup",
  },
  // Reconciliation
  {
    id: "reconcile-payment-status",
    name: "Reconcile Payment Status",
    description:
      "Query Stripe/Razorpay for actual status on stale PENDING payments",
    schedule: "Every 30 minutes",
    category: "Reconciliation",
  },
  {
    id: "reconcile-slot-availability",
    name: "Reconcile Slot Availability",
    description: "Fix tentative flags, detect double-bookings",
    schedule: "Hourly",
    category: "Reconciliation",
  },
  {
    id: "reconcile-document-storage",
    name: "Reconcile Document Storage",
    description: "Find orphaned/missing files in Supabase storage",
    schedule: "Daily",
    category: "Reconciliation",
  },
  // Appointments
  {
    id: "auto-complete-appointments",
    name: "Auto-Complete Appointments",
    description: "Move appointments to COMPLETED after session ends",
    schedule: "Hourly",
    category: "Appointments",
  },
];

const CATEGORY_CONFIG: Record<
  SystemJob["category"],
  { icon: typeof CreditCard }
> = {
  Payments: { icon: CreditCard },
  Refunds: { icon: RefreshCw },
  Disputes: { icon: AlertTriangle },
  Earnings: { icon: DollarSign },
  Appointments: { icon: Calendar },
  Payouts: { icon: Wallet },
  Cleanup: { icon: Trash2 },
  Reconciliation: { icon: Database },
  Alerts: { icon: Bell },
};

interface JobCardProps {
  job: SystemJob;
  isRunning: boolean;
  onRun: () => void;
}

function JobCard({ job, isRunning, onRun }: JobCardProps) {
  const config = CATEGORY_CONFIG[job.category];
  const Icon = config.icon;

  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2 }}
      className="relative overflow-hidden rounded-xl border border-border bg-card p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <Icon className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground text-sm">
                {job.name}
              </h3>
              <span className="inline-block mt-0.5 px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
                {job.category}
              </span>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mb-3">{job.description}</p>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
            <Clock className="h-3.5 w-3.5" />
            <span>{job.schedule}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-border">
        <Button
          size="sm"
          variant="outline"
          onClick={onRun}
          disabled={isRunning}
          className="w-full"
        >
          {isRunning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Running...
            </>
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" />
              Run Now
            </>
          )}
        </Button>
      </div>
    </motion.div>
  );
}

interface JobExecution {
  id: string;
  jobId: string;
  jobName: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: string;
  completedAt: string | null;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  triggeredBy: {
    name: string | null;
  };
}

interface SystemJobsPanelProps {
  className?: string;
}

export function SystemJobsPanel({ className }: SystemJobsPanelProps) {
  const [runningJobs, setRunningJobs] = useState<Set<string>>(new Set());
  const [executions, setExecutions] = useState<JobExecution[]>([]);
  const [loadingExecutions, setLoadingExecutions] = useState(true);
  const { toast } = useToast();

  // Fetch recent executions
  const fetchExecutions = async () => {
    try {
      setLoadingExecutions(true);
      const response = await fetch(
        "/api/staff/system-jobs/executions?limit=10",
      );
      if (!response.ok) throw new Error("Failed to fetch executions");
      const data = await response.json();
      setExecutions(data.executions || []);
    } catch (error) {
      console.error("Error fetching executions:", error);
    } finally {
      setLoadingExecutions(false);
    }
  };

  useEffect(() => {
    fetchExecutions();
  }, []);

  const handleRunJob = async (job: SystemJob) => {
    setRunningJobs((prev) => new Set(prev).add(job.id));

    try {
      const response = await fetch("/api/admin/system-jobs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to run job");
      }

      // Format result message
      const stats = [];
      if (result.totalProcessed !== undefined)
        stats.push(`Processed: ${result.totalProcessed}`);
      if (result.cleanedCount !== undefined)
        stats.push(`Cleaned: ${result.cleanedCount}`);
      if (result.updatedCount !== undefined)
        stats.push(`Updated: ${result.updatedCount}`);
      if (result.createdCount !== undefined)
        stats.push(`Created: ${result.createdCount}`);
      if (result.reconciledCount !== undefined)
        stats.push(`Reconciled: ${result.reconciledCount}`);
      if (result.releasedCount !== undefined)
        stats.push(`Released: ${result.releasedCount}`);
      if (result.errorCount !== undefined || result.errors?.length) {
        stats.push(
          `Errors: ${result.errorCount || result.errors?.length || 0}`,
        );
      }

      toast({
        title: `✅ ${job.name} completed`,
        description:
          stats.length > 0 ? stats.join(" | ") : "Job completed successfully",
        variant: "default",
      });

      // Check for critical alerts
      if (result.alreadyPaidCount > 0) {
        toast({
          title: "CRITICAL: Manual Recovery Required",
          description: `${result.alreadyPaidCount} earnings were already PAID when dispute was lost`,
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: `❌ ${job.name} failed`,
        description:
          error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
      // Refresh executions after job runs
      fetchExecutions();
    } finally {
      setRunningJobs((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
    }
  };

  // Group jobs by category
  const jobsByCategory = SYSTEM_JOBS.reduce(
    (acc, job) => {
      if (!acc[job.category]) acc[job.category] = [];
      acc[job.category].push(job);
      return acc;
    },
    {} as Record<string, SystemJob[]>,
  );

  const categories = Object.keys(jobsByCategory) as SystemJob["category"][];

  const formatExecutionTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getExecutionStatusBadge = (status: JobExecution["status"]) => {
    switch (status) {
      case "COMPLETED":
        return (
          <Badge className="bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400 gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Completed
          </Badge>
        );
      case "FAILED":
        return (
          <Badge className="bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400 gap-1">
            <XCircle className="h-3 w-3" />
            Failed
          </Badge>
        );
      case "RUNNING":
        return (
          <Badge className="bg-muted text-muted-foreground gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Running
          </Badge>
        );
    }
  };

  return (
    <div className={cn("space-y-8", className)}>
      {/* Recent Executions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5" />
                Recent Executions
              </CardTitle>
              <CardDescription>Last 10 job executions</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchExecutions}
              disabled={loadingExecutions}
            >
              <RefreshCw
                className={`h-4 w-4 ${loadingExecutions ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadingExecutions ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/70" />
            </div>
          ) : executions.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No recent executions
            </p>
          ) : (
            <div className="space-y-2">
              {executions.map((execution) => (
                <div
                  key={execution.id}
                  className="flex flex-col gap-2 p-3 rounded-lg border border-border sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {execution.jobName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        by {execution.triggeredBy.name || "System"} •{" "}
                        {formatExecutionTime(execution.startedAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {execution.result && (
                      <span className="text-xs text-muted-foreground/70">
                        {Object.entries(execution.result)
                          .slice(0, 2)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(", ")}
                      </span>
                    )}
                    {getExecutionStatusBadge(execution.status)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Job Categories */}
      {categories.map((category) => (
        <div key={category}>
          <div className="flex items-center gap-2 mb-4">
            {(() => {
              const Icon = CATEGORY_CONFIG[category].icon;
              return <Icon className="h-5 w-5 text-muted-foreground/70" />;
            })()}
            <h2 className="text-fluid-xl font-semibold tracking-tight text-foreground">
              {category}
            </h2>
            <span className="text-sm text-muted-foreground/70">
              ({jobsByCategory[category].length} jobs)
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {jobsByCategory[category].map((job) => (
              <JobCard
                key={job.id}
                job={job}
                isRunning={runningJobs.has(job.id)}
                onRun={() => handleRunJob(job)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
