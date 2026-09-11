/**
 * The consultant a plan payload may carry.
 *
 * The plan list and detail routes used to `include: { consultantProfile: … }`
 * bare, which serialised the whole ConsultantProfile row — PAN, bank account,
 * SWIFT, TDS certificate, MSME — into responses that `/api/plans/classes` and
 * `/api/plans/webinars` serve to anyone on the internet and the rest serve to
 * any signed-in user. #946 moved the detail pages to `consultantPublicScalars`;
 * these are the routes it missed. Every plan read goes through one of these two.
 */
import { Prisma } from "@prisma/client";
import { consultantPublicScalars } from "@/lib/data/consultant-public";

/** The plan owner: public scalars plus the card's user fields. */
export const planConsultantSelect = {
  ...consultantPublicScalars,
  user: {
    select: {
      id: true,
      name: true,
      image: true,
      workExperiences: {
        select: { company: true, companyDomain: true, isCurrent: true },
        orderBy: [
          { isCurrent: "desc" as const },
          { startDate: "desc" as const },
        ],
        take: 3,
      },
    },
  },
  domain: { select: { id: true, name: true } },
  subDomains: { select: { id: true, name: true } },
  tags: { select: { id: true, name: true } },
} satisfies Prisma.ConsultantProfileSelect;

/** An accepted collaborator: the same, without the taxonomy relations. */
export const planCollaboratorConsultantSelect = {
  ...consultantPublicScalars,
  user: {
    select: {
      id: true,
      name: true,
      image: true,
      workExperiences: {
        select: { company: true, companyDomain: true, isCurrent: true },
        orderBy: [
          { isCurrent: "desc" as const },
          { startDate: "desc" as const },
        ],
        take: 3,
      },
    },
  },
} satisfies Prisma.ConsultantProfileSelect;
