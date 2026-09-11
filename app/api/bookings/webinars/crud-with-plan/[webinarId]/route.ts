import * as Sentry from "@sentry/nextjs";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const awaitedParams = await params;
    const { webinarId } = awaitedParams;

    // Replace UUID validation with simple string check
    if (!webinarId || typeof webinarId !== "string") {
      return NextResponse.json(
        { error: "Invalid or missing Webinar ID" }, // Updated error message
        { status: 400 },
      );
    }

    console.log(`Attempting to delete webinar instance with ID: ${webinarId}`);

    // Start transaction
    const result = await withSerializableRetry(
      () =>
        prisma.$transaction(
          async (tx) => {
            // 1. Find the webinar instance, get plan ID, title, and owner info
            const webinarInstance = await tx.webinar.findUnique({
              where: { id: webinarId },
              select: {
                webinarPlanId: true,
                webinarPlan: {
                  select: {
                    title: true,
                    consultantProfile: {
                      select: { userId: true },
                    },
                  },
                },
              },
            });

            if (!webinarInstance) {
              throw new Error(
                `Webinar instance with ID ${webinarId} not found.`,
              );
            }

            // Verify ownership - user must own this webinar
            if (
              !webinarInstance.webinarPlan.consultantProfile ||
              webinarInstance.webinarPlan.consultantProfile.userId !==
                session.user.id
            ) {
              throw new Error(
                "You do not have permission to delete this webinar",
              );
            }

            const webinarPlanId = webinarInstance.webinarPlanId;
            const eventTitle = webinarInstance.webinarPlan.title; // Store the title
            console.log(
              `Found webinar plan ID: ${webinarPlanId} (Title: "${eventTitle}") for instance ${webinarId}`,
            );

            // 2. Delete the webinar instance
            console.log(`Deleting webinar instance: ${webinarId}`);
            await tx.webinar.delete({ where: { id: webinarId } });

            // 3. Check if other instances use the same plan
            const remainingInstancesCount = await tx.webinar.count({
              where: { webinarPlanId: webinarPlanId },
            });

            let planWasDeleted = false; // Flag to know if plan deletion happened
            if (remainingInstancesCount === 0) {
              // 4. Delete the plan if needed
              console.log(
                `Deleting webinar plan: ${webinarPlanId} as no other instances exist`,
              );
              await tx.webinarPlan.delete({ where: { id: webinarPlanId } });
              planWasDeleted = true;
            } else {
              console.log(
                `Webinar plan ${webinarPlanId} is still used by ${remainingInstancesCount} other instance(s), not deleting plan.`,
              );
            }

            // Return title and whether plan was deleted
            return { eventTitle, planWasDeleted };
          },
          {
            maxWait: 15000,
            timeout: 30000,
            isolationLevel: "Serializable",
          },
        ),
      1, // #1319 review — 45 s per attempt; two attempts stay under the function ceiling
    );

    console.log("Webinar and potentially plan deleted successfully:", result);
    // Use the fetched title in the response message
    return NextResponse.json(
      {
        message:
          `Webinar "${result.eventTitle}" deleted successfully.` + // Use title
          (result.planWasDeleted
            ? ` The associated plan was also deleted.`
            : " The associated plan was kept as it is used by other instances."),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting webinar:", error);
    if (error instanceof Error) {
      if (error.message.includes("not found")) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("permission")) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred during webinar deletion" },
      { status: 500 },
    );
  }
}

// Add dummy GET, POST, PATCH handlers if needed
// export async function GET(request: NextRequest, { params }: { params: Promise<{ webinarId: string }> }) {
//   return NextResponse.json({ message: "GET not implemented" }, { status: 405 });
// }
// export async function POST(request: NextRequest, { params }: { params: Promise<{ webinarId: string }> }) {
//   return NextResponse.json({ message: "POST not implemented" }, { status: 405 });
// }
// export async function PATCH(request: NextRequest, { params }: { params: Promise<{ webinarId: string }> }) {
//   return NextResponse.json({ message: "PATCH not implemented" }, { status: 405 });
// }
