/**
 * SCIM 2.0 `/scim/v2/Users` — GET (list) + POST (create).
 *
 * Authenticated via bearer token resolved through `requireScimAuth`
 * (lib/scim/auth.ts). Lives under `/scim/v2/**` rather than
 * `/api/scim/...` because IdPs (Okta, Azure) hard-code the SCIM path
 * pattern; deviating breaks every off-the-shelf SCIM connector.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireScimAuth } from "@/lib/scim/auth";
import { scimError } from "@/lib/scim/errors";
import { createOrReprovisionScimUser } from "@/lib/scim/operations";
import { toScimUser } from "@/lib/scim/resource-user";
import {
  DomainVerificationRequiredError,
  UNVERIFIED_ORG_SEAT_CAP,
} from "@/lib/enterprise/governance";

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

function baseUrlFrom(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const auth = await requireScimAuth(req);
  if (auth.response) return auth.response;
  const { organizationId } = auth.grant;

  // Minimal `filter=userName eq "x"` parser — covers the canonical
  // Okta lookup before create. More complex filters fall through to
  // the unfiltered list (which is what RFC 7644 says we MAY do).
  const url = new URL(req.url);
  const filterParam = url.searchParams.get("filter");
  let emailFilter: string | undefined;
  if (filterParam) {
    const m = filterParam.match(
      /^\s*userName\s+eq\s+"([^"]+)"\s*$/i,
    );
    if (m) emailFilter = m[1].toLowerCase();
  }

  const startIndex = Math.max(1, Number(url.searchParams.get("startIndex") ?? 1));
  const count = Math.min(200, Math.max(1, Number(url.searchParams.get("count") ?? 100)));

  const where = {
    organizationId,
    ...(emailFilter ? { user: { email: emailFilter } } : {}),
  };

  const [totalResults, rows] = await prisma.$transaction([
    prisma.membership.count({ where }),
    prisma.membership.findMany({
      where,
      orderBy: { createdAt: "asc" },
      skip: startIndex - 1,
      take: count,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    }),
  ]);

  // Group-name lookup is best-effort — for v1 we don't reverse-map
  // role → group, so the resource's `groups` array is empty unless we
  // later wire it up. The IdP still gets a consistent (id, userName,
  // active) shape.
  const baseUrl = baseUrlFrom(req);
  const resources = rows.map((r) =>
    toScimUser({
      membership: r,
      user: r.user,
      groupNames: [],
      baseUrl,
    }),
  );

  return NextResponse.json(
    {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults,
      startIndex,
      itemsPerPage: rows.length,
      Resources: resources,
    },
    { headers: { "Content-Type": "application/scim+json" } },
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireScimAuth(req);
  if (auth.response) return auth.response;
  const { organizationId } = auth.grant;

  const body = (await req.json().catch(() => null)) as
    | {
        schemas?: string[];
        userName?: string;
        name?: { givenName?: string; familyName?: string };
        emails?: Array<{ value: string; primary?: boolean }>;
        active?: boolean;
        externalId?: string;
        groups?: Array<{ value?: string; display?: string } | string>;
      }
    | null;

  if (!body || !body.schemas?.includes(SCIM_USER_SCHEMA)) {
    return scimError(400, "Missing or invalid SCIM User schema", "invalidSyntax");
  }
  const userName = body.userName ?? body.emails?.find((e) => e.primary)?.value;
  if (!userName) {
    return scimError(400, "userName (or primary email) is required", "invalidValue");
  }

  const groupNames = (body.groups ?? [])
    .map((g) => (typeof g === "string" ? g : (g.value ?? g.display ?? "")))
    .filter((s): s is string => s.length > 0);

  let result: Awaited<ReturnType<typeof createOrReprovisionScimUser>>;
  try {
    result = await createOrReprovisionScimUser(prisma, {
      organizationId,
      userName,
      givenName: body.name?.givenName,
      familyName: body.name?.familyName,
      active: body.active ?? true,
      externalId: body.externalId,
      groupNames,
    });
  } catch (err) {
    // Unverified-org seat cap — surface as a permanent SCIM error so the
    // IdP's provisioning report tells the admin to verify a domain.
    if (err instanceof DomainVerificationRequiredError) {
      return scimError(
        403,
        `Seat cap reached — verify a domain to provision more than ${UNVERIFIED_ORG_SEAT_CAP} members.`,
      );
    }
    // Concurrent provisioning of the same user raced past the membership
    // lookup; the (userId, organizationId) unique index is the backstop.
    // Idempotent — the member already exists — so surface RFC 7644's
    // uniqueness conflict rather than a 500 the IdP would keep retrying.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return scimError(
        409,
        "User is already provisioned in this organization",
        "uniqueness",
      );
    }
    throw err;
  }

  if ("kind" in result) {
    if (result.kind === "USER_ERASED") {
      return scimError(
        410,
        "User has been erased per DPDP §12 and cannot be re-provisioned. Remove the user from your IdP roster.",
      );
    }
    return scimError(409, result.kind === "CONFLICT" ? result.detail : "Conflict");
  }

  const membership = await prisma.membership.findUnique({
    where: { id: result.membershipId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  if (!membership) {
    return scimError(500, "Membership disappeared after create — re-fetch failed");
  }
  return NextResponse.json(
    toScimUser({
      membership,
      user: membership.user,
      groupNames,
      baseUrl: baseUrlFrom(req),
    }),
    { status: 201, headers: { "Content-Type": "application/scim+json" } },
  );
}
