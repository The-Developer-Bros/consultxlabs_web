import { NextRequest, NextResponse } from "next/server";
import { getAppUrl } from "@/lib/url";

/**
 * Test endpoint to simulate concurrent slot booking attempts
 * This helps verify the race condition fix works correctly
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const {
      consultantProfileId,
      startsAt,
      endsAt,
      consultationPlanId,
      slotOfAvailabilityWeeklyId,
      slotOfAvailabilityCustomId,
      concurrentRequests = 2,
    } = body;

    console.log(
      `\n🧪 RACE CONDITION TEST: Simulating ${concurrentRequests} concurrent booking attempts for slot ${startsAt}\n`,
    );

    // Create multiple concurrent requests to the same slot
    const bookingPromises = Array(concurrentRequests)
      .fill(null)
      .map(async (_, index) => {
        const startTime = Date.now();
        try {
          const response = await fetch(
            `${getAppUrl()}/api/slots/request-for-approval`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Cookie: req.headers.get("cookie") || "",
              },
              body: JSON.stringify({
                consultantProfileId,
                startsAt,
                endsAt,
                consultationPlanId,
                slotOfAvailabilityWeeklyId,
                slotOfAvailabilityCustomId,
              }),
            },
          );

          const duration = Date.now() - startTime;
          const data = await response.json();

          return {
            requestNumber: index + 1,
            status: response.status,
            success: response.status === 201,
            conflict: response.status === 409,
            duration,
            data,
          };
        } catch (error) {
          return {
            requestNumber: index + 1,
            status: 500,
            success: false,
            conflict: false,
            duration: Date.now() - startTime,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      });

    // Execute all requests concurrently
    const results = await Promise.all(bookingPromises);

    // Analyze results
    const successes = results.filter((r) => r.success).length;
    const conflicts = results.filter((r) => r.conflict).length;
    const errors = results.filter((r) => !r.success && !r.conflict).length;

    const testPassed = successes === 1 && conflicts === concurrentRequests - 1;

    console.log(`\n📊 RACE CONDITION TEST RESULTS:`);
    console.log(`   ✅ Successes: ${successes}`);
    console.log(`   ⚠️  Conflicts: ${conflicts}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log(`   ${testPassed ? "✅ TEST PASSED" : "❌ TEST FAILED"}`);
    console.log(
      `   Expected: 1 success, ${concurrentRequests - 1} conflicts\n`,
    );

    return NextResponse.json({
      testPassed,
      summary: {
        totalRequests: concurrentRequests,
        successes,
        conflicts,
        errors,
        expectedResult: `1 success, ${concurrentRequests - 1} conflicts`,
        actualResult: `${successes} success, ${conflicts} conflicts, ${errors} errors`,
      },
      details: results,
      verdict: testPassed
        ? "✅ Race condition fix is working correctly! Only one booking succeeded."
        : "❌ Race condition still exists! Multiple bookings succeeded or unexpected errors occurred.",
    });
  } catch (error) {
    console.error("Error in race condition test:", error);
    return NextResponse.json(
      {
        error: "Test failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
