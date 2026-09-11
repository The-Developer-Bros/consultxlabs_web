/**
 * GET /api/admin/organizations
 *
 * Platform-admin view of all organizations — filterable by status,
 * searchable by name/email. Used by the admin org management page to
 * surface PENDING_VERIFICATION orgs for review and allow admins to
 * verify, suspend, or reactivate without needing DB access.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";

const OrgStatusSchema = z.enum([
  "PENDING_VERIFICATION",
  "ACTIVE",
  "SUSPENDED",
  "DEACTIVATED",
]);

export async function GET(req: NextRequest) {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const statusRaw = url.searchParams.get("status");
  const search = url.searchParams.get("search")?.trim() ?? "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "25", 10)),
  );

  const statusFilter = statusRaw
    ? OrgStatusSchema.safeParse(statusRaw)
    : null;

  const where = {
    ...(statusFilter?.success ? { status: statusFilter.data } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { billingEmail: { contains: search, mode: "insensitive" as const } },
            { slug: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, organizations] = await Promise.all([
    prisma.organization.count({ where }),
    prisma.organization.findMany({
      where,
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        canSponsor: true,
        canHost: true,
        billingEmail: true,
        createdAt: true,
        billingAccount: {
          select: { id: true, fundingSource: true },
        },
        _count: {
          select: {
            memberships: true,
            contracts: true,
          },
        },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return NextResponse.json({
    data: organizations,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
}
