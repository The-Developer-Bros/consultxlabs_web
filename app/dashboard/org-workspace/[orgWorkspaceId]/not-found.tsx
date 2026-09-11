import Link from "next/link";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Scoped 404 for the operator dashboard. The layout's IDOR guard calls
 * notFound() when the URL's orgWorkspaceId doesn't match the caller's own
 * profile — this gives that case a friendly, self-contained page with a way
 * back instead of the bare global 404.
 */
export default function OrgWorkspaceNotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100">
        <Building2 className="h-7 w-7 text-zinc-400" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-zinc-900">
          Workspace not found
        </h2>
        <p className="max-w-sm text-sm text-zinc-500">
          This operator workspace doesn&apos;t exist, or your account
          doesn&apos;t have access to it.
        </p>
      </div>
      <Button variant="outline" size="sm" asChild>
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
