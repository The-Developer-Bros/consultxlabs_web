import type { getConsultantDetail } from "@/lib/data/consultant-detail";

// Inferred from the lib/data fetcher so plan prices stay number — the raw
// Prisma payload (TConsultantDetailData) re-introduces bigint money (#780)
export type ConsultantDetailData = NonNullable<
  Awaited<ReturnType<typeof getConsultantDetail>>
>;

type OriginalSlotData = {
  id: string;
  startsAt: string;
  endsAt: string;
};

export interface ProcessedSlot {
  id: string;
  localStartTime: string;
  localEndTime: string;
  originalSlot: OriginalSlotData;
  isAllocated?: boolean;
  bookingStatus?: "available" | "partially-booked" | "fully-booked";
  startsAt?: string;
  endsAt?: string;
  type?: "WEEKLY" | "CUSTOM";
}
