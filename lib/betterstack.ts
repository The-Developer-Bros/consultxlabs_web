/**
 * Better Stack Incident Management
 *
 * Auto-creates incidents when entering OFFLINE maintenance mode
 * and resolves them when maintenance ends.
 *
 * Requires env var: BETTERSTACK_API_KEY
 */

import * as Sentry from "@sentry/nextjs";

const BETTERSTACK_API_URL = "https://uptime.betterstack.com/api/v2";

function getApiKey(): string | null {
  return process.env.BETTERSTACK_API_KEY ?? null;
}

async function betterstackRequest(
  path: string,
  options: globalThis.RequestInit = {},
): Promise<globalThis.Response | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("[BetterStack] API key not configured, skipping");
    return null;
  }

  const res = await fetch(`${BETTERSTACK_API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    console.error(
      `[BetterStack] API error: ${res.status} ${res.statusText} for ${path}`,
    );
  }

  return res;
}

/**
 * Create a maintenance incident in Better Stack.
 * Returns the incident ID for later resolution.
 */
export async function createIncident(
  name: string,
  summary?: string,
): Promise<string | null> {
  try {
    const res = await betterstackRequest("/incidents", {
      method: "POST",
      body: JSON.stringify({
        requester_email: "system@familiarise.com",
        name,
        summary: summary || "Scheduled platform maintenance",
        call: false,
        sms: false,
        email: true,
        push: true,
      }),
    });

    if (!res) return null;

    const data = await res.json();
    const incidentId = data?.data?.id;

    console.log(
      JSON.stringify({
        event: "betterstack_incident_created",
        incidentId,
        timestamp: new Date().toISOString(),
      }),
    );

    return incidentId ?? null;
  } catch (error) {
    console.error("[BetterStack] Failed to create incident:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "betterstack" } });
    return null;
  }
}

/**
 * Resolve an incident in Better Stack.
 */
export async function resolveIncident(incidentId: string): Promise<boolean> {
  try {
    const res = await betterstackRequest(`/incidents/${incidentId}/resolve`, {
      method: "POST",
    });

    if (!res) return false;

    console.log(
      JSON.stringify({
        event: "betterstack_incident_resolved",
        incidentId,
        timestamp: new Date().toISOString(),
      }),
    );

    return res.ok;
  } catch (error) {
    console.error("[BetterStack] Failed to resolve incident:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "betterstack" } });
    return false;
  }
}
