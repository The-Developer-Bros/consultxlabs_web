"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { HomeSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Ticket,
  Users,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  ArrowRight,
  Bell,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { ticketLabel } from "@/utils/supportTicketUrl";

interface RecentTicket {
  id: string;
  /** #705 — the minted handle; null on tickets that predate it. */
  referenceNumber?: string | null;
  subject: string;
  user: string;
  userImage: string | null;
  status: string;
  priority: string;
  createdAt: string;
}

interface StaffStats {
  openTickets: number;
  usersAssisted: number;
  pendingReviews: number;
  resolvedToday: number;
  recentTickets: RecentTicket[];
}

// #890 — queryKey MUST stay ["staff-stats"]; the route returns the bare stats
// object (no { data, success } envelope), so the response is consumed verbatim.
async function fetchStaffStats(): Promise<StaffStats> {
  const response = await fetch("/api/staff/stats");
  if (!response.ok) throw new Error("Failed to fetch stats");
  return response.json();
}

// Static announcements (these could come from an API in the future)
const announcements = [
  {
    title: "System Maintenance Scheduled",
    description: "Platform maintenance on Saturday 2 AM - 4 AM IST",
    date: "Dec 21, 2025",
    type: "warning",
  },
  {
    title: "New Ticket Categories Added",
    description: "Please review the updated ticket categorization guidelines",
    date: "Dec 19, 2025",
    type: "info",
  },
];

const getStatusColor = (status: string) => {
  switch (status) {
    case "open":
      return "bg-muted text-foreground";
    case "in_progress":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "pending":
      return "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300";
    case "resolved":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const getPriorityColor = (priority: string) => {
  switch (priority) {
    case "high":
    case "urgent":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "medium":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    case "low":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const formatTimeAgo = (dateString: string) => {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
};

export default function HomePageClient({
  staffId,
}: Readonly<{ staffId: string }>) {
  // #890 — key ["staff-stats"] matches the SSR prefetch in page.tsx so this
  // hydrates without a fetch waterfall.
  const {
    data: stats,
    isLoading,
    isFetching,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["staff-stats"],
    queryFn: fetchStaffStats,
    refetchOnWindowFocus: false,
  });

  const loading = isLoading || isFetching;

  // Match route HomeSkeleton — avoid Loader2 flash after soft-nav.
  if (isLoading && !stats) {
    return <HomeSkeleton />;
  }

  // Don't render zeros + "No recent tickets" on a failed fetch — that reads
  // as a healthy-but-empty queue and hides the operational failure. Only
  // when there's no cached payload to fall back on.
  if (isError && !stats) {
    return (
      <div className="space-y-6">
        <DashboardHeader
          title="Dashboard"
          subtitle="Welcome back! Here's what's happening today."
        />
        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col items-start gap-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                <span>Failed to load staff stats.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetch()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const statsConfig = [
    {
      title: "Open Tickets",
      value: stats?.openTickets ?? 0,
      change: "Needs attention",
      icon: Ticket,
    },
    {
      title: "Users Assisted",
      value: stats?.usersAssisted ?? 0,
      change: "This week",
      icon: Users,
    },
    {
      title: "Pending Reviews",
      value: stats?.pendingReviews ?? 0,
      change: "Consultant reviews",
      icon: AlertTriangle,
    },
    {
      title: "Resolved Today",
      value: stats?.resolvedToday ?? 0,
      change: "Keep it up!",
      icon: CheckCircle2,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <DashboardHeader
        title="Dashboard"
        subtitle="Welcome back! Here's what's happening today."
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              aria-label="Refresh dashboard stats"
              title="Refresh dashboard stats"
              onClick={() => refetch()}
              disabled={loading}
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
            </Button>
            <Button variant="outline" className="gap-2">
              <Bell className="h-4 w-4" />
              Notifications
              {stats && stats.openTickets > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {stats.openTickets}
                </Badge>
              )}
            </Button>
          </>
        }
      />

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {loading && !stats
          ? Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="space-y-3 p-6">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-8 w-16" />
                  <Skeleton className="h-3 w-20" />
                </CardContent>
              </Card>
            ))
          : statsConfig.map((stat) => (
              <Card key={stat.title}>
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div className="p-2 rounded-lg bg-muted">
                      <stat.icon className="h-5 w-5 text-foreground" />
                    </div>
                    <TrendingUp className="h-4 w-4 text-muted-foreground/70" />
                  </div>
                  <div className="mt-4">
                    <p className="text-2xl font-bold text-foreground">
                      {stat.value}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {stat.title}
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      {stat.change}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Recent Tickets */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Recent Tickets</CardTitle>
              <CardDescription>
                Latest support tickets requiring attention
              </CardDescription>
            </div>
            <Link href={`/dashboard/staff/${staffId}/tickets`}>
              <Button variant="ghost" size="sm" className="gap-1">
                View all
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {loading && !stats ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            ) : !stats?.recentTickets || stats.recentTickets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <Ticket className="h-12 w-12 mb-4 text-muted-foreground/40" />
                <p>No recent tickets</p>
              </div>
            ) : (
              <div className="space-y-4">
                {stats.recentTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-border hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Avatar className="h-9 w-9">
                        <AvatarImage src={ticket.userImage || ""} />
                        <AvatarFallback className="text-xs">
                          {ticket.user
                            .split(" ")
                            .map((n) => n[0])
                            .join("")}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {ticket.subject}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {ticketLabel(ticket)} • {ticket.user}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        className={getPriorityColor(ticket.priority)}
                        variant="secondary"
                      >
                        {ticket.priority}
                      </Badge>
                      <Badge
                        className={getStatusColor(ticket.status)}
                        variant="secondary"
                      >
                        {ticket.status.replace("_", " ")}
                      </Badge>
                      <span className="text-xs text-muted-foreground/70 ml-2 hidden sm:inline">
                        {formatTimeAgo(ticket.createdAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Announcements */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="h-5 w-5" />
              Announcements
            </CardTitle>
            <CardDescription>Important updates from admin</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {announcements.map((announcement, index) => (
                <div
                  key={index}
                  className="p-3 rounded-lg border border-border"
                >
                  <div className="flex items-start gap-2">
                    {announcement.type === "warning" ? (
                      <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5" />
                    ) : (
                      <Bell className="h-4 w-4 text-muted-foreground mt-0.5" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {announcement.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {announcement.description}
                      </p>
                      <p className="text-xs text-muted-foreground/70 mt-2">
                        {announcement.date}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common tasks and shortcuts</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Link href={`/dashboard/staff/${staffId}/tickets`}>
              <Button variant="outline" className="w-full justify-start gap-2">
                <Ticket className="h-4 w-4" />
                View Open Tickets
              </Button>
            </Link>
            <Link href={`/dashboard/staff/${staffId}/users`}>
              <Button variant="outline" className="w-full justify-start gap-2">
                <Users className="h-4 w-4" />
                Search Users
              </Button>
            </Link>
            <Link href={`/dashboard/staff/${staffId}/moderation`}>
              <Button variant="outline" className="w-full justify-start gap-2">
                <AlertTriangle className="h-4 w-4" />
                Review Content
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
