"use client";

import { useQuery } from "@tanstack/react-query";
import { useRequireOrgAccess } from "../useOrgRole";

import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";

interface Learner {
  id: string;
  status: string;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

async function fetchLearners(
  orgId: string,
): Promise<{ learners: Learner[]; total: number }> {
  const res = await fetch(
    `/api/organizations/${orgId}/members?role=LEARNER&perPage=100`,
  );
  if (!res.ok) throw new Error("Failed to load learners");
  const json = await res.json();
  return { learners: json.data ?? [], total: json.meta?.total ?? 0 };
}

export function LearnersPanel({ orgId }: { orgId: string }) {
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "learners.read",
    canSponsor: true,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["org-learners", orgId],
    queryFn: () => fetchLearners(orgId),
    enabled: allowed,
  });

  if (!allowed) return null;

  const columns: ResponsiveColumn<Learner>[] = [
    {
      key: "learner",
      header: "Learner",
      primary: true,
      cell: (l) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">
            {l.user.name ?? "—"}
          </span>
          <span className="text-xs text-muted-foreground">{l.user.email}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (l) => (
        <Badge variant={l.status === "ACTIVE" ? "default" : "outline"}>
          {l.status}
        </Badge>
      ),
    },
    {
      key: "since",
      header: "Member since",
      cell: (l) => (
        <span className="text-xs text-muted-foreground">
          {new Date(l.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <>
      <PanelHeader description="Members consuming sessions on behalf of the organization" />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isLoading ? "Loading…" : `${data?.total ?? 0} learners`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <ResponsiveTable<Learner>
                columns={columns}
                rows={data?.learners ?? []}
                getRowId={(l) => l.id}
                empty={
                  <p className="text-center text-sm text-muted-foreground py-6">
                    No learners yet. Invite some via the Invitations page.
                  </p>
                }
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
