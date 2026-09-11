import * as Sentry from "@sentry/nextjs";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { AppointmentsType, AppointmentStatus } from "@prisma/client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface RequestUser {
  user: { name: string };
}

interface ConsultationRequestItem {
  id: string;
  consultationPlan?: { title?: string };
  requestedBy: RequestUser;
  requestedAt: string;
  status: string;
}

interface SubscriptionRequestItem {
  id: string;
  subscriptionPlan?: { title?: string };
  requestedBy: RequestUser;
  requestedAt: string;
  status: string;
}

interface Request {
  id: string;
  type: AppointmentsType;
  title: string;
  requestedBy: RequestUser;
  requestedAt: string;
  status: AppointmentStatus;
}

export function RequestSlotAllocationTabMini() {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        // #1345 — orgScope is explicit rather than implied. An absent param
        // only defaults to personal for non-privileged callers, so an
        // ADMIN/STAFF consultant used to get an unfiltered list here while the
        // Home badge and NeedsYou beside it stayed personal.
        const [consultationsRes, subscriptionsRes] = await Promise.all([
          fetch(
            `/api/bookings/consultations?consultantProfileId=${consultantId}&status=PENDING&orgScope=personal`,
          ),
          fetch(
            `/api/bookings/subscriptions?consultantProfileId=${consultantId}&status=PENDING&orgScope=personal`,
          ),
        ]);

        const requests = [];
        if (consultationsRes.ok) {
          const data = await consultationsRes.json();
          requests.push(
            ...data.data.map((c: ConsultationRequestItem) => ({
              id: c.id,
              type: AppointmentsType.CONSULTATION,
              title: c.consultationPlan?.title || "Untitled Plan",
              requestedBy: { user: { name: c.requestedBy.user.name } },
              requestedAt: c.requestedAt,
              status: c.status,
            })),
          );
        }

        if (subscriptionsRes.ok) {
          const data = await subscriptionsRes.json();
          requests.push(
            ...data.data.map((s: SubscriptionRequestItem) => ({
              id: s.id,
              type: AppointmentsType.SUBSCRIPTION,
              title: s.subscriptionPlan?.title || "Untitled Plan",
              requestedBy: { user: { name: s.requestedBy.user.name } },
              requestedAt: s.requestedAt,
              status: s.status,
            })),
          );
        }

        setRequests(requests);
      } catch (err) {
        Sentry.captureException(
          err instanceof Error ? err : new Error(String(err)),
          { tags: { subsystem: "client" } },
        );
        setError(
          err instanceof Error ? err.message : "Failed to load requests",
        );
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [consultantId]);

  if (loading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading requests...
      </div>
    );
  }

  if (error) {
    return <div className="p-4 text-destructive">{error}</div>;
  }

  if (requests.length === 0) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        No pending requests
      </div>
    );
  }

  const columns: ResponsiveColumn<Request>[] = [
    {
      key: "type",
      header: "Type",
      headClassName: "w-[100px]",
      className: "font-medium",
      cell: (request) => request.type,
    },
    {
      key: "title",
      header: "Title",
      primary: true,
      headClassName: "max-w-[200px]",
      className: "truncate",
      cell: (request) => request.title,
    },
    {
      key: "requestedBy",
      header: "Requested By",
      cell: (request) => request.requestedBy.user.name,
    },
    {
      key: "requestedAt",
      header: "Requested At",
      headClassName: "w-[140px]",
      cell: (request) => new Date(request.requestedAt).toLocaleDateString(),
    },
  ];

  return (
    <ResponsiveTable<Request>
      columns={columns}
      rows={requests}
      getRowId={(r) => r.id}
    />
  );
}
