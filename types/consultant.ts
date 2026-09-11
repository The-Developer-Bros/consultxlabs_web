import { Prisma } from "@prisma/client";

/**
 * Represents a ConsultantProfile with specific included relations.
 * This type uses Prisma's generated types to ensure type safety and consistency with the database schema.
 *
 * @typedef {Object} TConsultantProfile
 * @property {Object} user - The user associated with this consultant profile.
 * @property {Object[]} slotOfAvailabilityWeekly - Weekly availability slots for recurring schedules.
 * @property {Object[]} slotOfAvailabilityCustom - Custom availability slots for flexible scheduling.
 * @property {Object[]} consultationPlans - Consultation plans offered by the consultant.
 * @property {Object[]} subscriptionPlans - Subscription plans offered by the consultant.
 * @property {Object[]} webinarPlans - Webinar plans offered by the consultant.
 * @property {Object[]} classPlans - Class plans offered by the consultant.
 * @property {Object[]} reviews - Reviews received by the consultant.
 */
export type TConsultantProfile = Prisma.ConsultantProfileGetPayload<{
  include: {
    user: true;
    domain: true;
    subDomains: true;
    tags: true;
    slotsOfAvailabilityWeekly: true;
    slotsOfAvailabilityCustom: true;
    consultationPlans: true;
    subscriptionPlans: {
      include: {
        subscriptionContents: true;
      };
    };
    webinarPlans: true;
    classPlans: true;
    reviews: true;
  };
}>;

/**
 * Data shape for consultant cards in public listings.
 * Used by FeaturedExperts, ExpertRow, ExpertMiniCard, ConsultantCard,
 * and FeaturedExpertsSection. Works with both server (lib/data/) and
 * client (useConsultants hook) data sources via structural typing.
 */
export interface IConsultantCardData {
  id: string;
  /**
   * #705 — the PUBLISHED score. Null until the consultant has
   * MIN_RATED_UNITS_FOR_PUBLIC_SCORE distinct rated sessions, so one review
   * cannot define a new consultant.
   */
  rating: number | null;
  /** How many reviews the score is based on. Always shown, even when the score
   *  is suppressed — "3 reviews" is honest, an average of three is not. */
  reviewCount?: number;
  headline: string | null;
  experience: number | null;
  description: string | null;
  createdAt: Date;
  isVerified?: boolean;
  user: {
    id: string;
    name: string;
    image: string | null;
    profileDisplayImage?: string | null;
    email?: string;
    workExperiences?: Array<{
      company: string;
      companyDomain: string | null;
      isCurrent: boolean;
    }>;
  };
  languages?: string[];
  domain: { id: string; name: string } | null;
  subDomains: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  reviews?: { rating: number }[];
  organizationBadge?: {
    name: string;
    slug: string;
    logo: string | null;
  } | null;
  subscriptionPlans?: Array<{
    id: string;
    title: string;
    price: number;
    priceCurrency: string;
    durationInMonths: number;
    sessionsPerWeek: number | null;
    emailSupport: string | null;
    totalSessions: number | null;
    /** Whether this plan offers a trial at all. */
    trialEnabled: boolean;
    /** 0 = free intro call; >0 = paid trial. Drives the card's Trial CTA. */
    trialPriceInPaise: number;
  }>;
}
