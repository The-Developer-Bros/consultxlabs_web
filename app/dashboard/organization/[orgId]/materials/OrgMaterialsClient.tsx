"use client";

import { FileText } from "lucide-react";

interface OrgMaterialRow {
  id: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  description: string | null;
  uploadedAt: Date;
  planTitle: string | null;
  planType: string;
}

export function OrgMaterialsClient({
  items,
  total,
}: {
  readonly items: OrgMaterialRow[];
  readonly total: number;
}) {
  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Materials</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Course handouts attached to this organization&apos;s plans. Read-only
          inventory — content is delivered to members through their sessions.
        </p>
      </header>

      {items.length === 0 ? (
        <div className="py-20 text-center text-muted-foreground">
          <FileText className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p>No materials attached to org plans yet.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className="border-t hover:bg-muted/30">
                  <td className="px-4 py-3 max-w-[280px] truncate font-medium">
                    {m.originalName}
                  </td>
                  <td className="px-4 py-3 max-w-[200px] truncate">
                    {m.planTitle ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {m.planType}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {(m.fileSize / (1024 * 1024)).toFixed(1)} MB
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {/* Explicit TZ — server (UTC) and browser must agree or
                        hydration mismatches flash the wrong day. */}
                    {new Date(m.uploadedAt).toLocaleDateString("en-IN", {
                      timeZone: "UTC",
                      dateStyle: "medium",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {items.length < total && (
        <p className="text-xs text-muted-foreground">
          Showing the newest {items.length} of {total} materials — use the API
          for full pagination.
        </p>
      )}
    </div>
  );
}
