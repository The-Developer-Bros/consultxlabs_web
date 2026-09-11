"use client";

/**
 * Backoffice newsletter subscriber management.
 *
 * Lists everyone on the waitlist (the marketing email list — nothing to do
 * with event capacity), and gives the one surface that can send a broadcast.
 * Gated by the `waitlist.manage` backoffice surface.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WaitlistSource, WaitlistStatus } from "@prisma/client";
import { format } from "date-fns";
import { Download, Mail, Search, Send, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { waitlistStatusBadge } from "@/lib/labels/session-labels";
import { useToast } from "@/components/ui/use-toast";

const ALL = "all";
const PER_PAGE = 50;

type Subscriber = {
  id: string;
  email: string;
  name: string | null;
  status: WaitlistStatus;
  source: WaitlistSource;
  tags: string[];
  confirmedAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
};

type SubscribersResponse = {
  items: Subscriber[];
  total: number;
  page: number;
  perPage: number;
  stats: Record<WaitlistStatus, number>;
};

type Filters = {
  status: string;
  source: string;
  search: string;
  page: number;
};

function toQuery(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.status !== ALL) params.set("status", filters.status);
  if (filters.source !== ALL) params.set("source", filters.source);
  if (filters.search) params.set("search", filters.search);
  params.set("page", String(filters.page));
  params.set("perPage", String(PER_PAGE));
  return params;
}

async function fetchSubscribers(
  filters: Filters,
): Promise<SubscribersResponse> {
  const response = await fetch(`/api/admin/waitlist?${toQuery(filters)}`);
  if (!response.ok) throw new Error("Failed to load subscribers");
  return response.json();
}

/** Human label for an enum member: EVENT_SOLD_OUT → Event sold out. */
function humanize(value: string): string {
  const lower = value.toLowerCase().replaceAll("_", " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const COLUMNS: ResponsiveColumn<Subscriber>[] = [
  {
    key: "email",
    header: "Email",
    primary: true,
    cell: (row) => (
      <div>
        <p className="font-medium">{row.email}</p>
        {row.name && (
          <p className="text-xs text-muted-foreground">{row.name}</p>
        )}
      </div>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (row) => (
      <StatusBadge {...waitlistStatusBadge(row.status)} withDot size="sm" />
    ),
  },
  {
    key: "source",
    header: "Source",
    cell: (row) => (
      <span className="text-sm text-muted-foreground">
        {humanize(row.source)}
      </span>
    ),
  },
  {
    key: "tags",
    header: "Tags",
    cell: (row) =>
      row.tags.length > 0 ? (
        <span className="text-sm text-muted-foreground">
          {row.tags.join(", ")}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
  },
  {
    key: "joined",
    header: "Signed up",
    cell: (row) => format(new Date(row.createdAt), "MMM d, yyyy"),
  },
  {
    key: "confirmed",
    header: "Confirmed",
    cell: (row) =>
      row.confirmedAt ? format(new Date(row.confirmedAt), "MMM d, yyyy") : "—",
  },
];

export function WaitlistManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<Filters>({
    status: ALL,
    source: ALL,
    search: "",
    page: 1,
  });
  // Applied separately from the input so typing doesn't refetch per keystroke.
  const [searchDraft, setSearchDraft] = useState("");

  const [subject, setSubject] = useState("");
  const [htmlBody, setHtmlBody] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-waitlist", filters],
    queryFn: () => fetchSubscribers(filters),
  });

  const broadcast = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/waitlist/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, htmlBody }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to send");
      }
      return payload as { sent: number; failed: number; total: number };
    },
    onSuccess: (result) => {
      toast({
        title: "Newsletter sent",
        description: `${result.sent} delivered, ${result.failed} failed, ${result.total} on the list.`,
      });
      setSubject("");
      setHtmlBody("");
      queryClient.invalidateQueries({ queryKey: ["admin-waitlist"] });
    },
    onError: (sendError: Error) => {
      toast({
        title: "Could not send",
        description: sendError.message,
        variant: "destructive",
      });
    },
  });

  const stats = data?.stats;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const statCards: Array<{ label: string; value: number }> = stats
    ? [
        { label: "Subscribed", value: stats.SUBSCRIBED },
        { label: "Awaiting confirmation", value: stats.PENDING },
        { label: "Unsubscribed", value: stats.UNSUBSCRIBED },
        { label: "Bounced", value: stats.BOUNCED },
      ]
    : [];

  function renderSubscriberTable() {
    if (error) {
      return (
        <p className="py-8 text-center text-muted-foreground">
          Could not load subscribers.
        </p>
      );
    }
    if (isLoading) {
      return <Skeleton className="h-64 rounded-lg" />;
    }
    return (
      <ResponsiveTable<Subscriber>
        columns={COLUMNS}
        rows={items}
        getRowId={(row) => row.id}
        empty={
          <div className="py-8 text-center text-muted-foreground">
            No subscribers match these filters.
          </div>
        }
      />
    );
  }

  return (
    <>
      <DashboardHeader
        title="Waitlist"
        subtitle="Everyone signed up for the Familiarise newsletter"
        actions={
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/admin/waitlist?${toQuery(filters)}&format=csv`}>
              <Download className="mr-2 h-4 w-4" /> Export CSV
            </a>
          </Button>
        }
      />

      <div className="p-4 sm:p-6 lg:p-8 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading
            ? Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-24 rounded-lg" />
              ))
            : statCards.map((card) => (
                <Card key={card.label}>
                  <CardContent className="pt-6">
                    <p className="text-sm text-muted-foreground">
                      {card.label}
                    </p>
                    <p className="text-2xl font-semibold mt-1">{card.value}</p>
                  </CardContent>
                </Card>
              ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" /> Subscribers
              {total > 0 && (
                <span className="text-sm font-normal text-muted-foreground">
                  ({total})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <form
                className="flex-1 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setFilters((prev) => ({
                    ...prev,
                    search: searchDraft,
                    page: 1,
                  }));
                }}
              >
                <Input
                  placeholder="Search by email or name"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                />
                <Button type="submit" variant="outline" size="icon">
                  <Search className="h-4 w-4" />
                </Button>
              </form>

              <Select
                value={filters.status}
                onValueChange={(value) =>
                  setFilters((prev) => ({ ...prev, status: value, page: 1 }))
                }
              >
                <SelectTrigger className="sm:w-48">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  {Object.values(WaitlistStatus).map((status) => (
                    <SelectItem key={status} value={status}>
                      {humanize(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={filters.source}
                onValueChange={(value) =>
                  setFilters((prev) => ({ ...prev, source: value, page: 1 }))
                }
              >
                <SelectTrigger className="sm:w-48">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All sources</SelectItem>
                  {Object.values(WaitlistSource).map((source) => (
                    <SelectItem key={source} value={source}>
                      {humanize(source)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {renderSubscriberTable()}

            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Page {filters.page} of {totalPages}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={filters.page <= 1}
                    onClick={() =>
                      setFilters((prev) => ({ ...prev, page: prev.page - 1 }))
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={filters.page >= totalPages}
                    onClick={() =>
                      setFilters((prev) => ({ ...prev, page: prev.page + 1 }))
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="h-4 w-4" /> Send a newsletter
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Goes to every confirmed subscriber
              {stats ? ` (${stats.SUBSCRIBED} right now)` : ""}. An unsubscribe
              footer is appended automatically.
            </p>

            <div className="space-y-2">
              <Label htmlFor="newsletter-subject">Subject</Label>
              <Input
                id="newsletter-subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="What is new at Familiarise"
                maxLength={200}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="newsletter-body">Body (HTML)</Label>
              <Textarea
                id="newsletter-body"
                value={htmlBody}
                onChange={(event) => setHtmlBody(event.target.value)}
                placeholder="<p>Hello…</p>"
                rows={10}
                className="font-mono text-sm"
              />
            </div>

            <Button
              onClick={() => broadcast.mutate()}
              disabled={
                broadcast.isPending ||
                !subject.trim() ||
                !htmlBody.trim() ||
                (stats?.SUBSCRIBED ?? 0) === 0
              }
            >
              <Send className="mr-2 h-4 w-4" />
              {broadcast.isPending ? "Sending…" : "Send to subscribers"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
