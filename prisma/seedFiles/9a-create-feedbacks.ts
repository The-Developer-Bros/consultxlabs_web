import { faker } from "@faker-js/faker";
import { FeedbackStatus } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";

// Feedback categories
const FEEDBACK_CATEGORIES = [
  "Bug Report",
  "Feature Request",
  "General",
  "UI/UX",
  "Performance",
];

// Status distribution: 40% PENDING, 20% ACKNOWLEDGED, 20% IN_PROGRESS, 15% RESOLVED, 5% CLOSED
const STATUS_WEIGHTS: { status: FeedbackStatus; weight: number }[] = [
  { status: "PENDING", weight: 40 },
  { status: "ACKNOWLEDGED", weight: 20 },
  { status: "IN_PROGRESS", weight: 20 },
  { status: "RESOLVED", weight: 15 },
  { status: "CLOSED", weight: 5 },
];

// Feedback templates by category
const FEEDBACK_TEMPLATES: Record<
  string,
  { titles: string[]; descriptions: string[] }
> = {
  "Bug Report": {
    titles: [
      "Login page not loading properly",
      "Calendar sync issues with Google Calendar",
      "Payment failed but money was deducted",
      "Video call drops after 30 minutes",
      "Notifications not appearing on mobile",
      "Profile picture not uploading",
      "Search results not filtering correctly",
      "Email notifications arriving late",
      "Chat messages not syncing",
      "Scheduling conflicts not detected",
    ],
    descriptions: [
      "When I try to access the login page on Safari, it shows a blank screen. This has been happening for the past 2 days. I've tried clearing cache and cookies but the issue persists.",
      "My appointments are not syncing with my Google Calendar. I've reconnected the integration multiple times but new bookings don't appear in my calendar.",
      "I attempted to book a consultation session and the payment showed as failed, but I can see the charge on my bank statement. Please investigate and refund if needed.",
      "During my consultation calls, the video connection drops consistently after about 30 minutes. My internet connection is stable (tested with other video platforms).",
      "I'm not receiving push notifications on my iPhone even though they're enabled in settings. I've reinstalled the app but the issue continues.",
    ],
  },
  "Feature Request": {
    titles: [
      "Add dark mode support",
      "Enable group consultation sessions",
      "Add calendar export to Outlook",
      "Implement session recording",
      "Add multiple timezone support",
      "Enable recurring appointment booking",
      "Add payment plan options",
      "Show seats remaining on event cards",
      "Add consultant comparison feature",
      "Enable session notes sharing",
    ],
    descriptions: [
      "It would be great to have a dark mode option for the dashboard. Many of us work late hours and the bright interface can be straining on the eyes.",
      "Please consider adding support for group consultation sessions. This would allow consultants to host sessions with multiple consultees at once, which would be more cost-effective.",
      "While Google Calendar integration works well, many enterprise users prefer Outlook. Adding Outlook calendar integration would greatly improve the experience for corporate users.",
      "Having the ability to record sessions (with consent) would be incredibly valuable for revisiting advice and recommendations shared during consultations.",
      "As someone who works with international clients, having better timezone support with automatic conversion would save a lot of confusion when booking appointments.",
    ],
  },
  General: {
    titles: [
      "Great experience overall",
      "Suggestion for onboarding process",
      "Question about subscription plans",
      "Feedback on recent updates",
      "Appreciation for customer support",
      "Thoughts on the new dashboard",
      "Comments on the booking flow",
      "Feedback on consultant profiles",
      "General platform feedback",
      "User experience observations",
    ],
    descriptions: [
      "I've been using the platform for 3 months now and wanted to share my overall positive experience. The consultant matching has been excellent and I've learned so much.",
      "The onboarding process could be more streamlined. Consider adding a progress indicator and allowing users to skip optional steps to complete setup faster.",
      "I'm confused about the difference between the monthly and quarterly subscription plans. Could you clarify what additional benefits come with longer commitments?",
      "The recent dashboard update is a significant improvement! The new layout is much more intuitive and I can find everything I need much faster now.",
      "I want to commend your customer support team. They resolved my issue within hours and were extremely professional and helpful throughout the process.",
    ],
  },
  "UI/UX": {
    titles: [
      "Navigation menu is confusing",
      "Mobile layout needs improvement",
      "Color contrast issues",
      "Button placement suggestions",
      "Form field improvements needed",
      "Dashboard widget suggestions",
      "Search interface feedback",
      "Profile page redesign thoughts",
      "Booking flow UX improvements",
      "Accessibility concerns",
    ],
    descriptions: [
      "The navigation menu has too many nested levels. It takes too many clicks to reach commonly used features. Consider flattening the menu structure.",
      "On mobile devices, some buttons are too small to tap accurately. The responsive design could use some attention, especially for the booking calendar.",
      "Some text has poor contrast against the background, making it difficult to read. This is particularly noticeable in the consultant cards on the explore page.",
      "The 'Book Now' button on consultant profiles is below the fold. Moving it higher would make the booking process more intuitive for new users.",
      "The date picker for scheduling is hard to use on mobile. Consider using a native date picker or a more touch-friendly design.",
    ],
  },
  Performance: {
    titles: [
      "Page load times are slow",
      "Dashboard takes too long to load",
      "Search results delayed",
      "Video quality issues",
      "App crashes frequently",
      "Slow image loading",
      "Calendar view performance",
      "Chat latency issues",
      "Notification delays",
      "Mobile app sluggish",
    ],
    descriptions: [
      "Page load times have increased significantly over the past week. The dashboard now takes 5-7 seconds to fully load, compared to 2-3 seconds before.",
      "When I have many appointments, the dashboard becomes very slow. It seems like all data is being loaded at once rather than being paginated.",
      "Search results take 3-4 seconds to appear, which feels sluggish. The search experience could benefit from instant search or better caching.",
      "Video quality during consultations is inconsistent. Sometimes it's crystal clear, other times it's very pixelated even though my internet speed is good.",
      "The mobile app crashes about once per day, usually when switching between tabs quickly. This started happening after the last update.",
    ],
  },
};

