import { SupportHub } from "@/components/dashboard/shared/support/SupportHub";

/**
 * #support-hub — the Support tab: one Swiggy-style surface with a Sessions
 * subtab (per-appointment threads) and a Platform subtab (flowchart intake +
 * tickets). Feedback and Help remain sibling destinations, deep-linked from
 * the Platform subtab.
 */
export default async function SupportPage({
  params,
}: {
  params: Promise<{ consulteeId: string }>;
}) {
  const p = await params;
  return (
    <SupportHub
      profileId={p.consulteeId}
      appointmentsHrefBase={`/dashboard/consultee/${p.consulteeId}/appointments`}
      feedbackHref={`/dashboard/consultee/${p.consulteeId}/feedback`}
      helpHref={`/dashboard/consultee/${p.consulteeId}/help`}
    />
  );
}
