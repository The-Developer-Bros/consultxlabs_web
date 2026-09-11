/**
 * Recording Types
 * Prisma payload types for type-safe recording queries
 */

import { Prisma, type Recording } from "@prisma/client";
import type { Db } from "@/lib/prisma";

// #780 — payload types derive from the extended client (Prisma.Result), not
// Prisma.RecordingGetPayload, so BigInt columns (fileSize, plan.price) type
// as number — matching what the client actually returns.
// listPricePaise (#366) is converted by the money extension map, same deal.
export type RecordingRow = Omit<Recording, "fileSize" | "listPricePaise"> & {
  fileSize: number | null;
  listPricePaise: number | null;
};

// ============================================================================
// Consultant Recordings Include Structure
// Used by: RecordingService.getConsultantRecordings()
// ============================================================================

export const consultantRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meetingSession: {
      include: {
        slotOfAppointment: {
          include: {
            user: {
              select: { name: true },
            },
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        id: true,
                        title: true,
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        id: true,
                        title: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type ConsultantRecordingWithDetails = Prisma.Result<
  Db["recording"],
  { include: typeof consultantRecordingInclude },
  "findFirstOrThrow"
>;

// ============================================================================
// Recording with Access Control Include Structure
// Used by: RecordingService.getRecordingById()
// ============================================================================

export const recordingWithAccessControlInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meetingSession: {
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: true,
                  },
                },
                class: {
                  include: {
                    classPlan: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type RecordingWithAccessControl = Prisma.Result<
  Db["recording"],
  { include: typeof recordingWithAccessControlInclude },
  "findFirstOrThrow"
>;

// ============================================================================
// Webinar Plan Recordings Include Structure
// Used by: RecordingService.getWebinarPlanRecordings()
// ============================================================================

export const webinarPlanRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meetingSession: {
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type WebinarPlanRecordingWithDetails = Prisma.Result<
  Db["recording"],
  { include: typeof webinarPlanRecordingInclude },
  "findFirstOrThrow"
>;

// ============================================================================
// Class Plan Recordings Include Structure
// Used by: RecordingService.getClassPlanRecordings()
// ============================================================================

export const classPlanRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meetingSession: {
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                class: {
                  include: {
                    classPlan: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type ClassPlanRecordingWithDetails = Prisma.Result<
  Db["recording"],
  { include: typeof classPlanRecordingInclude },
  "findFirstOrThrow"
>;

// ============================================================================
// Consultee Recordings Include Structure
// Used by: RecordingService.getConsulteeRecordings()
// ============================================================================

export const consulteeRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meetingSession: {
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        id: true,
                        title: true,
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        id: true,
                        title: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type ConsulteeRecordingWithDetails = Prisma.Result<
  Db["recording"],
  { include: typeof consulteeRecordingInclude },
  "findFirstOrThrow"
>;
