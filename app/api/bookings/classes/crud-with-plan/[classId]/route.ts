import * as Sentry from "@sentry/nextjs";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
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
    const { classId } = awaitedParams;

    // Replace UUID validation with simple string check
    if (!classId || typeof classId !== "string") {
      return NextResponse.json(
        { error: "Invalid or missing Class ID" }, // Updated error message
        { status: 400 },
      );
    }

    console.log(`Attempting to delete class instance with ID: ${classId}`);

    // Start transaction
    const result = await withSerializableRetry(
      () =>
        prisma.$transaction(
          async (tx) => {
            // 1. Find the class instance, get plan ID, title, and owner info
            const classInstance = await tx.class.findUnique({
              where: { id: classId },
              select: {
                classPlanId: true,
                classPlan: {
                  select: {
                    title: true,
                    consultantProfile: {
                      select: { userId: true },
                    },
                  },
                },
              },
            });

            if (!classInstance) {
              throw new Error(`Class instance with ID ${classId} not found.`);
            }

            // Verify ownership - user must own this class
            if (
              !classInstance.classPlan.consultantProfile ||
              classInstance.classPlan.consultantProfile.userId !==
                session.user.id
            ) {
              throw new Error(
                "You do not have permission to delete this class",
              );
            }

            const classPlanId = classInstance.classPlanId;
            const eventTitle = classInstance.classPlan.title; // Store the title
            console.log(
              `Found class plan ID: ${classPlanId} (Title: "${eventTitle}") for instance ${classId}`,
            );

            // 2. Delete the class instance
            console.log(`Deleting class instance: ${classId}`);
            await tx.class.delete({ where: { id: classId } });

            // 3. Check if other instances use the same plan
            const remainingInstancesCount = await tx.class.count({
              where: { classPlanId: classPlanId },
            });

            let planWasDeleted = false; // Flag to know if plan deletion happened
            if (remainingInstancesCount === 0) {
              // 4. Delete the plan if needed
              console.log(
                `Deleting class plan: ${classPlanId} as no other instances exist`,
              );
              await tx.classPlan.delete({ where: { id: classPlanId } });
              planWasDeleted = true;
            } else {
              console.log(
                `Class plan ${classPlanId} is still used by ${remainingInstancesCount} other instance(s), not deleting plan.`,
              );
            }

            // Return title and whether plan was deleted
            return { eventTitle, planWasDeleted };
          },
          {
            maxWait: 15000, // Allow 15 seconds for connection acquisition
            timeout: 30000, // Allow 30 seconds for the transaction itself
            isolationLevel: "Serializable", // Keep high isolation if appropriate
          },
        ),
      1, // #1319 review — 45 s per attempt; two attempts stay under the function ceiling
    );

    console.log("Class and potentially plan deleted successfully:", result);
    // Use the fetched title in the response message
    return NextResponse.json(
      {
        message:
          `Class "${result.eventTitle}" deleted successfully.` + // Use title
          (result.planWasDeleted
            ? ` The associated plan was also deleted.`
            : " The associated plan was kept as it is used by other instances."),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting class:", error);
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
      { error: "An error occurred during class deletion" },
      { status: 500 },
    );
  }
}

// Add dummy GET, POST, PATCH handlers if needed to satisfy Next.js file conventions
// export async function GET(request: NextRequest, { params }: { params: Promise<{ classId: string }> }) {
//   return NextResponse.json({ message: "GET not implemented" }, { status: 405 });
// }
// export async function POST(request: NextRequest, { params }: { params: Promise<{ classId: string }> }) {
//   return NextResponse.json({ message: "POST not implemented" }, { status: 405 });
// }
// export async function PATCH(request: NextRequest, { params }: { params: Promise<{ classId: string }> }) {
//   return NextResponse.json({ message: "PATCH not implemented" }, { status: 405 });
// }
