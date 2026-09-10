/**
 * Read layer for the public organisations directory.
 *
 * Discovery is deliberately NOT gated on `canHost` or on ENABLE_HOST_ORGS. That
 * flag gates money paths (org creation with canHost, EXPERT memberships, the
 * 3-way split) — filtering the directory on it made the page structurally
 * incapable of being non-empty, because the same flag prevents any org from
 * acquiring canHost in the first place. The single visibility control is the
 * owner-set `Organization.isPublic` opt-in.
 */

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { readByIds } from "@/lib/data/read-by-ids";
import {
  ORGANISATIONS_PER_PAGE,
  type IOrganisationFilters,
  type OrganisationListItem,
  type OrganisationsMetadata,
  type OrganisationsPage,
  type OrgCapabilityFilter,
  type OrgSortOption,
} from "@/lib/explore/organisation-types";

// Types and defaults live in lib/explore/organisation-types.ts so client
// components can import them without pulling prisma into the browser bundle.
export * from "@/lib/explore/organisation-types";

/**
 * Which memberships count as "an expert of this org".
 *
 * Must stay identical to the roster query on the org detail page — the card's
 * "N experts" is a promise about what you'll see after clicking through, so a
 * looser predicate here means the count over-reports and the page looks broken.
 * Deliberately keyed on the membership + profile state, never on
 * `ConsultantProfile.isIndependent`, which is a derived cache that goes stale
 * whenever memberships are written without recomputing it.
 */
const EXPERT_MEMBERSHIP_WHERE = {
  role: "EXPERT",
  status: "ACTIVE",
  consultantProfile: {
    verificationStatus: "VERIFIED",
    deletedAt: null,
  },
} as const;

/**
 * Every listed org must be a live, opted-in, non-deleted org. Capability plays
 * no part here — see the file header.
 */
function baseWhere(): Prisma.OrganizationWhereInput {
  return { isPublic: true, status: "ACTIVE", deletedAt: null };
}

function whereFromFilters(
  filters: IOrganisationFilters,
): Prisma.OrganizationWhereInput {
  const where: Prisma.OrganizationWhereInput = baseWhere();

  if (filters.search) {
    // industry/description live on the OrgBrandingProfile satellite since #768.
    // The previous public API queried them as scalars on Organization, which
    // made every ?search= request throw a Prisma validation error.
    where.OR = [
      { name: { contains: filters.search, mode: "insensitive" } },
      {
        brandingProfile: {
          is: {
            description: { contains: filters.search, mode: "insensitive" },
          },
        },
      },
      {
        brandingProfile: {
          is: { industry: { contains: filters.search, mode: "insensitive" } },
        },
      },
    ];
  }

  const branding: Prisma.OrgBrandingProfileWhereInput = {};
  if (filters.types.length > 0) branding.directoryType = { in: filters.types };
  if (filters.sizes.length > 0) branding.sizeBucket = { in: filters.sizes };
  if (filters.industries.length > 0) {
    branding.industry = { in: filters.industries, mode: "insensitive" };
  }
  if (Object.keys(branding).length > 0) {
    // `is:` — brandingProfile is a nullable 1:1, so the bare-object shorthand
    // is ambiguous with the relation filter and doesn't typecheck.
    where.brandingProfile = { is: branding };
  }

  if (filters.capability === "host") {
    where.canHost = true;
    where.canSponsor = false;
  } else if (filters.capability === "sponsor") {
    where.canSponsor = true;
    where.canHost = false;
  } else if (filters.capability === "hybrid") {
    where.canHost = true;
    where.canSponsor = true;
  }

  if (filters.hasExperts) {
    where.memberships = { some: EXPERT_MEMBERSHIP_WHERE };
  }

  return where;
}

function orderByForSort(
  sort: OrgSortOption,
): Prisma.OrganizationOrderByWithRelationInput[] {
  switch (sort) {
    case "nameDesc":
      return [{ name: "desc" }];
    case "newest":
      return [{ createdAt: "desc" }, { name: "asc" }];
    // expertsDesc is not expressible here — see rankByExpertCount.
    default:
      return [{ name: "asc" }];
  }
}

/**
 * Page ids ranked by ACTIVE EXPERT membership count, descending.
 *
 * Prisma can't order by a *filtered* relation count, and ordering by the raw
 * `memberships._count` counts learners, owners and support members too — so a
 * learner-heavy org outranked one with more experts, contradicting the number
 * rendered on its own card. Ranking here keeps the order and the displayed
 * count derived from the same predicate.
 *
 * Two queries instead of one, over the opt-in directory set only (public,
 * ACTIVE, non-deleted), which is curated and small by construction.
 */
