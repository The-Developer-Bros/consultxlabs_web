import { notFound } from "next/navigation";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import type { Metadata } from "next";
import { getConsultationPlanDetail } from "@/lib/data/plan-details";
import { ConsultationDetails } from "./components/ConsultationDetails";

// Stream behind the static layout's instant skeleton; don't prerender at build (#932).
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: Readonly<{
  params: Promise<{ consultationPlanId: string }>;
}>): Promise<Metadata> {
  const { consultationPlanId } = await params;
  const plan = await getConsultationPlanDetail(consultationPlanId).catch(
    () => null,
  );
  if (!plan) return { title: "Consultation not found" };
  const expert = plan.consultantProfile?.user?.name;
  return {
    title: `${plan.title}${expert ? ` with ${expert}` : ""} — Familiarise`,
    description:
      plan.subtitle ??
      plan.description?.slice(0, 155) ??
      `${plan.durationInHours}-hour 1:1 consultation on Familiarise.`,
  };
}

export default async function ConsultationDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ consultationPlanId: string }>;
}>) {
  const { consultationPlanId } = await params;
  const plan = await getConsultationPlanDetail(consultationPlanId);

  if (!plan) {
    notFound();
  }

  // #726 — a detail page is reachable by id, so it needs the same
  // gate the list surfaces get: ORG_ONLY stays inside the owning org, and an
  // archived plan is not a live page.
  if (!(await canViewPlanDetail(plan))) {
    notFound();
  }

  return <ConsultationDetails plan={plan} />;
}
