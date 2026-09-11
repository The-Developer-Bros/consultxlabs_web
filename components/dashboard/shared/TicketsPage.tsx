"use client";

import * as Sentry from "@sentry/nextjs";
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
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Search,
  MessageSquare,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
  RefreshCw,
  Send,
  Loader2,
  CreditCard,
  FileText,
  ExternalLink,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import type { Ticket, TicketCounts, TicketListResponse } from "@/types/tickets";
import { ticketLabel } from "@/utils/supportTicketUrl";

const EMPTY_COUNTS: TicketCounts = {
  total: 0,
  open: 0,
  inProgress: 0,
  onHold: 0,
  resolved: 0,
  closed: 0,
};

const getStatusColor = (status: string) => {
  switch (status.toUpperCase()) {
    case "OPEN":
      return "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800";
    case "IN_PROGRESS":
      return "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800";
    case "ON_HOLD":
      return "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-800";
    case "RESOLVED":
      return "bg-green-100 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-800";
    case "CLOSED":
      return "bg-muted text-muted-foreground border-border";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
};

const getPriorityColor = (priority: string) => {
  switch (priority.toUpperCase()) {
    case "URGENT":
    case "HIGH":
      return "bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800";
    case "MEDIUM":
      return "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800";
    case "LOW":
      return "bg-muted text-muted-foreground border-border";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toUpperCase()) {
    case "OPEN":
      return <AlertCircle className="h-4 w-4 text-blue-500" />;
    case "IN_PROGRESS":
      return <Clock className="h-4 w-4 text-yellow-500" />;
    case "ON_HOLD":
      return <Clock className="h-4 w-4 text-orange-500" />;
    case "RESOLVED":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case "CLOSED":
      return <XCircle className="h-4 w-4 text-muted-foreground" />;
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

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatCurrency = (amount: number, currency: string) => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency || "INR",
  }).format(amount / 100);
};

const formatIssueType = (issueType: string | null) => {
  if (!issueType) return "-";
  return issueType.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
};

