import { SupportHub } from "@/components/dashboard/shared/support/SupportHub";

/**
 * #support-hub — the Support tab: one Swiggy-style surface with a Sessions
 * subtab (per-appointment threads, including sessions the consultant
 * delivers) and a Platform subtab (flowchart intake + tickets). Feedback and
 * Help remain sibling destinations, deep-linked from the Platform subtab.
 */
export default async function SupportPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const p = await params;
  return (
    <SupportHub
      profileId={p.consultantId}
      appointmentsHrefBase={`/dashboard/consultant/${p.consultantId}/appointments`}
      feedbackHref={`/dashboard/consultant/${p.consultantId}/feedback`}
      helpHref={`/dashboard/consultant/${p.consultantId}/help`}
    />
  );
}
