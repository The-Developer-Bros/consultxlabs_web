import { EventWithType } from "@/app/dashboard/consultee/[consulteeId]/utils/getMetadata";

export const mockEvents: EventWithType[] = [
  {
    id: "subscription-1",
    type: "Subscription",
    status: "REJECTED",
    subscriptionPlan: {
      id: "plan-1",
      title: "Basic Subscription",
      consultantProfile: {
        user: {
          id: "user-1",
          name: "Test Consultant",
          email: "test@example.com",
          image: null,
          phone: null,
          address: null,
          onlineStatus: false,
          timezone: null,
          onboardingCompleted: false,
          role: "CONSULTANT",
          consultantProfileId: null,
          emailVerified: null,
          consulteeProfileId: null,
          staffProfileId: null,
        },
      },
    },
    appointments: [
      {
        id: "appointment-1",
        appointmentType: "SUBSCRIPTION",
        slotsOfAppointment: [
          {
            id: "slot-1",
            startsAt: new Date("2024-12-30T13:00:00Z"),
            endsAt: new Date("2024-12-30T15:00:00Z"),
            isTentative: true,
            appointmentId: "appointment-1",
            createdAt: new Date(),
            updatedAt: new Date(),
            user: [],
          },
        ],
        payment: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "class-1",
    type: "Class",
    status: "COMPLETED",
    classPlan: {
      id: "plan-2",
      title: "Intermediate Class",
      consultantProfile: {
        user: {
          id: "user-2",
          name: "Mr. Santos Murray",
          email: "santos@example.com",
          image: null,
          phone: null,
          address: null,
          onlineStatus: false,
          timezone: null,
          onboardingCompleted: false,
          role: "CONSULTANT",
          consultantProfileId: null,
          emailVerified: null,
          consulteeProfileId: null,
          staffProfileId: null,
        },
      },
    },
    appointments: [
      {
        id: "appointment-2",
        appointmentType: "CLASS",
        slotsOfAppointment: [
          {
            id: "slot-2",
            startsAt: new Date("2024-12-18T15:00:00Z"),
            endsAt: new Date("2024-12-18T17:00:00Z"),
            isTentative: false,
            appointmentId: "appointment-2",
            createdAt: new Date(),
            updatedAt: new Date(),
            user: [],
          },
          {
            id: "slot-3",
            startsAt: new Date("2024-12-25T13:00:00Z"),
            endsAt: new Date("2024-12-25T16:00:00Z"),
            isTentative: false,
            appointmentId: "appointment-2",
            user: [],
          },
          {
            id: "slot-4",
            startsAt: new Date("2025-01-01T12:00:00Z"),
            endsAt: new Date("2025-01-01T13:00:00Z"),
            isTentative: false,
            appointmentId: "appointment-2",
            user: [],
          },
          {
            id: "slot-5",
            startsAt: new Date("2025-01-08T13:00:00Z"),
            endsAt: new Date("2025-01-08T14:00:00Z"),
            isTentative: false,
            appointmentId: "appointment-2",
            user: [],
          },
        ],
        payment: [],
      },
    ],
  },
  {
    id: "consultation-1",
    type: "Consultation",
    status: "REJECTED",
    consultationPlan: {
      id: "plan-3",
      title: "Extended Consultation",
      consultantProfile: {
        user: {
          id: "user-3",
          name: "Test Consultant",
          email: "test@example.com",
          image: null,
          phone: null,
          address: null,
          onlineStatus: false,
          timezone: null,
          onboardingCompleted: false,
          role: "CONSULTANT",
          consultantProfileId: null,
          emailVerified: null,
          consulteeProfileId: null,
          staffProfileId: null,
        },
      },
    },
    appointment: {
      id: "appointment-3",
      appointmentType: "CONSULTATION",
      slotsOfAppointment: [],
      payment: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  },
] as unknown as EventWithType[];

// New Mock Data for pastEvent
export const pastEvent: EventWithType = {
  id: "past-class",
  type: "Class",
  status: "COMPLETED",
  classPlan: {
    id: "past-plan",
    title: "Past Plan",
    consultantProfile: {
      /* Fill with valid profile data */
    } as any,
    topics: [],
    classContents: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    description: null,
    price: 0,
    language: "en",
    level: "BEGINNER",
    prerequisites: null,
    materialProvided: null,
    learningOutcomes: [],
    consultantProfileId: "cp-past",
    durationInHours: 1,
    // Add other required fields from prisma schema if necessary
    priceCurrency: "INR", // Added
    certificateProvided: false, // Added
    durationInMonths: 1, // Added
    sessionsPerWeek: 1, // Added
    videoMeetings: 1, // Added
    emailSupport: "GENERAL", // Added
    maxParticipants: 1, // Added
  } as any, // Keep as any for now
  appointments: [
    {
      id: "past-appt",
      appointmentType: "CLASS",
      payment: [],
      slotsOfAppointment: [
        {
          id: "past-slot-1",
          startsAt: new Date("2024-11-01T10:00:00Z"),
          endsAt: new Date("2024-11-01T11:00:00Z"),
          isTentative: false,
          appointmentId: "past-appt",
          createdAt: new Date(),
          updatedAt: new Date(),
          user: [],
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
      consultationId: null,
      subscriptionId: null,
      webinarId: null,
      classId: "past-class",
    },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
  // Add other required top-level Class fields from EventWithType if known
  startDate: null, // Added
  endDate: null, // Added
  recordingUrls: [], // Added
  feedbackSummary: null, // Added
  classPlanId: "past-plan", // Added
} as unknown as EventWithType; // Use unknown cast if EventWithType is complex union

// New Mock Data for eventWithoutSlots
export const eventWithoutSlots: EventWithType = {
  id: "no-slots-event",
  type: "Consultation",
  status: "PENDING",
  consultationPlan: {
    id: "plan-noslot",
    title: "No Slot Plan",
    consultantProfile: {} as any,
    createdAt: new Date(),
    updatedAt: new Date(),
    description: null,
    price: 0,
    consultantProfileId: "cp-noslot",
    durationInHours: 1,
    language: "en",
    level: "BEGINNER",
    prerequisites: null,
    materialProvided: null,
    learningOutcomes: [],
  } as any,
  appointment: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  requestedBy: {
    id: "consultee-noslot",
    userId: "user-noslot",
    user: {} as any,
  } as any,
  requestedAt: new Date(),
  // Add missing Consultation fields
  consultationPlanId: "plan-noslot", // Added
  requestedById: "consultee-noslot", // Added
  requestNotes: null, // Added
  bookingSource: "REQUEST_SUBMITTED", // Added
  feedbackFromConsultee: null, // Added
  feedbackFromConsultant: null, // Added
  rating: null, // Added
} as unknown as EventWithType; // Use unknown cast if EventWithType is complex union