async function rankByExpertCount(
  where: Prisma.OrganizationWhereInput,
  skip: number,
  take: number,
): Promise<string[]> {
  const rows = await prisma.organization.findMany({
    where,
    select: {
      id: true,
      name: true,
      _count: { select: { memberships: { where: EXPERT_MEMBERSHIP_WHERE } } },
    },
  });

  return rows
    .sort(
      (a, b) =>
        b._count.memberships - a._count.memberships ||
        a.name.localeCompare(b.name),
    )
    .slice(skip, skip + take)
    .map((row) => row.id);
}

const orgListSelect = {
  id: true,
  name: true,
  slug: true,
  canSponsor: true,
  canHost: true,
  createdAt: true,
  brandingProfile: {
    select: {
      logo: true,
      bannerImage: true,
      description: true,
      industry: true,
      website: true,
      sizeBucket: true,
      directoryType: true,
    },
  },
  kybVerification: { select: { kybVerifiedAt: true } },
  _count: { select: { memberships: { where: EXPERT_MEMBERSHIP_WHERE } } },
} satisfies Prisma.OrganizationSelect;

function toListItem(
  row: Prisma.OrganizationGetPayload<{ select: typeof orgListSelect }>,
): OrganisationListItem {
  const capability: OrganisationListItem["capability"] =
    row.canHost && row.canSponsor
      ? "hybrid"
      : row.canHost
        ? "host"
        : row.canSponsor
          ? "sponsor"
          : "inert";

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logo: row.brandingProfile?.logo ?? null,
    bannerImage: row.brandingProfile?.bannerImage ?? null,
    description: row.brandingProfile?.description ?? null,
    industry: row.brandingProfile?.industry ?? null,
    website: row.brandingProfile?.website ?? null,
    sizeBucket: row.brandingProfile?.sizeBucket ?? null,
    directoryType: row.brandingProfile?.directoryType ?? null,
    capability,
    // There is no `verified` boolean on Organization — KYB sign-off is the
    // only durable verification signal, and ACTIVE status is already implied.
    isVerified: Boolean(row.kybVerification?.kybVerifiedAt),
    expertCount: row._count.memberships,
  };
}

export async function getOrganisationsPage(
  filters: IOrganisationFilters,
  page = 1,
  perPage = ORGANISATIONS_PER_PAGE,
): Promise<OrganisationsPage> {
  const where = whereFromFilters(filters);
  const safePage = Math.max(1, page);
  const skip = (safePage - 1) * perPage;

  let rows: Prisma.OrganizationGetPayload<{ select: typeof orgListSelect }>[];
  let total: number;

  if (filters.sort === "expertsDesc") {
    const [rankedIds, count] = await Promise.all([
      rankByExpertCount(where, skip, perPage),
      prisma.organization.count({ where }),
    ]);
    total = count;
    // Named `pageRows`, not `page` — that would shadow the `page` parameter.
    // Guarded for a page past the end of the ranking, or a filter set nothing
    // matches — see readByIds. (#1121)
    const pageRows = await readByIds(rankedIds, () =>
      prisma.organization.findMany({
        where: { id: { in: rankedIds } },
        select: orgListSelect,
      }),
    );
    // findMany ignores the id order, so restore the ranking.
    const order = new Map(rankedIds.map((id, index) => [id, index]));
    rows = pageRows.sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
  } else {
    [rows, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        select: orgListSelect,
        orderBy: orderByForSort(filters.sort),
        skip,
        take: perPage,
      }),
      prisma.organization.count({ where }),
    ]);
  }

  return {
    items: rows.map(toListItem),
    total,
    page: safePage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/**
 * Facet counts for the filter rail. Computed over the full visible set (not the
 * current filter), so a facet never renders a count the user can't reach.
 */
export async function getOrganisationsMetadata(): Promise<OrganisationsMetadata> {
  const where = baseWhere();

  const [total, brandingRows, capabilityRows] = await Promise.all([
    prisma.organization.count({ where }),
    prisma.orgBrandingProfile.findMany({
      where: { organization: where },
      select: { industry: true, directoryType: true, sizeBucket: true },
    }),
    prisma.organization.findMany({
      where,
      select: { canHost: true, canSponsor: true },
    }),
  ]);

  const tally = <T extends string>(values: (T | null)[]) => {
    const counts = new Map<T, number>();
    for (const value of values) {
      if (value === null) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };

  const capabilityCounts = { host: 0, sponsor: 0, hybrid: 0 };
  for (const row of capabilityRows) {
    if (row.canHost && row.canSponsor) capabilityCounts.hybrid += 1;
    else if (row.canHost) capabilityCounts.host += 1;
    else if (row.canSponsor) capabilityCounts.sponsor += 1;
  }

  return {
    industries: tally(brandingRows.map((r) => r.industry)),
    types: tally(brandingRows.map((r) => r.directoryType)),
    sizes: tally(brandingRows.map((r) => r.sizeBucket)),
    capabilities: (
      Object.entries(capabilityCounts) as [OrgCapabilityFilter, number][]
    )
      .filter(([, count]) => count > 0)
      .map(([value, count]) => ({ value, count })),
    total,
  };
}
