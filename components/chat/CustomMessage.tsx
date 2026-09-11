"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { format } from "date-fns";
import { useState } from "react";
import {
  Attachment,
  useChatContext,
  useMessageContext,
  useMessageComposer,
} from "stream-chat-react";
import {
  SmileIcon,
  ReplyIcon,
  MoreHorizontalIcon,
  EditIcon,
  Trash2Icon,
  CheckIcon,
  XIcon,
  FlagIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/utils/tailwind";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export const CustomMessage = () => {
  const { message } = useMessageContext();
  const { client, channel } = useChatContext();
  const messageComposer = useMessageComposer();
  const { toast } = useToast();
  const isMyMessage = message.user?.id === client.userID;
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.text || "");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  // Hover is the ONLY way these actions were reachable, so on a touch device
  // react/reply/edit/delete/report did not exist at all (#1134). Default to
  // the hover shape on the server so desktop hydrates without a flash.
  //
  // Both halves are needed. `(pointer: fine)` alone matches devices with a
  // precise pointer and NO hover — a stylus, some TV remotes — where
  // `group-hover` can never fire, so the floating toolbar would stay
  // transparent and the actions would be unreachable all over again. Hover
  // capability is the thing actually being branched on; pointer precision only
  // decides whether the small hit targets are usable.
  const isFinePointer = useMediaQuery(
    "(hover: hover) and (pointer: fine)",
    true,
  );

  // Map Stream reaction types to actual emoji characters
  const reactionTypeToEmoji: Record<string, string> = {
    like: "👍",
    love: "❤️",
    haha: "😂",
    wow: "😮",
    sad: "😢",
    angry: "😠",
    "thumbs-up": "👍",
    "thumbs-down": "👎",
    heart: "❤️",
    fire: "🔥",
    clap: "👏",
    "100": "💯",
    celebrate: "🎉",
    rocket: "🚀",
    eyes: "👀",
    thinking: "🤔",
    plus_one: "👍",
    smile: "😄",
  };

  // Quick reactions for the picker
  const quickReactions = [
    "like",
    "love",
    "haha",
    "wow",
    "sad",
    "angry",
    "fire",
    "clap",
  ];

  // Check if the message has text content
  const hasText = !!message.text?.trim();
  // Check if the message has attachments
  const hasAttachments =
    !!message.attachments && message.attachments.length > 0;

  // Check if message is deleted (deleted_at can be undefined when not deleted)
  const isDeleted = Boolean(message.deleted_at);

  // Check if this message is a reply to another message
  const hasQuotedMessage = !!message.quoted_message;

  // Avoid rendering empty messages
  if (!hasText && !hasAttachments && message.type !== "system" && !isDeleted) {
    return null;
  }

  // Show deleted message placeholder
  if (isDeleted) {
    return (
      <div
        className={`flex items-end ${isMyMessage ? "justify-end" : "justify-start"} mb-4`}
      >
        <div className="italic text-muted-foreground text-sm px-3 py-2">
          This message was deleted
        </div>
      </div>
    );
  }

  // The menu closes itself on select, so these handlers only do their own work.
  const handleEditClick = () => {
    setIsEditing(true);
    setEditText(message.text || "");
  };

  const handleEditSave = async () => {
    if (!client || !editText.trim()) return;
    try {
      await client.updateMessage({
        id: message.id,
        text: editText,
      });
      setIsEditing(false);
    } catch {
      toast({
        title: "Edit failed",
        description: "Could not edit the message. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleEditCancel = () => {
    setIsEditing(false);
    setEditText(message.text || "");
  };

  const handleDeleteClick = () => {
    setShowDeleteDialog(true);
  };

  const handleDeleteConfirm = async () => {
    if (!client) return;
    try {
      await client.deleteMessage(message.id);
    } catch {
      toast({
        title: "Delete failed",
        description: "Could not delete the message. Please try again.",
        variant: "destructive",
      });
    }
    setShowDeleteDialog(false);
  };

  const handleReactionClick = async (reactionType: string) => {
    if (!channel) return;
    try {
      await channel.sendReaction(message.id, { type: reactionType });
    } catch {
      toast({
        title: "Reaction failed",
        description: "Could not add reaction. Please try again.",
        variant: "destructive",
      });
    }
  };

  // WhatsApp/Telegram style reply - sets the message as quoted for the input
  const handleReplyClick = () => {
    // Use Stream Chat v13's MessageComposer API to set quoted message
    messageComposer.setQuotedMessage(message);
  };

  // Report a message (flags in Stream + persists to DB)
  const handleReportMessage = async () => {
    if (!client || !message.user?.id) return;
    try {
      // Flag in Stream (flagMessage is on the client, not the channel)
      await client.flagMessage(message.id);

      // Persist to our DB
      const reportResponse = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "MESSAGE",
          reason: "Reported message",
          targetUserId: message.user.id,
          contentText: message.text?.substring(0, 500),
          // #1270 — without the message identity, CONTENT_REMOVED had nothing
          // to delete and every report against this author folded into one row
          // whose excerpt was whichever message was reported first.
          streamMessageId: message.id,
          streamChannelCid: channel?.cid,
        }),
      });

      if (!reportResponse.ok) {
        const data = await reportResponse.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit report");
      }

      toast({
        title: "Message reported",
        description: "Our team will review this message",
      });
    } catch {
      toast({
        title: "Report failed",
        description: "Could not report message. Please try again.",
        variant: "destructive",
      });
    }
  };

  // One toolbar, two placements: floating on hover for a mouse, inline and
  // permanent for touch. Both are Radix now, which brings Escape, a focus trap
  // and focus return that the hand-rolled mousedown-only dropdowns never had.
  const actionToolbar = (
    <div className="flex items-center gap-0.5 rounded-lg border border-border bg-popover shadow-lg">
      {/* React with Emoji */}
      <Popover open={showEmojiPicker} onOpenChange={setShowEmojiPicker}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="React to message"
            title="React"
            className="rounded-l-lg p-1.5 transition-colors hover:bg-muted"
          >
            <SmileIcon className="h-4 w-4 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align={isMyMessage ? "end" : "start"}
          className="w-auto p-2"
        >
          <div className="flex gap-1">
            {quickReactions.map((reactionType) => (
              <button
                key={reactionType}
                type="button"
                aria-label={`React with ${reactionType}`}
                title={reactionType}
                onClick={() => {
                  handleReactionClick(reactionType);
                  setShowEmojiPicker(false);
                }}
                className="rounded p-1 text-xl transition-colors hover:bg-muted"
              >
                {reactionTypeToEmoji[reactionType]}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Reply (WhatsApp/Telegram style) */}
      <button
        type="button"
        onClick={handleReplyClick}
        aria-label="Reply to message"
        title="Reply"
        className="p-1.5 transition-colors hover:bg-muted"
      >
        <ReplyIcon className="h-4 w-4 text-muted-foreground" />
      </button>

      {/* More Options (Edit, Delete for own; Report for others) */}
      <DropdownMenu open={showMoreOptions} onOpenChange={setShowMoreOptions}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More message options"
            title="More options"
            className="rounded-r-lg p-1.5 transition-colors hover:bg-muted"
          >
            <MoreHorizontalIcon className="h-4 w-4 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[140px]">
          {isMyMessage ? (
            <>
              <DropdownMenuItem onSelect={handleEditClick}>
                <EditIcon className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={handleDeleteClick}
                className="text-destructive focus:text-destructive"
              >
                <Trash2Icon className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem
              onSelect={() => handleReportMessage()}
              className="text-destructive focus:text-destructive"
            >
              <FlagIcon className="mr-2 h-4 w-4" />
              Report Message
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div
      className={`flex items-end ${isMyMessage ? "justify-end" : "justify-start"} mb-4 group relative`}
    >
      {/* Avatar for other users' messages */}
      {!isMyMessage && (
        <Avatar className="mr-2 w-8 h-8 flex-shrink-0">
          <AvatarImage src={message.user?.image} />
          <AvatarFallback>
            {message.user?.name?.charAt(0) ??
              message.user?.id?.charAt(0) ??
              "?"}
          </AvatarFallback>
        </Avatar>
      )}

      {/* Touch placement: outside the bubble, on the side away from the edge. */}
      {!isFinePointer && isMyMessage && (
        <div className="mr-1 shrink-0">{actionToolbar}</div>
      )}

      {/* Message wrapper with hover actions */}
      <div
        className={cn(
          "relative min-w-0",
          isFinePointer ? "max-w-[85%]" : "max-w-[75%]",
        )}
      >
        {/* Action Toolbar - appears on hover or keyboard focus. `focus-within`
            matters: the buttons stay in the tab order while transparent, so
            without it a keyboard user tabs through invisible controls. */}
        {isFinePointer && (
          <div
            className={cn(
              "absolute bottom-full z-20 mb-1 transition-opacity",
              isMyMessage ? "right-0" : "left-0",
              showEmojiPicker || showMoreOptions
                ? "opacity-100"
                : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
            )}
          >
            {actionToolbar}
          </div>
        )}

        {/* Message Bubble */}
        <div
          className={`${isMyMessage ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"} rounded-lg px-3 py-2`}
        >
          {/* Quoted/Replied Message (WhatsApp/Telegram style) */}
          {hasQuotedMessage && message.quoted_message && (
            <div
              className={`mb-2 p-2 rounded-md border-l-4 ${
                isMyMessage
                  ? "bg-primary-foreground/15 border-primary-foreground/50"
                  : "bg-background/70 border-border"
              }`}
            >
              <div
                className={`text-xs font-semibold mb-0.5 ${isMyMessage ? "text-primary-foreground/90" : "text-foreground"}`}
              >
                {message.quoted_message.user?.name ||
                  message.quoted_message.user?.id ||
                  "Unknown"}
              </div>
              <div
                className={`text-xs truncate max-w-[250px] ${isMyMessage ? "text-primary-foreground/70" : "text-muted-foreground"}`}
              >
                {message.quoted_message.text || "[Attachment]"}
              </div>
            </div>
          )}

          {/* User Name for other users' messages */}
          {!isMyMessage && !hasQuotedMessage && (
            <div className="font-semibold text-sm mb-1">
              {message.user?.name ?? message.user?.id}
            </div>
          )}

          {/* Render Attachments if they exist */}
          {hasAttachments && (
            <div className={`attachments ${hasText ? "mb-1" : ""} grid gap-2`}>
              {message.attachments?.map((attachment, index) => (
                <div
                  key={`${message.id}-attachment-${index}`}
                  className="attachment-item"
                >
                  <Attachment attachments={[attachment]} />
                </div>
              ))}
            </div>
          )}

          {/* Render Text - show input if editing, otherwise show text */}
          {isEditing ? (
            <div className="flex flex-col gap-2">
              <Input
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className={`w-full min-w-[200px] ${isMyMessage ? "bg-primary-foreground/10 text-primary-foreground placeholder:text-primary-foreground/60 border-primary-foreground/30" : "bg-background text-foreground"}`}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleEditSave();
                  }
                  if (e.key === "Escape") {
                    handleEditCancel();
                  }
                }}
              />
              <div className="flex gap-1 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleEditCancel}
                  className={`h-6 px-2 ${isMyMessage ? "text-primary-foreground hover:bg-primary-foreground/20" : "text-muted-foreground hover:bg-background"}`}
                >
                  <XIcon className="w-3 h-3 mr-1" />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleEditSave}
                  className={`h-6 px-2 ${isMyMessage ? "bg-primary-foreground text-primary hover:bg-primary-foreground/90" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}
                >
                  <CheckIcon className="w-3 h-3 mr-1" />
                  Save
                </Button>
              </div>
            </div>
          ) : (
            hasText && (
              <div className="message-text break-words">{message.text}</div>
            )
          )}

          {/* Reactions display */}
          {message.reaction_counts &&
            Object.keys(message.reaction_counts).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {Object.entries(message.reaction_counts).map(
                  ([reactionType, count]) => {
                    const emoji =
                      reactionTypeToEmoji[reactionType] || reactionType;
                    return (
                      <button
                        key={reactionType}
                        type="button"
                        className={`text-sm px-2 py-0.5 rounded-full hover:opacity-80 ${
                          isMyMessage ? "bg-primary-foreground/20" : "bg-background"
                        }`}
                        onClick={() => handleReactionClick(reactionType)}
                        aria-label={`React with ${reactionType} (${count} so far)`}
                        title={`${reactionType} (click to react)`}
                      >
                        {emoji} {count}
                      </button>
                    );
                  },
                )}
              </div>
            )}

          {/* Timestamp — always visible. Hover-revealing it meant a message on
              a touch device never showed a time at all, unlike the WhatsApp
              model this UI copies. */}
          <div
            className={`text-xs mt-1 text-right ${isMyMessage ? "text-primary-foreground/80" : "text-muted-foreground"}`}
          >
            {message.created_at && format(new Date(message.created_at), "p")}
          </div>
        </div>
      </div>

      {!isFinePointer && !isMyMessage && (
        <div className="ml-1 shrink-0">{actionToolbar}</div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Message</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this message? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Yes, Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
