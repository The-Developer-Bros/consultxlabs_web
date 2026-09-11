"use client";

/**
 * Collaborations panel — both perspectives of plan collaboration:
 *   - Host: my plans that have collaborators on them
 *   - Collaborator: invitations I've received (pending + accepted)
 *
 * Decomposed during the dashboard redesign: data fetching + the respond
 * mutation + section layout live here; the cards are in
 * PendingInvitationCard / ActiveCollaborationCard / HostedPlanCard, with
 * the schedule cluster in ScheduleSummaries and shapes in types.ts.
 * There are deliberately NO confirm dialogs — Accept/Decline fire the
 * mutation directly, as before.
 *
 * #org-appts / #1025 — the Host section is scoped by the PLAN's org-ness.
 * `orgScope` unset (personal dashboard) shows only B2C hosted plans;
 * passing an orgId (org dashboard) shows only that org's hosted plans.
 * Received invitations are unaffected either way. The scope is threaded
 * into the query key so the two views don't collide in the react-query
 * cache.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Inbox, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/dashboard/DataCard";
import type {
  CollaborationsData,
  CollaborationWithPlan,
  HostedPlanEntry,
} from "./types";
import { PendingInvitationCard } from "./PendingInvitationCard";
import { ActiveCollaborationCard } from "./ActiveCollaborationCard";
import { HostedPlanCard } from "./HostedPlanCard";

export function InvitationsPanel({ orgScope }: { orgScope?: string } = {}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery<CollaborationsData>({
    queryKey: ["my-collaborations", orgScope ?? "mine"],
    queryFn: async () => {
      const url = orgScope
        ? `/api/collaborations?orgScope=${encodeURIComponent(orgScope)}`
        : "/api/collaborations";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch collaborations");
      const json = await res.json();
      return json.data;
    },
    staleTime: 30_000,
  });

  const respondMutation = useMutation({
    mutationFn: async ({
      id,
      planType,
      response,
    }: {
      id: string;
      planType: "webinar" | "class";
      response: "ACCEPTED" | "DECLINED";
    }) => {
      const res = await fetch(`/api/collaborations/${id}/respond`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, planType }),
      });
      if (!res.ok) throw new Error("Failed to respond");
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["my-collaborations"] });
      toast({
        title:
          variables.response === "ACCEPTED"
            ? "Invitation accepted"
            : "Invitation declined",
      });
    },
    onError: () => {
      toast({
        title: "Failed to respond to invitation",
        variant: "destructive",
      });
    },
  });

  // ── Collaborator perspective data ──
  const allCollaborations: CollaborationWithPlan[] = [
    ...(data?.webinarCollaborations.map((c) => ({
      ...c,
      planType: "webinar" as const,
      planTitle: c.webinarPlan?.title ?? "Webinar",
      planPrice: c.webinarPlan?.price ?? 0,
    })) ?? []),
    ...(data?.classCollaborations.map((c) => ({
      ...c,
      planType: "class" as const,
      planTitle: c.classPlan?.title ?? "Class",
      planPrice: c.classPlan?.price ?? 0,
    })) ?? []),
  ];

  const pending = allCollaborations.filter((c) => c.status === "PENDING");
  const accepted = allCollaborations.filter((c) => c.status === "ACCEPTED");

  // ── Host perspective data ──
  const hostedPlans: HostedPlanEntry[] = [
    ...(data?.hostedWebinarPlans?.map((p) => ({
      planType: "webinar" as const,
      title: p.title,
      price: p.price,
      collaborators: p.collaborators,
      webinarPlan: p,
    })) ?? []),
    ...(data?.hostedClassPlans?.map((p) => ({
      planType: "class" as const,
      title: p.title,
      price: p.price,
      collaborators: p.collaborators,
      classPlan: p,
    })) ?? []),
  ];

  const hasAnyData = allCollaborations.length > 0 || hostedPlans.length > 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load collaborations"
        description="Something went wrong while fetching your collaborations. Please try again."
        action={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  if (!hasAnyData) {
    return (
      <EmptyState
        icon={Inbox}
        title="No collaborations"
        description="When you invite collaborators to your plans or another consultant invites you, it will appear here."
      />
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-8">
        {/* ── Host section: My Plans with Collaborators ── */}
        {hostedPlans.length > 0 && (
          <div>
            <h2 className="mb-4 text-sm font-semibold tracking-tight text-zinc-900">
              My Plans with Collaborators{" "}
              <span className="font-normal text-zinc-400">
                ({hostedPlans.length})
              </span>
            </h2>
            <div className="space-y-3">
              {hostedPlans.map((plan) => (
                <HostedPlanCard
                  key={`${plan.planType}-${plan.webinarPlan?.id ?? plan.classPlan?.id}`}
                  plan={plan}
                  hostUser={data?.hostUser}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Collaborator section: Pending Invitations ── */}
        <div>
          <h2 className="mb-4 text-sm font-semibold tracking-tight text-zinc-900">
            Pending Invitations{" "}
            <span className="font-normal text-zinc-400">
              ({pending.length})
            </span>
          </h2>
          {pending.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-200 py-10 text-center text-zinc-500">
              <Inbox className="mx-auto mb-2 h-8 w-8 text-zinc-300" />
              <p className="text-sm font-medium">No pending invitations</p>
              <p className="mx-auto mt-1 max-w-xs text-xs">
                When another consultant invites you to co-host a webinar or
                class, the invitation will appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map((collab) => (
                <PendingInvitationCard
                  key={collab.id}
                  collab={collab}
                  onRespond={(args) => respondMutation.mutate(args)}
                  isResponding={respondMutation.isPending}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Collaborator section: Active Collaborations ── */}
        {accepted.length > 0 && (
          <div>
            <h2 className="mb-4 text-sm font-semibold tracking-tight text-zinc-900">
              Active Collaborations{" "}
              <span className="font-normal text-zinc-400">
                ({accepted.length})
              </span>
            </h2>
            <div className="space-y-3">
              {accepted.map((collab) => (
                <ActiveCollaborationCard
                  key={collab.id}
                  collab={collab}
                  currentUser={data?.hostUser}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
