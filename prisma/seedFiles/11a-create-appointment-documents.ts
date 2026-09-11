import { faker } from "@faker-js/faker";
import { DocumentReviewStatus } from "@prisma/client";
import prisma from "../../lib/prisma";

// Document types with associated details
const DOCUMENT_TYPES = [
  {
    type: "Resume",
    descriptions: [
      "My current resume for career review",
      "Updated CV for job search guidance",
      "Professional resume for feedback",
    ],
    mimeTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    extensions: ["pdf", "docx"],
    sizeRange: { min: 50000, max: 500000 }, // 50KB - 500KB
  },
  {
    type: "ITR",
    descriptions: [
      "Income Tax Return for financial consultation",
      "Tax documents for review",
      "ITR form for tax planning session",
    ],
    mimeTypes: ["application/pdf"],
    extensions: ["pdf"],
    sizeRange: { min: 100000, max: 2000000 }, // 100KB - 2MB
  },
  {
    type: "Legal Document",
    descriptions: [
      "Contract for legal review",
      "Agreement document for consultation",
      "Legal paperwork requiring expert opinion",
    ],
    mimeTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    extensions: ["pdf", "docx"],
    sizeRange: { min: 100000, max: 3000000 }, // 100KB - 3MB
  },
  {
    type: "Portfolio",
    descriptions: [
      "Design portfolio for career guidance",
      "Work samples for review",
      "Creative portfolio for feedback",
    ],
    mimeTypes: ["application/pdf", "image/png", "image/jpeg"],
    extensions: ["pdf", "png", "jpg"],
    sizeRange: { min: 500000, max: 5000000 }, // 500KB - 5MB
  },
  {
    type: "Contract",
    descriptions: [
      "Employment contract for review",
      "Business agreement for consultation",
      "Service contract needing expert input",
    ],
    mimeTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    extensions: ["pdf", "docx"],
    sizeRange: { min: 50000, max: 1000000 }, // 50KB - 1MB
  },
  {
    type: "Certificate",
    descriptions: [
      "Professional certification for verification",
      "Educational certificate for profile",
      "Training completion certificate",
    ],
    mimeTypes: ["application/pdf", "image/png", "image/jpeg"],
    extensions: ["pdf", "png", "jpg"],
    sizeRange: { min: 50000, max: 500000 }, // 50KB - 500KB
  },
];

// Status distribution: 50% PENDING, 15% IN_REVIEW, 20% APPROVED, 10% REJECTED, 5% NEEDS_REVISION
const STATUS_WEIGHTS: { status: DocumentReviewStatus; weight: number }[] = [
  { status: "PENDING", weight: 50 },
  { status: "IN_REVIEW", weight: 15 },
  { status: "APPROVED", weight: 20 },
  { status: "REJECTED", weight: 10 },
  { status: "NEEDS_REVISION", weight: 5 },
];

// Review notes templates
const REVIEW_NOTES = {
  APPROVED: [
    "Document reviewed and approved. All information is clear and complete.",
    "Approved. Well-formatted and contains all necessary details.",
    "Document meets requirements. Ready for consultation.",
    "Reviewed and accepted. No issues found.",
  ],
  REJECTED: [
    "Document is unreadable. Please upload a clearer version.",
    "File appears to be corrupted. Please re-upload.",
    "This document type is not accepted. Please upload in PDF format.",
    "Document is incomplete. Missing required sections.",
  ],
  NEEDS_REVISION: [
    "Please update the document with your current contact information.",
    "Some sections are outdated. Please revise and resubmit.",
    "Formatting needs improvement. Consider using the provided template.",
    "Additional details required in the experience section.",
  ],
  IN_REVIEW: [
    "Currently under review. Will update soon.",
    "Review in progress.",
  ],
};

function getWeightedStatus(): DocumentReviewStatus {
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

import { config } from "./config";

// Document volume - configurable via SEED_MODE environment variable
const NUM_DOCUMENTS = config.volumes.appointmentDocuments;

export async function createAppointmentDocuments(): Promise<void> {
  console.log(`Creating ${NUM_DOCUMENTS} appointment documents...`);

  // Get appointments that can have documents
  const appointments = await prisma.appointment.findMany({
    select: {
      id: true,
      consultation: {
        select: {
          consultationPlan: {
            select: {
              consultantProfile: {
                select: { userId: true },
              },
            },
          },
        },
      },
      subscription: {
        select: {
          subscriptionPlan: {
            select: {
              consultantProfile: {
                select: { userId: true },
              },
            },
          },
        },
      },
    },
    take: 200, // Get a good sample of appointments
  });

  if (appointments.length === 0) {
    console.warn("No appointments found for document creation");
    return;
  }

  let created = 0;

  for (let i = 0; i < NUM_DOCUMENTS; i++) {
    try {
      const appointment = faker.helpers.arrayElement(appointments);
      const docType = faker.helpers.arrayElement(DOCUMENT_TYPES);
      const status = getWeightedStatus();

      const extension = faker.helpers.arrayElement(docType.extensions);
      const mimeType =
        docType.mimeTypes.find(
          (m) =>
            m.includes(extension) ||
            (extension === "jpg" && m.includes("jpeg")),
        ) || docType.mimeTypes[0];

      const fileName = `${docType.type.toLowerCase().replace(/\s+/g, "_")}_${faker.string.alphanumeric(8)}.${extension}`;
      const originalName = `${faker.person.lastName()}_${docType.type}.${extension}`;
      const fileSize = faker.number.int(docType.sizeRange);

      // Static placeholder URL as per user preference
      const fileUrl = `https://placeholder.com/documents/${fileName}`;
      const storagePath = `documents/appointments/${appointment.id}/${fileName}`;

      // Get consultant user ID for reviewed documents
      let reviewedBy: string | null = null;
      let reviewedAt: Date | null = null;
      let reviewNotes: string | null = null;

      if (status !== "PENDING") {
        // Get the consultant ID from the appointment
        const consultantUserId =
          appointment.consultation?.consultationPlan?.consultantProfile
            ?.userId ||
          appointment.subscription?.subscriptionPlan?.consultantProfile?.userId;

        if (consultantUserId && status !== "IN_REVIEW") {
          reviewedBy = consultantUserId;
          reviewedAt = faker.date.recent({ days: 14 });
        }

        if (status in REVIEW_NOTES) {
          reviewNotes = faker.helpers.arrayElement(
            REVIEW_NOTES[status as keyof typeof REVIEW_NOTES],
          );
        }
      }

      await prisma.appointmentDocument.create({
        data: {
          fileName,
          originalName,
          fileSize,
          mimeType,
          fileUrl,
          storagePath,
          description: faker.helpers.arrayElement(docType.descriptions),
          reviewStatus: status,
          reviewNotes,
          reviewedAt,
          reviewedById: reviewedBy, // A8 — FK scalar (#676)
          appointmentId: appointment.id,
          uploadedAt: faker.date.recent({ days: 30 }),
        },
      });

      created++;
      if (created % 20 === 0) {
        console.log(`Created ${created} appointment documents...`);
      }
    } catch (error) {
      console.error(`Failed to create document ${i + 1}:`, error);
    }
  }

  console.log(`Created ${created} appointment documents`);
}
