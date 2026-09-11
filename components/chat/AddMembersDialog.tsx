"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useDebouncedCallback } from "use-debounce";
import Image from "next/image";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import { Loader2Icon, SearchIcon, UserPlusIcon, XIcon } from "lucide-react";
import type { ConsulteeSearchResult } from "@/schemas/stream-search";

interface AddMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingMemberIds: string[];
  onMembersAdded: (userIds: string[]) => Promise<void>;
}

export const AddMembersDialog = ({
  open,
  onOpenChange,
  existingMemberIds,
  onMembersAdded,
}: AddMembersDialogProps) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [consultees, setConsultees] = useState<ConsulteeSearchResult[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const { toast } = useToast();

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setSearchTerm("");
      setConsultees([]);
      setSelectedIds(new Set());
      setHasSearched(false);
    }
  }, [open]);

  /**
   * Same latest-wins guard and cancellation as `ChannelSearch`, for the same
   * reason: this had a hand-rolled `setTimeout`, no `AbortController` and an
   * unconditional `setConsultees(...)`, so whichever response landed last won
   * regardless of which term it answered. Modelled on
   * `hooks/scheduling/useCalendarData.ts`.
   *
   * Unlike ChannelSearch there is deliberately NO minimum-length guard. An
   * empty term is a real query here — it lists everyone the consultant may add
   * — and gating it would leave the dialog blank until you typed.
   */
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // A primitive, so the debounced callback's identity does not change on every
  // render the way it did with the `existingMemberIds` array in the deps —
  // which re-ran the debounce effect continuously and re-armed the timer.
  const excludeParam = existingMemberIds.join(",");

  const searchConsultees = useCallback(
    async (term: string, exclude: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = ++requestIdRef.current;

      setIsSearching(true);
      setHasSearched(true);

      try {
        const response = await fetch(
          // Both halves encoded. `term` was, `exclude` was not — so a member id
          // containing `&`, `+`, `#` or a space truncated or corrupted the
          // exclusion set, and people already in the channel reappeared as
          // addable.
          `/api/stream/search-consultees?term=${encodeURIComponent(term)}&exclude=${encodeURIComponent(exclude)}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          throw new Error("Failed to search consultees");
        }

        const data = await response.json();
        if (requestId !== requestIdRef.current) return;
        setConsultees(data.consultees || []);
      } catch (error) {
        // Our own cancellation, not a failure — and surfacing it as a toast
        // would fire one per keystroke.
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (requestId !== requestIdRef.current) return;
        console.error("Error searching consultees:", error);
        toast({
          title: "Error",
          description: "Failed to search consultees",
          variant: "destructive",
        });
      } finally {
        if (requestId === requestIdRef.current) setIsSearching(false);
      }
    },
    [toast],
  );

  const debouncedSearch = useDebouncedCallback(searchConsultees, 300);

  useEffect(() => {
    if (!open) return;
    debouncedSearch(searchTerm, excludeParam);
  }, [searchTerm, excludeParam, open, debouncedSearch]);

  // Abort on close as well as unmount: the dialog resets its state when it
  // closes, and a late response would repopulate the list behind it.
  useEffect(() => {
    if (!open) {
      debouncedSearch.cancel();
      abortRef.current?.abort();
    }
  }, [open, debouncedSearch]);

  useEffect(
    () => () => {
      // See ChannelSearch — use-debounce v10 leaves trailing callbacks armed
      // across unmount.
      debouncedSearch.cancel();
      abortRef.current?.abort();
    },
    [debouncedSearch],
  );

  const toggleSelection = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const removeSelection = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  };

  const handleAddMembers = async () => {
    if (selectedIds.size === 0) return;

    setIsAdding(true);
    try {
      await onMembersAdded(Array.from(selectedIds));
      onOpenChange(false);
    } catch (error) {
      console.error("Error adding members:", error);
      toast({
        title: "Error",
        description: "Failed to add some members",
        variant: "destructive",
      });
    } finally {
      setIsAdding(false);
    }
  };

  const getRelationshipLabel = (
    type: ConsulteeSearchResult["relationshipType"],
  ) => {
    switch (type) {
      case "consultation":
        return "Consultation";
      case "subscription":
        return "Subscription";
      case "webinar":
        return "Webinar";
      case "class":
        return "Class";
      default:
        return "";
    }
  };

  const selectedConsultees = consultees.filter((c) => selectedIds.has(c.id));

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-[500px]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle className="flex items-center gap-2">
            <UserPlusIcon className="h-5 w-5" />
            Add Members
          </ResponsiveModalTitle>
          <ResponsiveModalDescription>
            Search and select consultees to add to this channel.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>

        {/* Search Input */}
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search by name or email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Selected Users Badges */}
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap gap-2 p-2 bg-muted rounded-md">
            <span className="text-xs text-muted-foreground w-full mb-1">
              Selected ({selectedIds.size}):
            </span>
            {selectedConsultees.map((consultee) => (
              <span
                key={consultee.id}
                className="inline-flex items-center gap-1 px-2 py-1 bg-secondary text-secondary-foreground rounded-full text-sm"
              >
                {consultee.name || consultee.email}
                <button
                  type="button"
                  onClick={() => removeSelection(consultee.id)}
                  aria-label={`Remove ${consultee.name || consultee.email} from the selection`}
                  title="Remove from selection"
                  className="hover:bg-accent rounded-full p-0.5"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Search Results */}
        <div className="max-h-[250px] overflow-y-auto border border-border rounded-md">
          {isSearching ? (
            <div className="flex items-center justify-center py-8">
              <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                Searching...
              </span>
            </div>
          ) : consultees.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              {hasSearched
                ? "No consultees found. Try a different search term."
                : "Type to search for consultees"}
            </div>
          ) : (
            <div className="divide-y">
              {consultees.map((consultee) => {
                const isSelected = selectedIds.has(consultee.id);
                return (
                  <label
                    key={consultee.id}
                    className={`flex items-center gap-3 p-3 cursor-pointer hover:bg-muted ${
                      isSelected ? "bg-accent" : ""
                    }`}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelection(consultee.id)}
                    />
                    {/* Avatar */}
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center overflow-hidden flex-shrink-0">
                      {consultee.image ? (
                        <Image
                          src={consultee.image}
                          alt={consultee.name || ""}
                          width={32}
                          height={32}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="text-sm font-medium text-muted-foreground">
                          {(consultee.name || consultee.email || "?")
                            .charAt(0)
                            .toUpperCase()}
                        </span>
                      )}
                    </div>
                    {/* Name and relationship */}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-foreground truncate">
                        {consultee.name || "Unknown"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {getRelationshipLabel(consultee.relationshipType)}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <ResponsiveModalFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isAdding}
          >
            Cancel
          </Button>
          <Button
            onClick={handleAddMembers}
            disabled={selectedIds.size === 0 || isAdding}
          >
            {isAdding ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
                Adding...
              </>
            ) : (
              `Add ${selectedIds.size} Member${selectedIds.size !== 1 ? "s" : ""}`
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
};
