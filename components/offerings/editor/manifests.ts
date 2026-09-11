/**
 * The four offering manifests.
 *
 * Read this file as a diff between the types. Everything the four share is a
 * shared constant, so a change to Basics or Positioning lands on all four at
 * once and cannot be applied to three of them by accident — which is exactly
 * how imageUrl ended up on two forms out of four.
 */

import {
  BookOpen,
  CalendarRange,
  FileText,
  IndianRupee,
  Layers,
  MessageSquareQuote,
} from "lucide-react";
import type { OfferingManifest, SectionSpec } from "./manifest";

/** Identity and framing. Identical for all four types. */
const basicsSection = (noun: string): SectionSpec => ({
  id: "basics",
  title: "Basics",
  description: `What this ${noun} is and who it is for.`,
  icon: FileText,
  fields: [
    {
      name: "title",
      kind: "text",
      label: "Title",
      placeholder: `e.g. Career strategy ${noun}`,
      span: 6,
    },
    {
      name: "subtitle",
      kind: "text",
      label: "Subtitle",
      description: "One line that appears under the title.",
      span: 6,
    },
    {
      name: "description",
      kind: "textarea",
      label: "Description",
      placeholder: `Describe what someone gets from this ${noun}.`,
      span: 6,
    },
    {
      // All four Prisma models carry imageUrl; only webinar and class ever
      // rendered an uploader, so consultation and subscription could never
      // have a cover image at all.
      name: "imageUrl",
      kind: "image",
      label: "Cover image",
      description: "Shown on the offering card and detail page.",
      span: 6,
    },
    { name: "languageLevel", kind: "languageLevel", label: "", span: 6 },
    {
      name: "topics",
      kind: "stringList",
      label: "Topics",
      itemNoun: "topics",
      maxItems: 10,
      description: "Helps people find this in search.",
      span: 6,
    },
  ],
});

/** Everything an offering promises. Identical for all four types. */
const contentSection = (noun: string): SectionSpec => ({
  id: "content",
  title: "Content",
  description: `What someone learns or receives from this ${noun}.`,
  icon: BookOpen,
  fields: [
    {
      name: "learningOutcomes",
      kind: "learningOutcomes",
      label: "Learning outcomes",
      maxItems: 10,
      span: 6,
    },
    {
      name: "prerequisites",
      kind: "textarea",
      label: "Prerequisites",
      description: "What someone should already know. Leave blank if none.",
      span: 3,
    },
    {
      name: "materialProvided",
      kind: "textarea",
      label: "Material provided",
      description: "Anything they take away.",
      span: 3,
    },
    {
      name: "targetAudience",
      kind: "stringList",
      label: "Who this is for",
      itemNoun: "audiences",
      maxItems: 6,
      span: 3,
    },
    {
      name: "whatsIncluded",
      kind: "stringList",
      label: "What's included",
      itemNoun: "items",
      maxItems: 10,
      span: 3,
    },
  ],
});

/** Buyer questions. Identical for all four types; rendered by the FAQ editor. */
const faqSection: SectionSpec = {
  id: "faq",
  title: "FAQ",
  description: "Answer the questions people ask before buying.",
  icon: MessageSquareQuote,
  fields: [],
  slot: "faq",
};

/**
 * Group events only.
 *
 * The collaborator model (co-host, moderator, teaching assistant) exists for
 * webinars and classes and nowhere else — CollaboratorsTab's own planType is
 * `"webinar" | "class"`. Offering the section on a consultation would render an
 * empty panel promising something the data model cannot store.
 */
const collaboratorsSection: SectionSpec = {
  id: "collaborators",
  title: "Collaborators",
  description: "Other experts delivering alongside you.",
  icon: Layers,
  fields: [],
  slot: "collaborators",
};

const supportLevelField = {
  name: "emailSupport",
  kind: "select" as const,
  label: "Email support",
  span: 2 as const,
  options: [
    { value: "GENERAL", label: "General (48h response)" },
    { value: "PRIORITY", label: "Priority (24h response)" },
    { value: "DEDICATED", label: "Dedicated (same day)" },
  ],
};

/**
 * Recording and certification promises. Every model carries the recording
 * columns (#1134 P1-6 made them reachable for 1:1 types too); only webinar
 * and class can issue a certificate, so the toggle is opt-in per type.
 */
const extrasSection = (withCertificate: boolean): SectionSpec => ({
  id: "extras",
  title: "Extras",
  description: "Recordings and certificates.",
  fields: [
    {
      name: "recordingEnabled",
      kind: "switch",
      label: "Record sessions",
      description: "Sessions are recorded for attendees to revisit.",
      span: 3,
    },
    {
      // Always rendered rather than shown only when recording is on — the
      // renderer cannot express field dependencies, and choosing a policy
      // before enabling is harmless.
      name: "recordingStoragePolicy",
      kind: "select",
      label: "Recording storage",
      span: 3,
      options: [
        { value: "STREAM_ONLY", label: "Stream only" },
        { value: "PERMANENT", label: "Permanent library" },
      ],
    },
    ...(withCertificate
      ? [
          {
            name: "certificateProvided",
            kind: "switch" as const,
            label: "Provide a certificate",
            description: "Attendees receive a completion certificate.",
            span: 3 as const,
          },
        ]
      : []),
  ],
});

