"use client";

import Image from "next/image";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
} from "@/components/ui/responsive-modal";
import { ResponsiveTable } from "@/components/ui/responsive-table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import {
  AlertTriangleIcon,
  BanIcon,
  BellIcon,
  BellOffIcon,
  InfoIcon,
  Loader2Icon,
  Trash2Icon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { Channel } from "stream-chat";
import { useChatContext } from "stream-chat-react";
import { getChannelDisplayInfo, viewerOwnsChannel } from "./utils/channelUtils";
import { AddMembersDialog } from "./AddMembersDialog";
import { isEventChannel } from "@/lib/stream-channel-ids";
import { addMemberToChannel } from "@/actions/stream/chat/member.action";
import { useSession } from "@/lib/auth-client";
import { useServerSessionFacts } from "@/components/dashboard/ServerUserId";

interface ChannelMember {
  id: string;
  name?: string;
  image?: string;
  online?: boolean;
  [key: string]: unknown;
}

interface ChannelInfoAndManageDialogProps {
  channel: Channel;
}

export const ChannelInfoAndManageDialog = ({
  channel,
}: ChannelInfoAndManageDialogProps) => {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLeavingChannel, setIsLeavingChannel] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const { client, setActiveChannel } = useChatContext();
  const { toast } = useToast();
  const [members, setMembers] = useState<ChannelMember[]>([]);

  const isTeamChannel = channel.type === "team";
  const isDirectMessage = channel.type === "messaging";
  const isEvent = isEventChannel(channel.id);
  const memberCount = Object.keys(channel.state.members || {}).length;

  // Get display info using shared utility
  const displayInfo = isDirectMessage
    ? getChannelDisplayInfo(channel, client?.userID)
    : {
        displayName: channel.data?.name || channel.id || "",
        isGroupDM: false,
        memberCount,
        statusText: `${memberCount} ${memberCount === 1 ? "member" : "members"}`,
        fullGroupName: undefined,
      };

  const displayName = displayInfo.displayName;

  // The APP role, never `client.user.role` — same source and same reason as
  // ChatSidebar, which carries the warning comment about this trap.
  const { data: session } = useSession();
  const serverFacts = useServerSessionFacts();
  const appRole = session?.user?.role ?? serverFacts.role;

  // Check if current user is the event owner consultant.
  //
  // The `client.user.role === "CONSULTANT"` conjunct that used to be here could
  // never be true: `client.user.role` is the STREAM role, and `mapRoleToStream`
  // collapses every non-staff account — consultants included — to `"user"`.
  // So the whole predicate was constantly false and the host's remove-member
  // control never rendered. ChatSidebar carries a comment warning about exactly
  // this trap.
  //
  // Dropping the conjunct rather than swapping in the app role: for an event
  // channel, `created_by_id` IS the host consultant (channel.action.ts sets it
  // from the plan's consultantProfile), so the ownership test already implies
  // the role. Adding a second source of truth would only create a way for the
  // two to disagree.
  // Queried channels expose the creator as `created_by` (object);
  // `created_by_id` survives only on channels created in THIS session. Read
  // both, prefer the reliable one.
  const creatorId = channel.data?.created_by?.id ?? channel.data?.created_by_id;

  const isEventOwner = isEvent && viewerOwnsChannel(creatorId, client?.userID);

  // Get the other user's ID for 1-on-1 DMs (for block/report)
  const otherUserId =
    isDirectMessage && !displayInfo.isGroupDM
      ? Object.keys(channel.state.members || {}).find(
          (id) => id !== client?.userID,
        )
      : null;

  // Check if channel is muted
  const isMuted = channel.muteStatus()?.muted ?? false;

  // Load members when dialog opens
  const handleOpenChange = (open: boolean) => {
    setOpen(open);
    if (open) {
      loadMembers();
    }
  };

  const loadMembers = async () => {
    setIsLoading(true);
    try {
      const loadedMembers = Object.values(channel.state.members || {})
        .map((member) => member.user)
        .filter((user): user is ChannelMember => user !== null);
      setMembers(loadedMembers);
    } catch (error) {
      console.error("Error loading members:", error);
      toast({
        title: "Error",
        description: "Failed to load channel members",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddMember = () => {
    setShowAddMembers(true);
  };

  const handleMembersAdded = async (userIds: string[]) => {
    if (!channel.id) return;

    try {
      // Through the server action, not `channel.addMembers()` directly.
      //
      // `addMemberToChannel` is the only server-side authorization on channel
      // membership — session required, and only staff, admins, or the channel's
      // creator may add anyone. It had zero callers: this component called
      // Stream from the browser and the action sat unused, so the gate existed
      // in the codebase without ever being in the path. Membership is what
      // Stream's own permissions key off, which makes an unchecked add the
      // widest hole in the chat surface.
      // allSettled, not a sequential loop: one rejection used to abandon every
      // remaining id AND skip the toast, so adding five people and failing on
      // the second silently added one. Same reasoning as the block route.
      const results = await Promise.allSettled(
        userIds.map((userId) =>
          addMemberToChannel(
            channel.id as string,
            userId,
            // `Channel["type"]` is a bare `string` in stream-chat; the action
            // takes the narrowed union. Every channel this dialog can open is
            // one of the two.
            channel.type as "messaging" | "team",
          ),
        ),
      );

      const added = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - added;

      if (added === 0) {
        throw new Error("Could not add anyone to this channel");
      }

      toast({
        title: failed > 0 ? "Partially added" : "Success",
        description:
          failed > 0
            ? `Added ${added} of ${results.length}. Please retry the rest.`
            : `${added} member${added !== 1 ? "s" : ""} added successfully`,
        variant: failed > 0 ? "destructive" : undefined,
      });
      // Refresh the member list
      loadMembers();
    } catch (error) {
      console.error("Error adding members:", error);
      throw error; // Re-throw so the dialog can show error state
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!client?.userID || !isEventOwner) return;

    setIsLoading(true);
    try {
      await channel.removeMembers([memberId]);
      toast({
        title: "Success",
        description: "Member removed successfully",
      });
      // Refresh the member list
      loadMembers();
    } catch (error) {
      console.error("Error removing member:", error);
      toast({
        title: "Error",
        description: "Failed to remove member",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLeaveChannel = async () => {
    if (!client?.userID) return;

    setIsLoading(true);
    setIsLeavingChannel(true);
    try {
      // Remove the user from the channel members
      await channel.removeMembers([client.userID]);

      // Set active channel to undefined to show empty state
      setActiveChannel(undefined);

      toast({
        title: "Success",
        description: "You have left the channel",
        variant: "default",
      });

      // Close the dialog
      setOpen(false);
    } catch (error) {
      console.error("Error leaving channel:", error);
      toast({
        title: "Error",
        description: "Failed to leave the channel",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
      setIsLeavingChannel(false);
    }
  };

  // Clear all messages from the channel
  const handleClearChat = async () => {
    setIsLoading(true);
    try {
      await channel.truncate();
      toast({
        title: "Chat cleared",
        description: "All messages have been removed",
      });
      setShowClearConfirm(false);
    } catch (error) {
      console.error("Error clearing chat:", error);
      toast({
        title: "Error",
        description: "Failed to clear chat",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Permission check for clear chat (truncate)
  const canTruncateChannel = (() => {
    // In 1-on-1 DMs, both users can clear their view
    if (isDirectMessage && !displayInfo.isGroupDM) return true;
    // In group DMs and channels, only the creator or a platform operator.
    //
    // #1280 — the SECOND instance of the dead-role bug in this file, missed
    // when `isEventOwner` was fixed a few lines above. `client.user.role` is the
    // STREAM role, and `mapRoleToStream` (lib/user.ts:82) collapses every
    // non-staff account to `"user"`, so `userRole === "CONSULTANT"` was false by
    // construction and `isPrivileged` was permanently false. #1144 asked for a
    // grep of this pattern; this is what it found.
    //
    // CONSULTANT is deliberately NOT in the privileged set, and that is the
    // correction to the first pass at this fix. `handleClearChat` calls
    // `channel.truncate()` from the CLIENT, so Stream's permission system
    // decides, not ours:
    //
    //   ADMIN / STAFF   → mapRoleToStream gives them Stream `admin`   → allowed
    //   creator         → channel-scoped `channel_moderator` at create → allowed
    //   other consultant→ plain Stream `user`, no moderator grant      → REFUSED
    //
    // Granting the app role alone would have shown the button to every
    // consultant and handed the non-owners a Stream authorization failure —
    // trading a dead button for one that visibly errors, which is worse. A
    // consultant qualifies here only by owning the channel.
    const isCreator = viewerOwnsChannel(creatorId, client?.userID);
    const isOperator = appRole === "ADMIN" || appRole === "STAFF";
    return isCreator || isOperator;
  })();

  // Report the other user in a 1-on-1 DM (flags in Stream + persists to DB)
  const handleReportUser = async () => {
    if (!client || !otherUserId) return;

    setIsLoading(true);
    try {
      // Flag in Stream
      await client.flagUser(otherUserId, { reason: "user_report" });

      // Also persist to our DB so staff can see it
      const reportResponse = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "PROFILE",
          reason: "User reported via chat",
          description: "User was reported from a direct message conversation",
          targetUserId: otherUserId,
        }),
      });

      if (!reportResponse.ok) {
        const data = await reportResponse.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit report");
      }

      toast({
        title: "User reported",
        description: "Our team will review this report",
      });
    } catch (error) {
      console.error("Error reporting user:", error);
      toast({
        title: "Error",
        description: "Failed to report user",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Block the other user in a 1-on-1 DM
  const handleBlockUser = async () => {
    if (!otherUserId) return;

    setIsLoading(true);
    try {
      const response = await fetch("/api/stream/users/block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: otherUserId }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || "Block failed");
      }

      toast({
        title: "User blocked",
        description: "This user can no longer message you",
      });
    } catch (error) {
      // The server's message, not a generic one. A partial block answers 502
      // with "Blocked in 1 of 2 conversations" — telling someone only that it
      // "failed" would hide that half of it succeeded, and telling them it
      // worked would be worse.
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to block user",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Toggle mute/unmute for channels and DMs
  const handleMuteChannel = async () => {
    setIsLoading(true);
    try {
      if (isMuted) {
        await channel.unmute();
        toast({
          title: "Notifications enabled",
          description: "You will receive notifications from this channel",
        });
      } else {
        await channel.mute();
        toast({
          title: "Channel muted",
          description: "You will no longer receive notifications",
        });
      }
    } catch (error) {
      console.error("Error toggling mute:", error);
      toast({
        title: "Error",
        description: "Failed to update notification settings",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <ResponsiveModal open={open} onOpenChange={handleOpenChange}>
        <ResponsiveModalTrigger asChild>
          <button
            type="button"
            aria-label="Channel details and settings"
            title="Channel details and settings"
            className="p-2 rounded-full hover:bg-muted"
          >
            <InfoIcon className="h-5 w-5 text-muted-foreground" />
          </button>
        </ResponsiveModalTrigger>
        <ResponsiveModalContent className="sm:max-w-[500px]">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>
              {isTeamChannel ? (
                <div className="flex items-center">
                  <span className="text-muted-foreground mr-2">#</span>
                  <span>{displayName}</span>
                </div>
              ) : displayInfo.isGroupDM ? (
                <div className="flex items-center">
                  <UsersIcon className="h-4 w-4 text-muted-foreground mr-2" />
                  <span className="truncate">{displayName}</span>
                </div>
              ) : (
                <span>{displayName}</span>
              )}
            </ResponsiveModalTitle>
          </ResponsiveModalHeader>

          <Tabs defaultValue="info" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="info">Information</TabsTrigger>
              <TabsTrigger value="members">Members ({memberCount})</TabsTrigger>
            </TabsList>

            <TabsContent value="info" className="space-y-4 py-4">
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Channel Type</h3>
                <p className="text-sm text-muted-foreground">
                  {isTeamChannel
                    ? "Group Chat"
                    : displayInfo.isGroupDM
                      ? "Group Conversation"
                      : "Direct Message"}
                </p>
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-medium">Created</h3>
                <p className="text-sm text-muted-foreground">
                  {channel.data?.created_at &&
                  typeof channel.data.created_at === "string"
                    ? new Date(channel.data.created_at).toLocaleString()
                    : "Unknown"}
                </p>
              </div>

              <div className="pt-4">
                <h3 className="text-sm font-medium mb-2">
                  {isDirectMessage && displayInfo.isGroupDM
                    ? "Group Actions"
                    : "Channel Actions"}
                </h3>
                <div className="space-y-2">
                  {!isTeamChannel ? (
                    displayInfo.isGroupDM ? (
                      // Group DM Actions
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={handleMuteChannel}
                          disabled={isLoading}
                        >
                          {isMuted ? (
                            <>
                              <BellIcon className="h-4 w-4" />
                              Unmute Notifications
                            </>
                          ) : (
                            <>
                              <BellOffIcon className="h-4 w-4" />
                              Mute Notifications
                            </>
                          )}
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={handleAddMember}
                          disabled={isLoading}
                        >
                          <UserPlusIcon className="h-4 w-4" />
                          Add Members
                        </Button>

                        {canTruncateChannel && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full flex items-center justify-center gap-2"
                            onClick={() => setShowClearConfirm(true)}
                            disabled={isLoading}
                          >
                            <Trash2Icon className="h-4 w-4" />
                            Clear Chat
                          </Button>
                        )}

                        <Button
                          variant="destructive"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={() => setShowLeaveConfirm(true)}
                          disabled={isLoading}
                        >
                          <UserMinusIcon className="h-4 w-4" />
                          Leave Group
                        </Button>
                      </>
                    ) : (
                      // Individual DM Actions
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={handleMuteChannel}
                          disabled={isLoading}
                        >
                          {isMuted ? (
                            <>
                              <BellIcon className="h-4 w-4" />
                              Unmute Notifications
                            </>
                          ) : (
                            <>
                              <BellOffIcon className="h-4 w-4" />
                              Mute Notifications
                            </>
                          )}
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={() => setShowClearConfirm(true)}
                          disabled={isLoading}
                        >
                          <Trash2Icon className="h-4 w-4" />
                          Clear Chat
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={handleReportUser}
                          disabled={isLoading || !otherUserId}
                        >
                          <AlertTriangleIcon className="h-4 w-4" />
                          Report User
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2 text-destructive hover:text-destructive/90"
                          onClick={handleBlockUser}
                          disabled={isLoading || !otherUserId}
                        >
                          <BanIcon className="h-4 w-4" />
                          Block User
                        </Button>
                      </>
                    )
                  ) : (
                    // Team/Event Channel Actions
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full flex items-center justify-center gap-2"
                        onClick={handleMuteChannel}
                        disabled={isLoading}
                      >
                        {isMuted ? (
                          <>
                            <BellIcon className="h-4 w-4" />
                            Unmute Channel
                          </>
                        ) : (
                          <>
                            <BellOffIcon className="h-4 w-4" />
                            Mute Channel
                          </>
                        )}
                      </Button>

                      <Button
                        variant="destructive"
                        size="sm"
                        className="w-full flex items-center justify-center gap-2"
                        onClick={() => setShowLeaveConfirm(true)}
                        disabled={isLoading}
                      >
                        <UserMinusIcon className="h-4 w-4" />
                        Leave Channel
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="members" className="space-y-4 py-4">
              {isLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                      <div className="flex-1 space-y-1">
                        <Skeleton className="h-4 w-1/2" />
                        <Skeleton className="h-3 w-1/4" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <ResponsiveTable<ChannelMember>
                  className="max-h-[300px] overflow-y-auto"
                  rows={members}
                  getRowId={(member) => member.id}
                  columns={[
                    {
                      key: "member",
                      header: "Member",
                      primary: true,
                      cell: (member) => (
                        <div className="flex items-center">
                          <div className="mr-3 flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                            {member.image ? (
                              <Image
                                src={member.image ?? ""}
                                alt={member.name ?? ""}
                                width={32}
                                height={32}
                                className="h-8 w-8 rounded-full"
                              />
                            ) : (
                              <span>
                                {member.name?.charAt(0) ||
                                  member.id?.charAt(0) ||
                                  "?"}
                              </span>
                            )}
                          </div>
                          <span className="truncate font-medium">
                            {member.name || member.id}
                          </span>
                        </div>
                      ),
                    },
                    {
                      key: "presence",
                      header: "Status",
                      cell: (member) => (
                        <span className="text-xs text-muted-foreground">
                          {member.online ? "Online" : "Offline"}
                        </span>
                      ),
                    },
                  ]}
                  /* Show remove button for event owner consultants */
                  rowActions={(member) =>
                    isEventOwner && member.id !== client?.userID ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => handleRemoveMember(member.id)}
                        disabled={isLoading}
                        // Named, because every row otherwise announced the
                        // same thing and you could not tell who you removed.
                        aria-label={`Remove ${member.name || member.id} from this channel`}
                        title={`Remove ${member.name || member.id}`}
                      >
                        <XIcon className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    ) : null
                  }
                  empty={
                    <EmptyState
                      icon={UsersIcon}
                      title="No members"
                      description="This channel has no members yet."
                    />
                  }
                />
              )}

              {isTeamChannel && (
                <div className="pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full flex items-center justify-center gap-2"
                    onClick={handleAddMember}
                    disabled={isLoading}
                  >
                    <UserPlusIcon className="h-4 w-4" />
                    Add Members
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* Loading dialog for leaving channel */}
      <ResponsiveModal open={isLeavingChannel} onOpenChange={() => {}}>
        <ResponsiveModalContent className="sm:max-w-[300px] [&>button]:hidden">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle className="sr-only">
              Leaving Channel
            </ResponsiveModalTitle>
          </ResponsiveModalHeader>
          <div className="flex flex-col items-center justify-center py-6 space-y-4">
            <Loader2Icon className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Leaving channel...</p>
          </div>
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* Clear Chat Confirmation Dialog */}
      <ResponsiveModal
        open={showClearConfirm}
        onOpenChange={setShowClearConfirm}
      >
        <ResponsiveModalContent className="sm:max-w-[400px]">
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Clear chat history?</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              This will remove all messages from this conversation. This action
              cannot be undone.
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <ResponsiveModalFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setShowClearConfirm(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleClearChat}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Clear Chat
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* Add Members Dialog */}
      <AddMembersDialog
        open={showAddMembers}
        onOpenChange={setShowAddMembers}
        existingMemberIds={Object.keys(channel.state.members || {})}
        onMembersAdded={handleMembersAdded}
      />

      {/* Leave Channel Confirmation Dialog */}
      <AlertDialog open={showLeaveConfirm} onOpenChange={setShowLeaveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {displayInfo.isGroupDM ? "Leave group?" : "Leave channel?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              You will lose access to this{" "}
              {displayInfo.isGroupDM ? "group" : "channel"} and its message
              history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLeaveChannel}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Yes, Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
