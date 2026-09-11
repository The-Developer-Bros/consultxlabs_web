/**
 * Server-side ownership guard for the personal dashboard trees.
 *
 * The consultee and consultant layouts already decide who may see a profile,
 * but they decide it in a `useEffect` inside a client component — which runs
 * after the server has rendered and streamed. The server pages beneath them
 * take the profile id straight from the URL, hand it to a `lib/data` read, and
 * dehydrate the result into the HTML.
 *
 * Those reads are correct to trust their caller; `readConsulteeEvents` states
 * the contract in its own docstring — "Auth + `?orgScope=` resolution stay in
 * the route; this function ... carries no request/session coupling". The API
 * route at `/api/dashboard/consultee/[consulteeId]/events` honours it. The
 * server pages did not, and two appointment-detail pages carried comments
 * asserting that "the dashboard layout already verifies the session user owns
 * `consulteeId`" — true of the client layout, and therefore not true of
 * anything running server-side.
 *
 * The gap could not be closed upstream either. `middleware.ts` checks only
 * that a session cookie is PRESENT, because validating one needs Node APIs the
 * edge runtime does not have, and it says so at the top of the file. So any
 * signed-in user could request another profile's page and read the prefetched
 * payload out of the response body — appointments, counterparts, plan titles,
 * times — before the client-side redirect ever fired. View-source was enough;
 * no interception required.
 *
 * The rule below is the same one the layouts apply — the owner, or an ADMIN /
 * STAFF inspecting someone else's — so this closes the hole without changing
 * who is allowed to see what. It is a page guard, not a route guard: it
 * `redirect()`s rather than returning a `NextResponse`, which is why it lives
 * here instead of in `lib/auth-helpers.ts`.
 */

import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";

export type PersonalProfileKind = "consultee" | "consultant";

export interface PersonalProfileAccess {
  userId: string;
  /** True when an ADMIN or STAFF is inspecting a profile they do not own. */
  isInspecting: boolean;
}

/**
 * Assert the session user may view this personal dashboard profile.
 *
 * Call it FIRST in any server component under `/dashboard/consultee/[id]` or
 * `/dashboard/consultant/[id]` that reads data keyed on the URL id — before
 * the prefetch, so an unauthorized request never reaches the query.
 */
export async function requirePersonalProfileAccess(
  kind: PersonalProfileKind,
  profileId: string,
): Promise<PersonalProfileAccess> {
  // Force-fresh, matching requireOnboarded(): ownership and role are re-read
  // from prisma below, but only a fresh read notices a REVOKED session, and
  // this is the gate on someone's personal dashboard. Both readers pass `true`,
  // so they share one React.cache entry per request anyway.
  const session = await getSession(true);
  if (!session?.user?.id) redirect("/auth/signin");

  // Mirrors requireApiAuth's #693 check: ban-time session deletion covers the
  // normal path, this catches one minted in the race window.
  if (session.user.banned === true) redirect("/auth/signin");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      role: true,
      consulteeProfileId: true,
      consultantProfileId: true,
    },
  });
  if (!user) redirect("/auth/signin");

  const privileged = user.role === "ADMIN" || user.role === "STAFF";
  const owned =
    kind === "consultee" ? user.consulteeProfileId : user.consultantProfileId;

  if (owned === profileId) {
    return { userId: session.user.id, isInspecting: false };
  }
  if (privileged) {
    return { userId: session.user.id, isInspecting: true };
  }

  // Back to the capability router rather than guessing which dashboard they
  // belong on — a user may hold both profiles, or neither.
  redirect("/dashboard");
}
