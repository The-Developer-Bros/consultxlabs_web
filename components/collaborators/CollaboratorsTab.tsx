"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  UserPlus,
  Trash2,
  Loader2,
  Users,
  Percent,
  ChevronUp,
  AlertTriangle,
} from "lucide-react";
import { ConsultantSearchInput } from "./ConsultantSearchInput";

interface Collaborator {
  id: string;
  role: string;
  // #772 B5 — basis points (3000 = 30%); divide by 100 for display.
  revenueShareBps: number;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "REMOVED";
  consultantProfile: {
    id: string;
    user: {
      name: string | null;
      image: string | null;
    };
  };
}

interface CollaboratorsTabProps {
  planType: "webinar" | "class";
  planId: string;
  isOwner: boolean;
  excludeId?: string;
}

const WEBINAR_ROLES = [
  { value: "CO_HOST", label: "Co-Host" },
  { value: "MODERATOR", label: "Moderator" },
  { value: "GUEST_SPEAKER", label: "Guest Speaker" },
  { value: "TECHNICAL_SUPPORT", label: "Technical Support" },
];

const CLASS_ROLES = [
  { value: "CO_INSTRUCTOR", label: "Co-Instructor" },
  { value: "TEACHING_ASSISTANT", label: "Teaching Assistant" },
  { value: "GUEST_LECTURER", label: "Guest Lecturer" },
  { value: "CONTENT_CREATOR", label: "Content Creator" },
];

const statusConfig: Record<
  string,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
  }
> = {
  PENDING: { label: "Pending", variant: "secondary" },
  ACCEPTED: { label: "Accepted", variant: "default" },
  DECLINED: { label: "Declined", variant: "destructive" },
  REMOVED: { label: "Removed", variant: "outline" },
};

export function CollaboratorsTab({
  planType,
  planId,
  isOwner,
  excludeId,
}: CollaboratorsTabProps) {
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteProfileId, setInviteProfileId] = useState("");
  const [inviteRole, setInviteRole] = useState("");
  const [inviteShare, setInviteShare] = useState(10);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const basePath = `/api/collaborations/${planType}/${planId}`;

  const roles = planType === "webinar" ? WEBINAR_ROLES : CLASS_ROLES;

  const { data: collaborators = [], isLoading } = useQuery<Collaborator[]>({
    queryKey: ["collaborators", planType, planId],
    queryFn: async () => {
      const res = await fetch(basePath);
      if (!res.ok) throw new Error("Failed to fetch collaborators");
      const json = await res.json();
      return json.data;
    },
    staleTime: 30_000,
  });

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(basePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consultantProfileId: inviteProfileId,
          role: inviteRole,
          revenueSharePercentage: inviteShare,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to invite collaborator");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["collaborators", planType, planId],
      });
      setIsInviteOpen(false);
      setInviteProfileId("");
      setInviteRole("");
      setInviteShare(10);
      toast({ title: "Collaborator invited successfully" });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to invite",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (collaboratorId: string) => {
      const res = await fetch(`${basePath}/${collaboratorId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove collaborator");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["collaborators", planType, planId],
      });
      toast({ title: "Collaborator removed" });
    },
    onError: () => {
      toast({
        title: "Failed to remove collaborator",
        variant: "destructive",
      });
    },
  });

  const totalShare =
    collaborators
      .filter((c) => c.status === "PENDING" || c.status === "ACCEPTED")
      .reduce((sum, c) => sum + c.revenueShareBps, 0) / 100;

  const ownerShare = 100 - totalShare;

  const pendingCollabs = collaborators.filter((c) => c.status === "PENDING");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Revenue split overview */}
      <div className="flex items-center gap-4 p-3 bg-zinc-50 rounded-lg border border-zinc-200">
        <Percent className="w-4 h-4 text-zinc-500" />
        <div className="text-sm">
          <span className="font-medium text-zinc-800">Revenue Split:</span>{" "}
          <span className="text-zinc-600">
            Host {ownerShare}% | Collaborators {totalShare}%
          </span>
        </div>
      </div>

      {/* Pending collaborator warning */}
      {pendingCollabs.length > 0 && (
        <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-800">
            {pendingCollabs.length} collaborator
            {pendingCollabs.length > 1 ? "s" : ""} haven&apos;t accepted yet.
            Purchases made before they accept won&apos;t include their revenue
            split.
          </p>
        </div>
      )}

      {/* Collaborator list */}
      {collaborators.length === 0 ? (
        <div className="text-center py-6 text-zinc-500">
          <Users className="w-8 h-8 mx-auto mb-2 text-zinc-300" />
          <p className="text-sm">No collaborators yet</p>
          {isOwner && (
            <p className="text-xs mt-1">
              Invite other consultants to collaborate on this plan
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {collaborators.map((collab) => {
            const config = statusConfig[collab.status] ?? statusConfig.PENDING;
            const roleLabel =
              roles.find((r) => r.value === collab.role)?.label ?? collab.role;

            return (
              <div
                key={collab.id}
                className="flex items-center justify-between p-3 bg-white border border-zinc-200 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <Avatar className="w-8 h-8">
                    <AvatarImage
                      src={collab.consultantProfile.user.image ?? undefined}
                    />
                    <AvatarFallback>
                      {(collab.consultantProfile.user.name ?? "?").charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-medium text-zinc-800">
                      {collab.consultantProfile.user.name ?? "Unknown"}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {roleLabel} &middot; {collab.revenueShareBps / 100}%
                      share
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={config.variant}>{config.label}</Badge>
                  {isOwner && collab.status !== "REMOVED" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-zinc-400 hover:text-red-500"
                      onClick={() => removeMutation.mutate(collab.id)}
                      disabled={removeMutation.isPending}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Inline invite form — expands in place, no dialog */}
      {isOwner && !isInviteOpen && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => setIsInviteOpen(true)}
        >
          <UserPlus className="w-4 h-4 mr-2" />
          Invite Collaborator
        </Button>
      )}

      {isOwner && isInviteOpen && (
        <div className="border border-zinc-200 rounded-lg p-4 space-y-3 bg-zinc-50/50">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-700">
              Invite Collaborator
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-zinc-400"
              onClick={() => {
                setIsInviteOpen(false);
                setInviteProfileId("");
                setInviteRole("");
                setInviteShare(10);
              }}
            >
              <ChevronUp className="w-4 h-4" />
            </Button>
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-600">
              Search Consultant
            </label>
            <div className="mt-1">
              <ConsultantSearchInput
                excludeId={excludeId}
                onSelect={(id) => setInviteProfileId(id)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-zinc-600">Role</label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger className="mt-1 h-9">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role.value} value={role.value}>
                      {role.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-medium text-zinc-600">
                Revenue Share (%)
              </label>
              <Input
                type="number"
                min={1}
                max={90 - totalShare}
                value={inviteShare}
                onChange={(e) => setInviteShare(Number(e.target.value))}
                className="mt-1 h-9"
              />
              <p className="text-[10px] text-zinc-400 mt-0.5">
                Max {90 - totalShare}% available
              </p>
            </div>
          </div>

          <Button
            type="button"
            className="w-full"
            onClick={() => inviteMutation.mutate()}
            disabled={
              !inviteProfileId ||
              !inviteRole ||
              inviteShare < 1 ||
              inviteMutation.isPending
            }
          >
            {inviteMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <UserPlus className="w-4 h-4 mr-2" />
            )}
            Send Invitation
          </Button>
        </div>
      )}
    </div>
  );
}
