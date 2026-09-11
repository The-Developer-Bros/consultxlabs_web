"use client";

import { useRouter } from "next/navigation";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Plus } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/DataCard";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { CatalogPanel } from "./CatalogPanel";
import type { CatalogRow, CatalogResponse, Kind } from "./types";

interface Expert {
  consultantProfileId: string;
  name: string;
}

export function CatalogClient({
  orgId,
  experts,
}: Readonly<{ orgId: string; experts: Expert[] }>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [expertId, setExpertId] = useState<string>(
    experts.length === 1 ? experts[0].consultantProfileId : "",
  );

  const queryKey = useMemo(() => ["org-catalog", orgId], [orgId]);

  const { data, isLoading, error } = useQuery<CatalogResponse>({
    queryKey,
    queryFn: async () => {
      // One fetch drives both views; the client partitions on archivedAt so
      // restoring does not need a second round trip.
      const res = await fetch(
        `/api/organizations/${orgId}/catalog?includeArchived=true`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to load the catalog");
      }
      return res.json();
    },
  });


  const setArchived = useMutation({
    mutationFn: async ({
      kind,
      planId,
      restore,
    }: {
      kind: Kind;
      planId: string;
      restore: boolean;
    }) => {
      const res = await fetch(
        `/api/organizations/${orgId}/catalog${restore ? "?restore=true" : ""}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, planIds: [planId] }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? "Could not update");
      }
      return res.json();
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey });
      toast({
        title: vars.restore ? "Back on sale" : "Withdrawn from the catalog",
        description: vars.restore
          ? undefined
          : "Existing bookings and their records are unaffected.",
      });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not update",
        description: e.message,
        variant: "destructive",
      }),
  });

  // Stable per-kind callbacks so CatalogPanel's memoized columns are not
  // invalidated on every parent render — which would undo the point of the
  // split. `setArchived.mutate` is referentially stable across renders.
  const archiveWebinar = useCallback(
    (planId: string, restore: boolean) =>
      setArchived.mutate({ kind: "WEBINAR", planId, restore }),
    [setArchived],
  );
  const archiveClass = useCallback(
    (planId: string, restore: boolean) =>
      setArchived.mutate({ kind: "CLASS", planId, restore }),
    [setArchived],
  );



  // The fetch asks for everything; the split happens here so restoring a plan
  // does not need a second round trip.
  const live = (rows: CatalogRow[] | undefined) =>
    (rows ?? []).filter((r) => r.archivedAt === null);
  const archivedWebinars = (data?.webinars ?? []).filter(
    (r) => r.archivedAt !== null,
  );
  const archivedClasses = (data?.classes ?? []).filter(
    (r) => r.archivedAt !== null,
  );

  // No experts, nothing to publish — an org plan needs somebody to deliver it,
  // so say that plainly rather than opening a form that will 422.
  const blocked = experts.length === 0;

  return (
    <>
      <DashboardHeader
        title="Catalog"
        subtitle="Webinars and classes this organization owns and sells."
      />
      <DashboardContent>
        {blocked ? (
          <EmptyState
            icon={Library}
            title="Invite an expert first"
            description="Catalog offerings are delivered by an organization expert. Invite one from Members, then come back to publish."
          />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <div className="min-w-56">
                <label
                  htmlFor="catalog-expert"
                  className="mb-1 block text-sm font-medium"
                >
                  Delivered by
                </label>
                <Select value={expertId} onValueChange={setExpertId}>
                  <SelectTrigger id="catalog-expert">
                    <SelectValue placeholder="Choose an expert" />
                  </SelectTrigger>
                  <SelectContent>
                    {experts.map((e) => (
                      <SelectItem
                        key={e.consultantProfileId}
                        value={e.consultantProfileId}
                      >
                        {e.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/organization/${orgId}/catalog/webinar/new?expertId=${expertId}`,
                  )
                }
                disabled={!expertId}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                New webinar
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  router.push(
                    `/dashboard/organization/${orgId}/catalog/class/new?expertId=${expertId}`,
                  )
                }
                disabled={!expertId}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                New class
              </Button>
            </div>

            <UrlTabs
              tabs={[
                {
                  value: "webinars",
                  label: "Webinars",
                  content: (
                    <CatalogPanel
                      kind="WEBINAR"
                      rows={live(data?.webinars)}
                      isLoading={isLoading}
                      error={error}
                      onToggleArchive={archiveWebinar}
                      isMutating={setArchived.isPending}
                    />
                  ),
                },
                {
                  value: "classes",
                  label: "Classes",
                  content: (
                    <CatalogPanel
                      kind="CLASS"
                      rows={live(data?.classes)}
                      isLoading={isLoading}
                      error={error}
                      onToggleArchive={archiveClass}
                      isMutating={setArchived.isPending}
                    />
                  ),
                },
                // Withdrawn plans keep their own view rather than a filter
                // toggle: it answers a different question ("what did we stop
                // selling") and keeps the two live tabs uncluttered. Hidden
                // entirely until something has been withdrawn.
                ...(archivedWebinars.length > 0
                  ? [
                      {
                        value: "archived-webinars",
                        label: `Archived webinars (${archivedWebinars.length})`,
                        content: (
                          <CatalogPanel
                            kind="WEBINAR"
                            rows={archivedWebinars}
                            isLoading={isLoading}
                            error={error}
                            onToggleArchive={archiveWebinar}
                            isMutating={setArchived.isPending}
                          />
                        ),
                      },
                    ]
                  : []),
                ...(archivedClasses.length > 0
                  ? [
                      {
                        value: "archived-classes",
                        label: `Archived classes (${archivedClasses.length})`,
                        content: (
                          <CatalogPanel
                            kind="CLASS"
                            rows={archivedClasses}
                            isLoading={isLoading}
                            error={error}
                            onToggleArchive={archiveClass}
                            isMutating={setArchived.isPending}
                          />
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </>
        )}
      </DashboardContent>

    </>
  );
}
