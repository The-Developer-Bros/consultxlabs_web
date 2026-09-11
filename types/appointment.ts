import { Prisma } from "@prisma/client";

// Custom type for Consultation with specific nesting depth
export type TConsultation = Prisma.ConsultationGetPayload<{
  include: {
    consultationPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
      };
    };
    requestedBy: {
      include: {
        user: true;
      };
    };
    appointment: {
      include: {
        slotsOfAppointment: {
          include: {
            user: true;
            meetingSession: {
              select: { id: true; endedAt: true; endedReason: true };
            };
          };
        };
        payment: true;
      };
    };
  };
}>;

// Custom type for Subscription with specific nesting depth
export type TSubscription = Prisma.SubscriptionGetPayload<{
  include: {
    subscriptionPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
      };
    };
    requestedBy: {
      include: {
        user: true;
      };
    };
    appointments: {
      include: {
        slotsOfAppointment: {
          include: {
            user: true;
            meetingSession: {
              select: { id: true; endedAt: true; endedReason: true };
            };
          };
        };
        payment: true;
      };
    };
  };
}>;

// Custom type for Webinar with specific nesting depth
export type TWebinar = Prisma.WebinarGetPayload<{
  include: {
    webinarPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
        topics: true;
      };
    };
    appointment: {
      include: {
        slotsOfAppointment: {
          include: {
            user: true;
            meetingSession: {
              select: { id: true; endedAt: true; endedReason: true };
            };
          };
        };
        payment: true;
      };
    };
  };
}>;

// Custom type for Class with specific nesting depth
export type TClass = Prisma.ClassGetPayload<{
  include: {
    classPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
        topics: true;

        classContents: {
          orderBy: {
            order: "asc";
          };
        };
      };
    };
    appointments: {
      include: {
        slotsOfAppointment: {
          include: {
            user: true;
            meetingSession: {
              select: { id: true; endedAt: true; endedReason: true };
            };
          };
        };
        payment: true;
      };
    };
  };
}>;

export type TAppointment = Prisma.AppointmentGetPayload<{
  include: {
    consultation: {
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true;
              };
            };
          };
        };
        requestedBy: {
          include: {
            user: true;
          };
        };
      };
    };
    subscription: {
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true;
              };
            };
            title: true;
          };
        };
        requestedBy: {
          include: {
            user: true;
          };
        };
        // #997 Phase 3 — weekly-confirmed-call-count aggregate buckets by this
        // column (ADR B9), read in app/api/slots/appointments/route.ts.
        schedulingTimezone: true;
      };
    };
    webinar: {
      include: {
        webinarPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true;
              };
            };

            title: true;
          };
        };
      };
    };
    class: {
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true;
              };
            };
          };
        };
      };
    };
    payment: true;
    slotsOfAppointment: {
      include: {
        user: true;
        meetingSession: {
          select: { id: true; endedAt: true; endedReason: true };
        };
      };
    };
  };
}>;

// Extract slot type from TAppointment for reuse
export type TSlotOfAppointment = TAppointment["slotsOfAppointment"][number];
