/**
 * Explore-programs domain helpers and shapes.
 *
 * Moved out of `app/explore/programs/utils.ts`: `lib/data/explore-programs.ts`
 * imported FUNCTIONS from it, which made the data layer depend on a route
 * folder at runtime — the wrong direction, and the only non-type instance of it
 * left in the codebase. Nothing here is routing; it is pagination constants,
 * program shapes and an image-URL builder.
 */
import {
  ClassPlan as PrismaClassPlan,
  WebinarPlan as PrismaWebinarPlan,
} from "@prisma/client";

export const ITEMS_PER_PAGE = 12;

export type ProgramType = "all" | "class" | "webinar";

// Type for registration data from API
interface SlotUser {
  id: string;
}

interface SlotWithUser {
  user?: SlotUser[];
}

interface WebinarWithAppointment {
  appointment?: {
    slotsOfAppointment?: SlotWithUser[];
  } | null;
}

interface ClassSlot extends Record<string, unknown> {
  user?: SlotUser[];
}

interface ClassAppointment {
  slotsOfAppointment: ClassSlot[];
}

export interface ClassInstance {
  id: string;
  schedulingPeriodStartsAt?: string | Date | null;
  /** Per-instance capacity override; null inherits the plan's value. */
  maxParticipants?: number | null;
  appointments?: ClassAppointment[];
}

type ProgramConsultantProfile = {
  rating?: number;
  headline?: string | null;
  user?: {
    name?: string | null;
    image?: string | null;
    workExperiences?: Array<{
      company: string;
      companyDomain: string | null;
      isCurrent: boolean;
    }>;
  };
};

type ProgramCollaborator = {
  consultantProfile?: ProgramConsultantProfile | null;
};

// #780 — price reaches here as number (extended-client read → JSON), never bigint
export type ClassPlanProgram = Omit<PrismaClassPlan, "price"> & {
  price: number;
  classes: ClassInstance[];
  type: "class";
  imageUrl: string;
  isRegistered?: boolean;
  consultantProfile?: ProgramConsultantProfile | null;
  collaborators?: ProgramCollaborator[];
};

export type WebinarPlanProgram = Omit<PrismaWebinarPlan, "price"> & {
  price: number;
  webinars?: WebinarWithAppointment[];
  type: "webinar";
  imageUrl: string;
  isRegistered?: boolean;
  consultantProfile?: ProgramConsultantProfile | null;
  collaborators?: ProgramCollaborator[];
};

export type Program = ClassPlanProgram | WebinarPlanProgram;

export interface ApiMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface TopicWithCount {
  id: string;
  name: string;
  programCount: number;
}

export interface ProgramFilters {
  topicIds?: string[];
  language?: string;
  domainId?: string;
  sort?: string;
  minPrice?: number;
  maxPrice?: number;
  search?: string;
  /** "all" is the UI sentinel for "no level filter" and is never sent. */
  level?: string;
}

// Generate program image URL based on ID with dimensions, using DB image if available
export function generateProgramImageUrl(
  id: string,
  width: number = 600,
  height: number = 400,
  dbImageUrl?: string | null,
): string {
  if (dbImageUrl) return dbImageUrl;
  return `https://picsum.photos/seed/${id}/${width}/${height}`;
}

export function isClassProgram(program: Program): program is ClassPlanProgram {
  return program.type === "class";
}

// `filterAndSortPrograms` and `getUniqueLevels` used to re-filter search/level
// on the client over the already-loaded infinite-scroll page, which meant a
// matching program on a later page never appeared and the level dropdown could
// only offer levels that happened to be loaded. Both are now server-side:
// `level` joins the shared where-builder in app/api/plans/shared/plan-filters.ts,
// and the level list comes from `getCachedProgramLevels` in the RSC.
