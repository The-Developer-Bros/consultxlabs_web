/**
 * Appointment detail for the detail page. Authz is the shared participation
 * gate (capability, not UserRole) + platform ADMIN/STAFF; no org-party
 * surface here — an org operator's grant never widens read access (ADR 20).
 */

import { NextRequest, NextResponse } from "next/server";
import { AppointmentIdParams } from "@/schemas/support";
import {
  parseRouteParams,
  supportError,
} from "@/lib/api/support-http";
import {
  authorizeAppointment,
  appointmentAuthzError,
} from "@/lib/api/appointment-access";

const DETAIL_ROUTE = "appointments.detail";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: DETAIL_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;
  try {
    const auth = await authorizeAppointment(appointmentId);
    if ("code" in auth) {
      return appointmentAuthzError(auth, { route: DETAIL_ROUTE, appointmentId });
    }
    return NextResponse.json({ data: auth.detail });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: DETAIL_ROUTE, action: "get", appointmentId },
    });
  }
}
