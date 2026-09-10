"use client";

import { useState, useEffect, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Users,
  UserCheck,
  UserX,
  Shield,
  MoreHorizontal,
  Eye,
  CheckCircle,
  Loader2,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";
import { UserDetailModal } from "@/components/admin/UserDetailModal";
import { VerificationQueue } from "@/components/admin/VerificationQueue";
import type { UserListItem, UserListResponse } from "@/types/admin-users";

const getRoleColor = (role: string) => {
  switch (role) {
    case "CONSULTANT":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    case "CONSULTEE":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "ADMIN":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "STAFF":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const getStatusColor = (onboardingCompleted: boolean | null) => {
  if (onboardingCompleted === true) {
    return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
  } else if (onboardingCompleted === false) {
    return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
  }
  return "bg-muted text-muted-foreground";
};

const getStatusText = (onboardingCompleted: boolean | null) => {
  if (onboardingCompleted === true) return "active";
  if (onboardingCompleted === false) return "pending";
  return "unknown";
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

export function OperatorUsersPage() {
  const [activeTab, setActiveTab] = useState("all-users");
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: ["operator-users", page, debouncedSearch, roleFilter],
    queryFn: async (): Promise<UserListResponse> => {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (roleFilter !== "all") params.set("role", roleFilter);

      const response = await fetch(`/api/admin/users?${params}`);
      if (!response.ok) throw new Error("Failed to fetch users");
      return response.json();
    },
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });

  const users = useMemo(() => data?.users ?? [], [data]);
  const totalPages = data?.totalPages ?? 1;
  const total = data?.total ?? 0;

  const { data: moderationStats } = useQuery({
    queryKey: ["operator-moderation-stats"],
    queryFn: async (): Promise<{
      stats: { pendingProfiles: number };
    } | null> => {
      const response = await fetch("/api/staff/moderation/stats");
      if (!response.ok) return null;
      return response.json();
    },
  });
  // `stats.pendingProfiles` is what /api/staff/moderation/stats returns. The
  // comment that used to sit here asserted the opposite, and the code followed
  // it: #1029 renamed the field to `pendingProfiles` in the same commit that
  // extracted this component, so reading `pendingVerifications` pinned the
  // badge at 0 and hid every pending consultant verification from the tab.
  const pendingCount = moderationStats?.stats.pendingProfiles ?? 0;

  // Calculate user counts from current data
  const userCounts = useMemo(
    () => ({
      total: total,
      consultants: users.filter((u) => u.role === "CONSULTANT").length,
      consultees: users.filter((u) => u.role === "CONSULTEE").length,
      pending: users.filter((u) => u.onboardingCompleted === false).length,
    }),
    [users, total],
  );

  const handleViewUser = (userId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedUserId(userId);
  };

  const columns: ResponsiveColumn<UserListItem>[] = [
    {
      key: "user",
      header: "User",
      primary: true,
      cell: (user) => (
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarImage src={user.image || ""} />
            <AvatarFallback>
              {(user.name || user.email || "?")
                .split(" ")
                .map((n) => n[0])
                .join("")
                .toUpperCase()
                .slice(0, 2)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="font-medium flex items-center gap-1 text-foreground">
              {user.name || "Unnamed"}
              {user.onboardingCompleted && (
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
              )}
            </p>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      cell: (user) => (
        <Badge className={getRoleColor(user.role)} variant="secondary">
          {user.role?.toLowerCase() || "unknown"}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (user) => (
        <Badge
          className={getStatusColor(user.onboardingCompleted)}
          variant="secondary"
        >
          {getStatusText(user.onboardingCompleted)}
        </Badge>
      ),
    },
    {
      key: "joined",
      header: "Joined",
      className: "text-sm text-muted-foreground",
      cell: (user) => formatDate(user.createdAt),
    },
  ];

  const renderRowActions = (user: UserListItem) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* #1270 — "Send Email", "Flag Account" and "Suspend User" used to sit
            here with no onClick at all: they rendered, they highlighted on
            hover, they closed the menu, and nothing happened. Removed rather
            than wired, because banning is ADMIN-only and belongs to the
            moderation flow, and an operator who believes they have suspended
            an account is worse than one who can see the button is absent. */}
        <DropdownMenuItem onClick={(e) => handleViewUser(user.id, e)}>
          <Eye className="h-4 w-4 mr-2" />
          View Details
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const emptyState = (
    <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
      <Users className="h-12 w-12 mb-4 text-muted-foreground/40" />
      <p>No users found</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="User Management"
        subtitle="View and manage user accounts"
        actions={
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{total}</p>
              <p className="text-sm text-muted-foreground">Total Users</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <Shield className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{userCounts.consultants}</p>
              <p className="text-sm text-muted-foreground">Consultants (page)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <UserCheck className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{userCounts.consultees}</p>
              <p className="text-sm text-muted-foreground">Consultees (page)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <UserX className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{userCounts.pending}</p>
              <p className="text-sm text-muted-foreground">Pending (page)</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all-users" className="gap-2">
            <Users className="h-4 w-4" />
            All Users
          </TabsTrigger>
          <TabsTrigger value="pending-verification" className="gap-2">
            <ShieldCheck className="h-4 w-4" />
            Pending Verification
            {pendingCount > 0 && (
              <Badge
                variant="secondary"
                className="ml-1 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              >
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* All Users Tab */}
        <TabsContent value="all-users" className="space-y-4">
          {/* Filters */}
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
                  <Input
                    placeholder="Search by name or email..."
                    className="pl-9"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <Select
                  value={roleFilter}
                  onValueChange={(v) => {
                    setRoleFilter(v);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-full sm:w-40">
                    <SelectValue placeholder="Role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Roles</SelectItem>
                    <SelectItem value="CONSULTANT">Consultant</SelectItem>
                    <SelectItem value="CONSULTEE">Consultee</SelectItem>
                    <SelectItem value="STAFF">Staff</SelectItem>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Users Table */}
          <Card>
            <CardContent className="p-4">
              {isError && !data ? (
                <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
                  <div className="flex items-center gap-2 text-destructive">
                    <AlertTriangle className="h-5 w-5" />
                    <span>Failed to load users.</span>
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
              ) : isPending ? (
                <div className="flex items-center justify-center h-64">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/70" />
                </div>
              ) : (
                <ResponsiveTable<UserListItem>
                  columns={columns}
                  rows={users}
                  getRowId={(u) => u.id}
                  onRowClick={(u) => setSelectedUserId(u.id)}
                  rowActions={renderRowActions}
                  empty={emptyState}
                />
              )}
            </CardContent>
          </Card>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-2">
              <Button
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <span className="flex items-center px-4 text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </TabsContent>

        {/* Pending Verification Tab */}
        <TabsContent value="pending-verification">
          <VerificationQueue apiBasePath="/api/admin/verification" />
        </TabsContent>
      </Tabs>

      {/* User Detail Modal */}
      <UserDetailModal
        userId={selectedUserId}
        open={!!selectedUserId}
        onOpenChange={(open) => !open && setSelectedUserId(null)}
      />
    </div>
  );
}
