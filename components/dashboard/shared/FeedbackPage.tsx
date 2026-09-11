"use client";

import { useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useDebouncedCallback } from "use-debounce";
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
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  MessageSquare,
  Clock,
  CheckCircle2,
  AlertCircle,
  MoreHorizontal,
  RefreshCw,
  Star,
  Loader2,
  Eye,
  Mail,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { FeedbackStatus } from "@prisma/client";
import type { Feedback, FeedbackCounts } from "@/types/feedback";

interface FeedbackListResponse {
  feedbacks: Feedback[];
  counts: FeedbackCounts;
  pagination: { totalPages: number };
}

const EMPTY_COUNTS: FeedbackCounts = {
  total: 0,
  pending: 0,
  acknowledged: 0,
  inProgress: 0,
  resolved: 0,
  closed: 0,
};

const STATUS_OPTIONS: { value: FeedbackStatus | "all"; label: string }[] = [
  { value: "all", label: "All Status" },
  { value: "PENDING", label: "Pending" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
];

const getStatusColor = (status: FeedbackStatus) => {
  switch (status) {
    case "PENDING":
      return "bg-amber-100 text-amber-700 border-amber-200";
    case "ACKNOWLEDGED":
      return "bg-blue-100 text-blue-700 border-blue-200";
    case "IN_PROGRESS":
      return "bg-purple-100 text-purple-700 border-purple-200";
    case "RESOLVED":
      return "bg-green-100 text-green-700 border-green-200";
    case "CLOSED":
      return "bg-muted text-muted-foreground border-border";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
};

const getStatusIcon = (status: FeedbackStatus) => {
  switch (status) {
    case "PENDING":
      return <AlertCircle className="h-4 w-4 text-amber-500" />;
    case "ACKNOWLEDGED":
      return <Eye className="h-4 w-4 text-blue-500" />;
    case "IN_PROGRESS":
      return <Clock className="h-4 w-4 text-purple-500" />;
    case "RESOLVED":
    case "CLOSED":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    default:
      return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
  }
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
};

export interface FeedbackPageProps {
  /** API endpoint for fetching/updating feedback (e.g. "/api/staff/feedbacks") */
  apiEndpoint?: string;
  /** Page title */
  title?: string;
  /** Page description */
  description?: string;
}

export function FeedbackPage({
  apiEndpoint = "/api/staff/feedbacks",
  title = "User Feedback",
  description = "Manage and respond to user feedback across the platform",
}: FeedbackPageProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  // Detail view state
  const [selectedFeedback, setSelectedFeedback] = useState<Feedback | null>(
    null,
  );

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [localSearchValue, setLocalSearchValue] = useState("");

  const debouncedSetSearch = useDebouncedCallback((value: string) => {
    setDebouncedSearch(value);
    setPage(1);
  }, 300);

  const handleSearchChange = (value: string) => {
    setLocalSearchValue(value);
    debouncedSetSearch(value);
  };

  const { data, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: [
      "admin-feedbacks",
      apiEndpoint,
      page,
      statusFilter,
      debouncedSearch,
    ],
    queryFn: async (): Promise<FeedbackListResponse> => {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "20",
        ...(statusFilter !== "all" && { status: statusFilter }),
        ...(debouncedSearch && { search: debouncedSearch }),
      });

      const response = await fetch(`${apiEndpoint}?${params}`);
      if (!response.ok) throw new Error("Failed to fetch feedbacks");
      return response.json();
    },
    placeholderData: keepPreviousData,
  });

  const feedbacks = data?.feedbacks ?? [];
  const counts = data?.counts ?? EMPTY_COUNTS;
  const totalPages = data?.pagination.totalPages ?? 1;

  const updateStatus = useMutation({
    mutationFn: async ({
      feedbackId,
      newStatus,
    }: {
      feedbackId: string;
      newStatus: FeedbackStatus;
    }) => {
      const response = await fetch(`${apiEndpoint}/${feedbackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!response.ok) throw new Error("Failed to update status");
      return { feedbackId, newStatus };
    },
    onSuccess: ({ feedbackId, newStatus }) => {
      toast({ title: "Success", description: "Status updated successfully" });
      queryClient.invalidateQueries({ queryKey: ["admin-feedbacks"] });
      // Keep the open detail modal in sync without waiting for the refetch.
      setSelectedFeedback((current) =>
        current?.id === feedbackId
          ? { ...current, status: newStatus }
          : current,
      );
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update status",
        variant: "destructive",
      });
    },
  });

  const handleUpdateStatus = (feedbackId: string, newStatus: FeedbackStatus) =>
    updateStatus.mutate({ feedbackId, newStatus });

  const renderRowActions = (feedback: Feedback) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            setSelectedFeedback(feedback);
          }}
        >
          View Details
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            handleUpdateStatus(feedback.id, "ACKNOWLEDGED");
          }}
        >
          Mark Acknowledged
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            handleUpdateStatus(feedback.id, "RESOLVED");
          }}
        >
          Mark Resolved
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            handleUpdateStatus(feedback.id, "CLOSED");
          }}
        >
          Close
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const columns: ResponsiveColumn<Feedback>[] = [
    {
      key: "id",
      header: "ID",
      className: "font-mono text-xs text-muted-foreground",
      headClassName: "w-24",
      cell: (feedback) => feedback.id.slice(0, 8).toUpperCase(),
    },
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (feedback) => (
        <div className="flex items-center gap-2">
          {getStatusIcon(feedback.status)}
          <span className="font-medium truncate max-w-[200px]">
            {feedback.title}
          </span>
        </div>
      ),
    },
    {
      key: "user",
      header: "User",
      cell: (feedback) => (
        <div className="flex items-center gap-2">
          <Avatar className="h-7 w-7">
            <AvatarImage src={feedback.user.image || ""} />
            <AvatarFallback className="text-xs">
              {feedback.user.name?.charAt(0) || "U"}
            </AvatarFallback>
          </Avatar>
          <span className="text-sm">{feedback.user.name || "Unknown"}</span>
        </div>
      ),
    },
    {
      key: "rating",
      header: "Rating",
      cell: (feedback) =>
        feedback.rating ? (
          <div className="flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star
                key={i}
                className={`h-3.5 w-3.5 ${
                  i < feedback.rating!
                    ? "text-amber-500 fill-amber-500"
                    : "text-muted-foreground/40"
                }`}
              />
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground/70 text-sm">-</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (feedback) => (
        <Badge variant="outline" className={getStatusColor(feedback.status)}>
          {feedback.status.replace("_", " ")}
        </Badge>
      ),
    },
    {
      key: "submitted",
      header: "Submitted",
      className: "text-muted-foreground text-sm",
      cell: (feedback) => formatDate(feedback.createdAt),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <DashboardHeader
        title={title}
        subtitle={description}
        actions={
          <Button
            onClick={() => refetch()}
            variant="outline"
            size="sm"
            disabled={isFetching}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Pending
                </p>
                <p className="text-2xl font-bold text-amber-600">
                  {counts.pending}
                </p>
              </div>
              <AlertCircle className="h-8 w-8 text-amber-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Acknowledged
                </p>
                <p className="text-2xl font-bold text-blue-600">
                  {counts.acknowledged}
                </p>
              </div>
              <Eye className="h-8 w-8 text-blue-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  In Progress
                </p>
                <p className="text-2xl font-bold text-purple-600">
                  {counts.inProgress}
                </p>
              </div>
              <Clock className="h-8 w-8 text-purple-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Resolved
                </p>
                <p className="text-2xl font-bold text-green-600">
                  {counts.resolved}
                </p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-green-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Total
                </p>
                <p className="text-2xl font-bold text-foreground">
                  {counts.total}
                </p>
              </div>
              <MessageSquare className="h-8 w-8 text-muted-foreground/40" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
              <Input
                placeholder="Search by title, description, or user..."
                value={localSearchValue}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Feedback Table */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-0 sm:p-6">
          {isError && !data ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                <span>Failed to load feedback.</span>
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
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/70" />
            </div>
          ) : (
            <ResponsiveTable<Feedback>
              columns={columns}
              rows={feedbacks}
              getRowId={(f) => f.id}
              onRowClick={(f) => setSelectedFeedback(f)}
              rowActions={renderRowActions}
              empty={
                <div className="text-center py-12">
                  <MessageSquare className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
                  <p className="text-muted-foreground">No feedback found</p>
                </div>
              }
            />
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            Next
          </Button>
        </div>
      )}

      {/* Detail Dialog */}
      <ResponsiveModal
        open={!!selectedFeedback}
        onOpenChange={(open) => !open && setSelectedFeedback(null)}
      >
        <ResponsiveModalContent className="sm:max-w-lg">
          {selectedFeedback && (
            <>
              <ResponsiveModalHeader>
                <ResponsiveModalTitle className="flex items-center gap-2">
                  {getStatusIcon(selectedFeedback.status)}
                  {selectedFeedback.title}
                </ResponsiveModalTitle>
                <ResponsiveModalDescription>
                  Submitted {formatDate(selectedFeedback.createdAt)}
                </ResponsiveModalDescription>
              </ResponsiveModalHeader>

              <div className="space-y-4">
                {/* User Info */}
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
                  <Avatar>
                    <AvatarImage src={selectedFeedback.user.image || ""} />
                    <AvatarFallback>
                      {selectedFeedback.user.name?.charAt(0) || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <p className="font-medium">
                      {selectedFeedback.user.name || "Unknown"}
                    </p>
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      {selectedFeedback.user.email && (
                        <span className="flex items-center gap-1">
                          <Mail className="h-3 w-3" />
                          {selectedFeedback.user.email}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Rating */}
                {selectedFeedback.rating && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                      Rating
                    </p>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`h-5 w-5 ${
                            i < selectedFeedback.rating!
                              ? "text-amber-500 fill-amber-500"
                              : "text-muted-foreground/40"
                          }`}
                        />
                      ))}
                      <span className="ml-2 text-sm text-muted-foreground">
                        {selectedFeedback.rating} / 5
                      </span>
                    </div>
                  </div>
                )}

                {/* Description */}
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                    Description
                  </p>
                  <p className="text-sm text-foreground whitespace-pre-wrap">
                    {selectedFeedback.description}
                  </p>
                </div>

                {/* Status Update */}
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
                    Update Status
                  </p>
                  <Select
                    value={selectedFeedback.status}
                    onValueChange={(value) =>
                      handleUpdateStatus(
                        selectedFeedback.id,
                        value as FeedbackStatus,
                      )
                    }
                    disabled={updateStatus.isPending}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">Pending</SelectItem>
                      <SelectItem value="ACKNOWLEDGED">Acknowledged</SelectItem>
                      <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                      <SelectItem value="RESOLVED">Resolved</SelectItem>
                      <SelectItem value="CLOSED">Closed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
