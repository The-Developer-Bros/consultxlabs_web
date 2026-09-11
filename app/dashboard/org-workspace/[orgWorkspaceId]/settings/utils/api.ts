/**
 * Client fetch helpers for the OrgWorkspace settings page.
 *
 * Surfaces the server-side error string from the JSON body so the React
 * Query `onError` handler can show a meaningful message inline.
 */

import type {
  PatchSettingsBody,
  SettingsGetResponse,
} from "./types";

export async function fetchSettings(
  orgWorkspaceId: string,
): Promise<SettingsGetResponse> {
  const res = await fetch(`/api/org-workspace/${orgWorkspaceId}/settings`);
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

export async function patchSettings(
  orgWorkspaceId: string,
  body: PatchSettingsBody,
): Promise<SettingsGetResponse> {
  const res = await fetch(`/api/org-workspace/${orgWorkspaceId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to update settings",
    );
  }
  return json;
}
