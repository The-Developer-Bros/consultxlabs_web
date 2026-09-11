"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X, Plus } from "lucide-react";
import { z } from "zod";
import type { StepProps } from "./types";
import {
  MEMBER_ROLE_LABEL,
  SELF_SERVICE_MEMBER_ROLES,
  narrowSelfServiceRole,
  type SelfServiceMemberRole,
} from "@/lib/labels/org-labels";

export function InviteTeamStep({ onNext, onBack, initialData }: StepProps) {
  const [rawInput, setRawInput] = useState("");
  const [emails, setEmails] = useState<string[]>(
    initialData.inviteEmails ?? [],
  );
  const [role, setRole] = useState<SelfServiceMemberRole>(
    narrowSelfServiceRole(initialData.inviteRole),
  );
  const [invalidEmails, setInvalidEmails] = useState<string[]>([]);

  const addEmails = () => {
    setInvalidEmails([]);
    const candidates = rawInput
      .split(/[,\n;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const valid: string[] = [];
    const invalid: string[] = [];
    for (const candidate of candidates) {
      if (z.string().email().safeParse(candidate).success) {
        if (!emails.includes(candidate) && !valid.includes(candidate)) {
          valid.push(candidate);
        }
      } else {
        invalid.push(candidate);
      }
    }

    if (invalid.length > 0) {
      setInvalidEmails(invalid);
    }
    if (valid.length > 0) {
      setEmails((prev) => [...prev, ...valid]);
      setRawInput("");
    }
  };

  const removeEmail = (email: string) => {
    setEmails((prev) => prev.filter((e) => e !== email));
  };

  const handleSubmit = () => {
    onNext({ inviteEmails: emails, inviteRole: role });
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="emails">Invite team members by email</Label>
        <div className="flex gap-2">
          <textarea
            id="emails"
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm min-h-20 font-mono"
            placeholder={"alice@acme.com\nbob@acme.com\ncharlie@acme.com"}
          />
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={addEmails}
            disabled={!rawInput.trim()}
          >
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </div>
        <p className="text-xs text-zinc-500">
          Comma, semicolon, or newline-separated. Duplicates are ignored.
        </p>
        {invalidEmails.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm text-red-500 font-medium">
              {invalidEmails.length === 1
                ? "1 address couldn't be added:"
                : `${invalidEmails.length} addresses couldn't be added:`}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {invalidEmails.map((e) => (
                <Badge
                  key={e}
                  variant="secondary"
                  className="bg-red-50 text-red-700 border border-red-200 font-mono text-xs"
                >
                  {e}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>

      {emails.length > 0 && (
        <div className="space-y-2">
          <Label>
            {emails.length} email{emails.length !== 1 ? "s" : ""} to invite
          </Label>
          <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto p-2 border border-zinc-200 rounded-lg bg-zinc-50">
            {emails.map((email) => (
              <Badge
                key={email}
                variant="secondary"
                className="gap-1 pr-1"
              >
                {email}
                <button
                  type="button"
                  onClick={() => removeEmail(email)}
                  className="rounded-full hover:bg-zinc-300 p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label>Default role for invitees</Label>
        <Select
          value={role}
          // shadcn hands a raw string; narrowSelfServiceRole parses via
          // the shared Zod enum. We only render SELF_SERVICE_MEMBER_ROLES
          // below, so the fallback branch is effectively dead — but the
          // parse still protects us from future regressions.
          onValueChange={(v) => setRole(narrowSelfServiceRole(v))}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SELF_SERVICE_MEMBER_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {MEMBER_ROLE_LABEL[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onNext({ inviteEmails: [], inviteRole: role })}
          >
            Skip for now
          </Button>
          <Button type="button" onClick={handleSubmit}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
