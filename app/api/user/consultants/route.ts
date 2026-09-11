import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  consultantCardInclude,
  toConsultantCard,
  orderByForSort,
  getDefaultConsultantsPage,
} from "@/lib/data/explore-experts";
import { apiError } from "@/lib/errors";
import { isTransientDbError, reportTransient } from "@/lib/data/fail-open";

export async function GET(request: NextRequest) {
  // Hoisted out of the try so the fail-open branch can echo them back in `meta`.
  const searchParams = request.nextUrl.searchParams;
  const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get("limit") || "10") || 10),
    100,
  );
  const sort = searchParams.get("sort") || "nameAsc";

  try {
    const domain = searchParams.get("domain");
    const subdomain = searchParams.get("subdomain");
    // Repeated params (?tags=a&tags=b), matching the client writers, so a literal
    // comma in a tag/company name can't split one value into two filter terms.
    // filter(Boolean) drops an empty ?tags= (mirrors companies) so it reads as
    // "no filter" rather than name IN [""] → zero results.
    const tags = searchParams.getAll("tags").filter(Boolean);
    const experience = parseInt(searchParams.get("experience") || "0");
    const search = searchParams.get("search");
    const language = searchParams.get("language");
    const companies = searchParams.getAll("companies").filter(Boolean);
    const affiliationType = searchParams.get("affiliationType");

    const rawMinPrice = searchParams.get("minPrice");
    const rawMaxPrice = searchParams.get("maxPrice");
    const rawMinRating = searchParams.get("minRating");
    const minPrice = rawMinPrice ? parseFloat(rawMinPrice) : undefined;
    const maxPrice = rawMaxPrice ? parseFloat(rawMaxPrice) : undefined;
    const minRating = rawMinRating ? parseFloat(rawMinRating) : undefined;

    // Admin/staff can list unverified; public listings are verified-only.
    const includeUnverified =
      searchParams.get("includeUnverified") === "true";

    // The unfiltered first page is the explore landing's default view — serve it
    // from the Next data cache (getDefaultConsultantsPage) so it doesn't open a
    // cross-region pooled connection on every load. Anything filtered/searched or
    // beyond page 1 falls through to a live query. (#945, #932)
    const isDefaultView =
      page === 1 &&
      !includeUnverified &&
      !domain &&
      !subdomain &&
      tags.length === 0 &&
      experience <= 0 &&
      minPrice === undefined &&
      maxPrice === undefined &&
      minRating === undefined &&
      companies.length === 0 &&
      !language &&
      !affiliationType &&
      !search;

    if (isDefaultView) {
      const result = await getDefaultConsultantsPage(sort, limit);
      return NextResponse.json(result, {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      });
    }

    // Build where clause using an explicit conditions array
    const conditions: Prisma.ConsultantProfileWhereInput[] = [];

    // Only show verified consultants in public listings
    if (!includeUnverified) {
      conditions.push({ verificationStatus: "VERIFIED" });
    }
    // #781 §B — soft-deleted profiles leave public surfaces
    conditions.push({ deletedAt: null });

    // Accept either a domain id (what FilterPanel sends, from metadata) or a
    // domain NAME. Every human-authored link — the nav category chips, the
    // footer expertise band, the use-case pages — spells the domain out
    // (`?domain=Technology`), which silently matched nothing while this only
    // compared against the cuid.
    if (domain) {
      conditions.push({
        OR: [
          { domainId: domain },
          { domain: { name: { equals: domain, mode: "insensitive" } } },
        ],
      });
    }
    if (subdomain) {
      conditions.push({
        OR: [
          { subDomains: { some: { id: subdomain } } },
          {
            subDomains: {
              some: { name: { equals: subdomain, mode: "insensitive" } },
            },
          },
        ],
      });
    }
    if (tags.length > 0) {
      conditions.push({ tags: { some: { name: { in: tags } } } });
    }
    if (experience > 0) {
      conditions.push({ experience: { gte: experience } });
    }
    if (minPrice !== undefined && !isNaN(minPrice)) {
      conditions.push({
        subscriptionPlans: { some: { price: { gte: minPrice } } },
      });
    }
    if (maxPrice !== undefined && !isNaN(maxPrice)) {
      conditions.push({
        subscriptionPlans: { some: { price: { lte: maxPrice } } },
      });
    }
    if (minRating !== undefined && !isNaN(minRating)) {
      // #705 — filter on the published score, so a suppressed consultant is
      // not surfaced by a rating the profile page refuses to display.
      conditions.push({ publishedRating: { gte: minRating } });
    }
    if (companies.length > 0) {
      conditions.push({
        user: { workExperiences: { some: { company: { in: companies } } } },
      });
    }
    if (language) {
      conditions.push({ languages: { has: language } });
    }
    // Affiliation type: independent (isIndependent=true) or agency (false).
    if (affiliationType === "independent") {
      conditions.push({ isIndependent: true });
    } else if (affiliationType === "agency") {
      conditions.push({ isIndependent: false });
    }
    if (search) {
      conditions.push({
        OR: [
          { user: { name: { contains: search, mode: "insensitive" } } },
          // No email match here — this is a public endpoint and email
          // substring search is a PII enumeration key.
          { description: { contains: search, mode: "insensitive" } },
          { headline: { contains: search, mode: "insensitive" } },
          { domain: { name: { contains: search, mode: "insensitive" } } },
          {
            subDomains: {
              some: { name: { contains: search, mode: "insensitive" } },
            },
          },
          { tags: { some: { name: { contains: search, mode: "insensitive" } } } },
        ],
      });
    }

    const where: Prisma.ConsultantProfileWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const [consultants, total] = await Promise.all([
      prisma.consultantProfile.findMany({
        where,
        orderBy: orderByForSort(sort),
        skip: (page - 1) * limit,
        take: limit,
        include: consultantCardInclude,
      }),
      prisma.consultantProfile.count({ where }),
    ]);

    // toConsultantCard is an explicit allowlist — NEVER spread the row: it carries
    // statutory PII (PAN, bank/SWIFT, TDS, residency, MSME) that must not leak on
    // this public endpoint. (#945)
    return NextResponse.json(
      {
        data: consultants.map(toConsultantCard),
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    // Cross-region pooler cold-connect timeouts (#932, FAMILIARISE_WEB-9) are a
    // known, tracked transient — degrade this public list to empty rather than a
    // 500 + captured error. Real defects still capture + surface. Mirrors the
    // announcements route (#931) and lib/data/fail-open.
    if (isTransientDbError(error)) {
      reportTransient("consultants list read", error, {
        subsystem: "consultants",
      });
      // `no-store`: the degraded EMPTY result must NEVER be cached. With a shared
      // s-maxage, a single transient timeout would pin "No experts found" at the
      // CDN/browser for minutes after the DB recovers (the explore page renders
      // this list). The success path keeps its own cache header; only this
      // fail-open branch opts out so the next request retries immediately. (#945)
      return NextResponse.json(
        { data: [], meta: { total: 0, page, limit, totalPages: 0 } },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "consultants" } },
    );
    return apiError({ tag: "[Consultants.GET]", error });
  }
}