export function TicketsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [page, setPage] = useState(1);

  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [replyText, setReplyText] = useState("");
  const [isInternalNote, setIsInternalNote] = useState(false);

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
      "operator-tickets",
      page,
      statusFilter,
      priorityFilter,
      debouncedSearch,
    ],
    queryFn: async (): Promise<TicketListResponse> => {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "20",
        ...(statusFilter !== "all" && { status: statusFilter }),
        ...(priorityFilter !== "all" && { priority: priorityFilter }),
        ...(debouncedSearch && { search: debouncedSearch }),
      });

      const response = await fetch(`/api/staff/support-tickets?${params}`);
      if (!response.ok) throw new Error("Failed to fetch tickets");
      return response.json();
    },
    placeholderData: keepPreviousData,
  });

  const tickets = data?.tickets ?? [];
  const counts = data?.counts ?? EMPTY_COUNTS;
  const totalPages = data?.pagination.totalPages ?? 1;

  const {
    data: ticketDetail,
    isLoading: loadingDetail,
    isError: isDetailError,
    refetch: refetchDetail,
  } = useQuery({
    queryKey: ["operator-ticket-detail", selectedTicket?.id],
    queryFn: async (): Promise<Ticket> => {
      const response = await fetch(
        `/api/staff/support-tickets/${selectedTicket!.id}`,
      );
      if (!response.ok) throw new Error("Failed to fetch ticket detail");
      return response.json();
    },
    enabled: !!selectedTicket,
  });

  const handleSelectTicket = (ticket: Ticket) => {
    setSelectedTicket(ticket);
  };

  const updateStatus = useMutation({
    mutationFn: async ({
      ticketId,
      newStatus,
    }: {
      ticketId: string;
      newStatus: string;
    }) => {
      const response = await fetch(`/api/staff/support-tickets/${ticketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!response.ok) throw new Error("Failed to update status");
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Status updated successfully" });
      queryClient.invalidateQueries({ queryKey: ["operator-tickets"] });
      queryClient.invalidateQueries({ queryKey: ["operator-ticket-detail"] });
    },
    onError: (error) => {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
        description: "Failed to update status",
        variant: "destructive",
      });
    },
  });

  const handleUpdateStatus = (newStatus: string) => {
    if (!selectedTicket) return;
    updateStatus.mutate({ ticketId: selectedTicket.id, newStatus });
  };
  const updatingStatus = updateStatus.isPending;

  const sendReply = useMutation({
    mutationFn: async ({
      ticketId,
      message,
      isInternal,
    }: {
      ticketId: string;
      message: string;
      isInternal: boolean;
    }) => {
      const response = await fetch(
        `/api/staff/support-tickets/${ticketId}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, isInternal }),
        },
      );
      if (!response.ok) throw new Error("Failed to send reply");
    },
    onSuccess: (_data, variables) => {
      toast({
        title: "Success",
        description: variables.isInternal
          ? "Internal note added"
          : "Reply sent",
      });
      setReplyText("");
      setIsInternalNote(false);
      queryClient.invalidateQueries({ queryKey: ["operator-ticket-detail"] });
      queryClient.invalidateQueries({ queryKey: ["operator-tickets"] });
    },
    onError: (error) => {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
        description: "Failed to send reply",
        variant: "destructive",
      });
    },
  });

  const handleSendReply = () => {
    if (!selectedTicket || !replyText.trim()) return;
    sendReply.mutate({
      ticketId: selectedTicket.id,
      message: replyText,
      isInternal: isInternalNote,
    });
  };
  const sendingReply = sendReply.isPending;

  const quickAction = useMutation({
    mutationFn: async ({
      ticketId,
      action,
    }: {
      ticketId: string;
      action: string;
    }) => {
      if (action === "close") {
        const response = await fetch(`/api/staff/support-tickets/${ticketId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "CLOSED" }),
        });
        if (!response.ok) throw new Error("Failed to close ticket");
      } else if (action === "resolve") {
        const response = await fetch(`/api/staff/support-tickets/${ticketId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "RESOLVED" }),
        });
        if (!response.ok) throw new Error("Failed to resolve ticket");
      }
      return action;
    },
    onSuccess: (action) => {
      if (action === "close") {
        toast({ title: "Success", description: "Ticket closed" });
      } else if (action === "resolve") {
        toast({ title: "Success", description: "Ticket resolved" });
      }
      queryClient.invalidateQueries({ queryKey: ["operator-tickets"] });
    },
    onError: (error) => {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
        description: "Action failed",
        variant: "destructive",
      });
    },
  });

  const handleQuickAction = (
    ticketId: string,
    action: string,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    quickAction.mutate({ ticketId, action });
  };

  const columns: ResponsiveColumn<Ticket>[] = [
    {
      key: "ticketId",
      header: "Ticket ID",
      className: "font-mono text-xs text-muted-foreground",
      cell: (ticket) => ticketLabel(ticket),
    },
    {
      key: "subject",
      header: "Subject",
      primary: true,
      cell: (ticket) => (
        <div className="flex items-center gap-2">
          {getStatusIcon(ticket.status)}
          <span className="font-medium truncate max-w-[200px]">
            {ticket.title}
          </span>
          {ticket.responses && ticket.responses.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              <MessageSquare className="h-3 w-3 mr-1" />
              {ticket.responses.length}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "user",
      header: "User",
      cell: (ticket) => (
        <div className="flex items-center gap-2">
          <Avatar className="h-7 w-7">
            <AvatarImage src={ticket.user?.image || ""} />
            <AvatarFallback className="text-xs">
              {ticket.user?.name?.charAt(0) || "U"}
            </AvatarFallback>
          </Avatar>
          <span className="text-sm">{ticket.user?.name || "Unknown"}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (ticket) => (
        <Badge variant="outline" className={getStatusColor(ticket.status)}>
          {ticket.status.replace("_", " ")}
        </Badge>
      ),
    },
    {
      key: "priority",
      header: "Priority",
      cell: (ticket) => (
        <Badge variant="outline" className={getPriorityColor(ticket.priority)}>
          {ticket.priority}
        </Badge>
      ),
    },
    {
      key: "issueType",
      header: "Issue Type",
      className: "text-sm text-muted-foreground",
      cell: (ticket) => formatIssueType(ticket.issueType),
    },
    {
      key: "updated",
      header: "Updated",
      className: "text-sm text-muted-foreground",
      cell: (ticket) => formatDate(ticket.updatedAt),
    },
  ];

  const renderRowActions = (ticket: Ticket) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            handleSelectTicket(ticket);
          }}
        >
          View Details
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={(e) => handleQuickAction(ticket.id, "resolve", e)}
        >
          Mark Resolved
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => handleQuickAction(ticket.id, "close", e)}
        >
          Close Ticket
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const emptyState = (
    <div className="text-center py-12">
      <MessageSquare className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
      <p className="text-muted-foreground">No tickets found</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Support Tickets"
        subtitle="Manage all customer support tickets"
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

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-6">
        {[
          { label: "Open", value: counts.open, color: "text-foreground" },
          {
            label: "In Progress",
            value: counts.inProgress,
            color: "text-amber-600 dark:text-amber-400",
          },
          {
            label: "On Hold",
            value: counts.onHold,
            color: "text-orange-600 dark:text-orange-400",
          },
          {
            label: "Resolved",
            value: counts.resolved,
            color: "text-green-600 dark:text-green-400",
          },
          {
            label: "Closed",
            value: counts.closed,
            color: "text-muted-foreground",
          },
          {
            label: "Total",
            value: counts.total,
            color: "text-foreground",
          },
        ].map((stat) => (
          <Card key={stat.label} className="border-0 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                {stat.label}
              </p>
              <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
              <Input
                placeholder="Search tickets..."
                value={localSearchValue}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="OPEN">Open</SelectItem>
                <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                <SelectItem value="ON_HOLD">On Hold</SelectItem>
                <SelectItem value="RESOLVED">Resolved</SelectItem>
                <SelectItem value="CLOSED">Closed</SelectItem>
              </SelectContent>
            </Select>
            <Select value={priorityFilter} onValueChange={setPriorityFilter}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Priority</SelectItem>
                <SelectItem value="URGENT">Urgent</SelectItem>
                <SelectItem value="HIGH">High</SelectItem>
                <SelectItem value="MEDIUM">Medium</SelectItem>
                <SelectItem value="LOW">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Tickets Table */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4">
          {isError && !data ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                <span>Failed to load support tickets.</span>
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
            <ResponsiveTable<Ticket>
              columns={columns}
              rows={tickets}
              getRowId={(t) => t.id}
              onRowClick={handleSelectTicket}
              rowActions={renderRowActions}
              empty={emptyState}
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

      {/* Ticket Detail Dialog */}
      <ResponsiveModal
        open={!!selectedTicket}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedTicket(null);
            setReplyText("");
          }
        }}
      >
        <ResponsiveModalContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
          {loadingDetail ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/70" />
            </div>
          ) : isDetailError && !ticketDetail ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                <span>Failed to load ticket details.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetchDetail()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : (
            ticketDetail && (
              <>
                <ResponsiveModalHeader>
                  <ResponsiveModalTitle className="flex items-center gap-2">
                    {getStatusIcon(ticketDetail.status)}
                    {ticketDetail.title}
                  </ResponsiveModalTitle>
                  <ResponsiveModalDescription>
                    {ticketLabel(ticketDetail)} • Created{" "}
                    {formatDate(ticketDetail.createdAt)}
                    {ticketDetail.issueType && (
                      <> • {formatIssueType(ticketDetail.issueType)}</>
                    )}
                  </ResponsiveModalDescription>
                </ResponsiveModalHeader>

                <div className="flex-1 overflow-y-auto max-h-[60vh] space-y-4 pb-4">
                  {/* User Info */}
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
                    <Avatar>
                      <AvatarImage src={ticketDetail.user?.image || ""} />
                      <AvatarFallback>
                        {ticketDetail.user?.name?.charAt(0) || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">
                        {ticketDetail.user?.name || "Unknown"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {ticketDetail.user?.email}
                      </p>
                    </div>
                  </div>

                  {/* Description */}
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                      Description
                    </p>
                    <p className="text-sm text-foreground whitespace-pre-wrap">
                      {ticketDetail.description}
                    </p>
                  </div>

                  {/* Attachments — carried over from the staff fork, which was
                      the only one that rendered them. `types/tickets.ts`
                      already carried the field; this surface just dropped it. */}
                  {ticketDetail.attachments &&
                    ticketDetail.attachments.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                          Attachments
                        </p>
                        <div className="mt-2 space-y-2">
                          {ticketDetail.attachments.map((attachment) => (
                            <a
                              key={attachment.id}
                              href={attachment.fileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-2 p-2 border border-border rounded hover:bg-muted"
                            >
                              <FileText className="h-4 w-4 text-muted-foreground" />
                              <span className="flex-1 text-sm truncate">
                                {attachment.originalName}
                              </span>
                              <span className="text-xs text-muted-foreground/70">
                                {formatFileSize(attachment.fileSize)}
                              </span>
                              <ExternalLink className="h-3 w-3 text-muted-foreground/70" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                  {/* Linked Entities */}
                  {(ticketDetail.linkedConsultation ||
                    ticketDetail.linkedPayment) && (
                    <div className="p-3 rounded-lg border border-border">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
                        Linked Information
                      </p>
                      {ticketDetail.linkedPayment && (
                        <div className="flex items-center gap-2 text-sm">
                          <CreditCard className="h-4 w-4 text-muted-foreground/70" />
                          <span>
                            Payment:{" "}
                            {formatCurrency(
                              ticketDetail.linkedPayment.amount,
                              ticketDetail.linkedPayment.currency,
                            )}
                          </span>
                          <Badge variant="outline">
                            {ticketDetail.linkedPayment.paymentStatus}
                          </Badge>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Status Update */}
                  <div>
                    <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                      Update Status
                    </Label>
                    <Select
                      value={ticketDetail.status}
                      onValueChange={handleUpdateStatus}
                      disabled={updatingStatus}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="OPEN">Open</SelectItem>
                        <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                        <SelectItem value="ON_HOLD">On Hold</SelectItem>
                        <SelectItem value="RESOLVED">Resolved</SelectItem>
                        <SelectItem value="CLOSED">Closed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Separator />

                  {/* Responses */}
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
                      Conversation
                    </p>
                    <div className="space-y-3">
                      {ticketDetail.responses?.map((response) => (
                        <div
                          key={response.id}
                          className={`p-3 rounded-lg ${response.isInternal ? "bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800" : "bg-muted"}`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-medium">
                              {response.user?.name || "Unknown"}
                            </span>
                            {response.isInternal && (
                              <Badge
                                variant="outline"
                                className="text-xs bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800"
                              >
                                Internal
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground/70">
                              {formatDate(response.createdAt)}
                            </span>
                          </div>
                          <p className="text-sm text-foreground">
                            {response.message}
                          </p>
                        </div>
                      ))}
                      {(!ticketDetail.responses ||
                        ticketDetail.responses.length === 0) && (
                        <p className="text-sm text-muted-foreground/70 text-center py-4">
                          No responses yet
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Reply Form */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label>Reply</Label>
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={isInternalNote}
                          onChange={(e) => setIsInternalNote(e.target.checked)}
                          className="rounded"
                        />
                        Internal note
                      </label>
                    </div>
                    <Textarea
                      placeholder={
                        isInternalNote
                          ? "Add internal note..."
                          : "Type your reply..."
                      }
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                    />
                  </div>
                </div>

                <ResponsiveModalFooter className="mt-4">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSelectedTicket(null);
                      setReplyText("");
                    }}
                  >
                    Close
                  </Button>
                  <Button
                    onClick={handleSendReply}
                    disabled={sendingReply || !replyText.trim()}
                  >
                    {sendingReply ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Send className="h-4 w-4 mr-2" />
                    )}
                    {isInternalNote ? "Add Note" : "Send Reply"}
                  </Button>
                </ResponsiveModalFooter>
              </>
            )
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
