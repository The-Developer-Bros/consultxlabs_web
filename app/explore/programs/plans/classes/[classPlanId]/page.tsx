import { notFound } from "next/navigation";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { getClassPlanDetail } from "@/lib/data/plan-details";
import { ClassDetails } from "./components/ClassDetails";
import { generateProgramImageUrl } from "@/lib/explore/programs";

// Stream behind the static layout's instant skeleton; don't prerender at build (#932).
export const dynamic = "force-dynamic";

export default async function ClassDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ classPlanId: string }>;
}>) {
  const { classPlanId } = await params;
  const classPlan = await getClassPlanDetail(classPlanId);

  if (!classPlan) {
    notFound();
  }

  // #726 — a detail page is reachable by id, so it needs the same
  // gate the list surfaces get: ORG_ONLY stays inside the owning org, and an
  // archived plan is not a live page.
  if (!(await canViewPlanDetail(classPlan))) {
    notFound();
  }

  const planWithDefaults = {
    ...classPlan,
    type: "class" as const,
    imageUrl: generateProgramImageUrl(
      classPlan.id,
      1200,
      400,
      classPlan.imageUrl,
    ),
  };

  return <ClassDetails plan={planWithDefaults} />;
}