export const CONSULTATION_MANIFEST: OfferingManifest = {
  type: "consultation",
  noun: "consultation",
  sections: [
    basicsSection("consultation"),
    {
      id: "pricing",
      title: "Pricing",
      icon: IndianRupee,
      fields: [
        {
          name: "price",
          kind: "price",
          label: "Price (₹)",
          currencyName: "priceCurrency",
          span: 3,
        },
        {
          name: "durationInHours",
          kind: "number",
          label: "Duration (hours)",
          min: 0.5,
          step: 0.5,
          span: 3,
        },
      ],
    },
    contentSection("consultation"),
    extrasSection(false),
    faqSection,
  ],
};

export const SUBSCRIPTION_MANIFEST: OfferingManifest = {
  type: "subscription",
  noun: "subscription",
  sections: [
    basicsSection("subscription"),
    {
      id: "pricing",
      title: "Pricing & cadence",
      icon: IndianRupee,
      fields: [
        {
          name: "price",
          kind: "price",
          label: "Price (₹)",
          currencyName: "priceCurrency",
          span: 2,
        },
        {
          name: "durationInMonths",
          kind: "number",
          label: "Duration (months)",
          min: 1,
          step: 1,
          span: 2,
        },
        {
          name: "sessionsPerWeek",
          kind: "number",
          label: "Sessions per week",
          min: 1,
          max: 7,
          step: 1,
          span: 2,
        },
        {
          name: "sessionDurationInHours",
          kind: "number",
          label: "Session duration (hours)",
          min: 0.5,
          step: 0.5,
          span: 2,
        },
        supportLevelField,
      ],
    },
    contentSection("subscription"),
    extrasSection(false),
    {
      id: "roadmap",
      title: "Session roadmap",
      description: "What each session covers.",
      icon: CalendarRange,
      fields: [],
      slot: "roadmap",
    },
    faqSection,
  ],
};

export const WEBINAR_MANIFEST: OfferingManifest = {
  type: "webinar",
  noun: "webinar",
  sections: [
    basicsSection("webinar"),
    {
      id: "pricing",
      title: "Pricing & capacity",
      icon: IndianRupee,
      fields: [
        {
          name: "price",
          kind: "price",
          label: "Price (₹)",
          currencyName: "priceCurrency",
          span: 2,
        },
        {
          name: "durationInHours",
          kind: "number",
          label: "Duration (hours)",
          min: 0.5,
          step: 0.5,
          span: 2,
        },
        {
          name: "maxParticipants",
          kind: "number",
          label: "Max participants",
          min: 1,
          step: 1,
          span: 2,
        },
      ],
    },
    contentSection("webinar"),
    extrasSection(true),
    {
      id: "sessions",
      title: "Sessions",
      description: "A webinar goes live once it has a scheduled time.",
      icon: CalendarRange,
      fields: [
        {
          // Required to publish. The old create path let an unparseable value
          // through and silently produced a webinar with no session at all.
          name: "scheduledAt",
          kind: "date",
          label: "Scheduled for",
          span: 3,
        },
      ],
    },
    collaboratorsSection,
    faqSection,
  ],
};

export const CLASS_MANIFEST: OfferingManifest = {
  type: "class",
  noun: "class",
  sections: [
    basicsSection("class"),
    {
      id: "pricing",
      title: "Pricing & cadence",
      icon: IndianRupee,
      fields: [
        {
          name: "price",
          kind: "price",
          label: "Price (₹)",
          currencyName: "priceCurrency",
          span: 2,
        },
        {
          name: "durationInMonths",
          kind: "number",
          label: "Duration (months)",
          min: 1,
          step: 1,
          span: 2,
        },
        {
          name: "maxParticipants",
          kind: "number",
          label: "Max participants",
          min: 1,
          step: 1,
          span: 2,
        },
        {
          name: "sessionsPerWeek",
          kind: "number",
          label: "Sessions per week",
          min: 1,
          max: 7,
          step: 1,
          span: 2,
        },
        {
          // Was hardcoded to 1 in the dialog and never rendered, so every class
          // was a one-hour-session class regardless of what its plan said.
          name: "sessionDurationInHours",
          kind: "number",
          label: "Session duration (hours)",
          min: 0.5,
          step: 0.5,
          span: 2,
        },
        supportLevelField,
      ],
    },
    contentSection("class"),
    extrasSection(true),
    {
      id: "sessions",
      title: "Sessions",
      description:
        "Pick a start date; sessions are generated from the cadence above.",
      icon: CalendarRange,
      fields: [
        {
          // Was plain useState outside the form, with a hand-rolled error
          // message and a manual guard, so nothing validated it.
          name: "schedulingStartDate",
          kind: "date",
          label: "Start date",
          span: 3,
        },
      ],
    },
    {
      id: "curriculum",
      title: "Curriculum",
      description: "What each session covers.",
      icon: CalendarRange,
      fields: [],
      slot: "curriculum",
    },
    collaboratorsSection,
    faqSection,
  ],
};

export const OFFERING_MANIFESTS = {
  consultation: CONSULTATION_MANIFEST,
  subscription: SUBSCRIPTION_MANIFEST,
  webinar: WEBINAR_MANIFEST,
  class: CLASS_MANIFEST,
} as const;
