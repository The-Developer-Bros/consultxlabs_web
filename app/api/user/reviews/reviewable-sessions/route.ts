/**
 * #705 — the sessions this consultee may review.
 *
 * Reviews became per-session, so "can I review X" is a question about an
 * appointment rather than about a consultant. The review card asks this before
 * rendering, and the same helper backs the POST's authorization — one rule, not
 * two that can disagree.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import { supportError } from "@/lib/api/support-http";
import {
  listReviewableSessions,
  resolveReviewableSession,
} from "@/lib/reviews";

const ROUTE = "user.reviews.reviewable";

// #831 — every caller-supplied string is parsed and bounded before it reaches a
// query. Both ids are cuid/uuid-shaped, so 64 characters is generous.
const QuerySchema = z.object({
  consultantProfileId: z.string().min(1).max(64).optional(),
  appointmentId: z.string().min(1).max(64).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({
        status: 401,
        code: "UNAUTHORIZED",
        context: { route: ROUTE },
      });
    }
    const consulteeProfileId = session.user.consulteeProfileId;
    // Not having a consultee profile is not an error — it just means there is
    // nothing to review, and the card renders nothing.
    if (!consulteeProfileId) {
      return NextResponse.json({ data: [] });
    }

    // #705 — the profile page asks about a CONSULTANT, not an appointment:
    // "have I earned the right to review this person, and have I already?"
    // Returns the most recent qualifying session, which is the provenance the
    // POST records.
    const query = QuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!query.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: query.error.flatten(),
        context: { route: ROUTE },
      });
    }
    const { consultantProfileId, appointmentId } = query.data;

    if (consultantProfileId) {
      // Filtered in the QUERY, not after it. `loadReviewableAppointments` caps
      // at the 50 newest bookings, so narrowing afterwards silently returned
      // nothing to anyone whose session with this expert sat outside that page.
      return NextResponse.json({
        data: await listReviewableSessions(
          consulteeProfileId,
          session.user.id,
          consultantProfileId,
        ),
      });
    }

    if (appointmentId) {
      const one = await resolveReviewableSession(
        consulteeProfileId,
        session.user.id,
        appointmentId,
      );
      return NextResponse.json({ data: one ? [one] : [] });
    }

    return NextResponse.json({
      data: await listReviewableSessions(consulteeProfileId, session.user.id),
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: ROUTE },
    });
  }
}