function getWeightedStatus(): FeedbackStatus {
  const totalWeight = STATUS_WEIGHTS.reduce(
    (sum, item) => sum + item.weight,
    0,
  );
  let random = faker.number.int({ min: 1, max: totalWeight });

  for (const item of STATUS_WEIGHTS) {
    random -= item.weight;
    if (random <= 0) {
      return item.status;
    }
  }
  return "PENDING";
}

function generateFeedbackData(category: string) {
  const templates = FEEDBACK_TEMPLATES[category];
  const title = faker.helpers.arrayElement(templates.titles);
  const description = faker.helpers.arrayElement(templates.descriptions);

  // Rating weighted towards 4-5 for general/feature requests, lower for bugs
  let rating: number | null = null;
  if (faker.datatype.boolean({ probability: 0.7 })) {
    if (category === "Bug Report" || category === "Performance") {
      rating = faker.helpers.weightedArrayElement([
        { value: 1, weight: 10 },
        { value: 2, weight: 20 },
        { value: 3, weight: 30 },
        { value: 4, weight: 25 },
        { value: 5, weight: 15 },
      ]);
    } else {
      rating = faker.helpers.weightedArrayElement([
        { value: 1, weight: 5 },
        { value: 2, weight: 10 },
        { value: 3, weight: 20 },
        { value: 4, weight: 35 },
        { value: 5, weight: 30 },
      ]);
    }
  }

  return { title, description, rating };
}

import { config } from "./config";

// Feedback volume - configurable via SEED_MODE environment variable
const NUM_FEEDBACKS = config.volumes.feedbacks;

export async function createFeedbacks(
  users: UserWithProfiles[],
): Promise<void> {
  console.log(`Creating ${NUM_FEEDBACKS} feedback entries...`);

  // Filter to users who can submit feedback (consultees and consultants)
  const eligibleUsers = users.filter(
    (user) => user.role === "CONSULTEE" || user.role === "CONSULTANT",
  );

  if (eligibleUsers.length === 0) {
    console.warn("No eligible users found for feedback creation");
    return;
  }

  let created = 0;

  for (let i = 0; i < NUM_FEEDBACKS; i++) {
    try {
      const user = faker.helpers.arrayElement(eligibleUsers);
      const category = faker.helpers.arrayElement(FEEDBACK_CATEGORIES);
      const { title, description, rating } = generateFeedbackData(category);
      const status = getWeightedStatus();

      await prisma.feedback.create({
        data: {
          title,
          description,
          rating,
          category,
          status,
          userId: user.id,
          createdAt: faker.date.recent({ days: 60 }),
        },
      });

      created++;
      if (created % 10 === 0) {
        console.log(`Created ${created} feedbacks...`);
      }
    } catch (error) {
      console.error(`Failed to create feedback ${i + 1}:`, error);
    }
  }

  console.log(`Created ${created} feedback entries`);
}
