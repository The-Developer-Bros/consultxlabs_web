"use client";

/**
 * #support-hub — the direct "New request" dialog for PLATFORM tickets. The
 * flowchart intake stays the front door (it resolves most issues without a
 * queue); this is the explicit path for users who already know what they need.
 * Issue types are restricted to the platform taxonomy — session-specific
 * problems belong on the appointment's Get help thread (the server 422s them
 * here anyway, so the UI and API enforce the same line).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import { SupportPriority } from "@prisma/client";
import {
  ISSUE_TYPE_LABELS,
  PLATFORM_ISSUE_TYPE_CATEGORIES,
} from "@/utils/supportTicketUrl";

export function CreateTicketDialog({
  trigger,
}: {
  /** Custom trigger node; defaults to a "New request" button. */
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [issueType, setIssueType] = useState<string>("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<SupportPriority>("MEDIUM");
  const { toast } = useToast();
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/user/support-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueType,
          title: title.trim(),
          description: description.trim(),
          priority,
        }),
      });
      if (!res.ok) await throwSupportError(res, "request create");
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Request created",
        description: "Our team will reply here and by email.",
      });
      void qc.invalidateQueries({ queryKey: ["user-support-tickets"] });
      setOpen(false);
      setIssueType("");
      setTitle("");
      setDescription("");
      setPriority("MEDIUM");
    },
    onError: (e: unknown) =>
      toast({
        title: "Couldn't create request",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      }),
  });

  const valid = !!issueType && title.trim().length > 0 && description.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Plus className="mr-1.5 h-4 w-4" />
            New request
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New support request</DialogTitle>
          <DialogDescription>
            Platform issues only — payments, account, sign-in, site trouble.
            Something wrong with a specific session? Open that appointment and
            use &quot;Get help&quot; instead.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-ticket-issueType">
              What&apos;s this about? <span className="text-red-500">*</span>
            </Label>
            <Select value={issueType} onValueChange={setIssueType}>
              <SelectTrigger id="new-ticket-issueType">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PLATFORM_ISSUE_TYPE_CATEGORIES).map(
                  ([category, types]) => (
                    <SelectGroup key={category}>
                      {/* Group + label associate the heading with its options
                          for assistive technology, unlike styled divs. */}
                      <SelectLabel className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {category}
                      </SelectLabel>
                      {types.map((t) => (
                        <SelectItem key={t} value={t}>
                          {ISSUE_TYPE_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-ticket-title">
              Subject <span className="text-red-500">*</span>
            </Label>
            <Input
              id="new-ticket-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="One line summarising the problem"
              maxLength={200}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-ticket-description">
              Details <span className="text-red-500">*</span>
            </Label>
            <Textarea
              id="new-ticket-description"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What happened, what you expected, and anything you already tried."
              maxLength={4000}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-ticket-priority">Priority</Label>
            <Select
              value={priority}
              onValueChange={(v) => setPriority(v as SupportPriority)}
            >
              <SelectTrigger id="new-ticket-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="LOW">Low</SelectItem>
                <SelectItem value="MEDIUM">Medium</SelectItem>
                <SelectItem value="HIGH">High</SelectItem>
                <SelectItem value="URGENT">Urgent</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!valid || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create request"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
