/**
 * Staff Moderation Reviews API
 * List consultant reviews for moderation
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
/**
 * GET /api/staff/moderation/reviews
 * List reviews (optionally filtered)
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const consultantProfileId = searchParams.get("consultantProfileId");
    const minRating = searchParams.get("minRating");
    const maxRating = searchParams.get("maxRating");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    const where: Prisma.ConsultantReviewWhereInput = {};

    if (consultantProfileId) {
      where.consultantProfileId = consultantProfileId;
    }
    if (minRating || maxRating) {
      where.rating = {
        ...(minRating && { gte: parseInt(minRating) }),
        ...(maxRating && { lte: parseInt(maxRating) }),
      };
    }

    const [reviews, total] = await Promise.all([
      prisma.consultantReview.findMany({
        where,
        include: {
          consultantProfile: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
          consulteeProfile: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.consultantReview.count({ where }),
    ]);

    const formattedReviews = reviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      reviewDescription: review.reviewDescription,
      consultant: {
        profileId: review.consultantProfile.id,
        name: review.consultantProfile.user.name,
        email: review.consultantProfile.user.email,
        image: review.consultantProfile.user.image,
      },
      reviewer: {
        profileId: review.consulteeProfile.id,
        name: review.consulteeProfile.user.name,
        email: review.consulteeProfile.user.email,
        image: review.consulteeProfile.user.image,
      },
      createdAt: review.createdAt,
      // #1300 — this queue deliberately does NOT filter `deletedAt`, so staff see
      // removed rows; it then projected neither `deletedAt` nor `isAnonymous`, so
      // a removed review was indistinguishable from a live one and an anonymous
      // author from a named one — on the one surface whose whole job is telling
      // them apart. `editedAt` is here for the same reason: a review that has
      // been rewritten since it was reported is a different review.
      deletedAt: review.deletedAt,
      isAnonymous: review.isAnonymous,
      editedAt: review.editedAt,
    }));

    // Get rating distribution.
    // #1300 — the SAME population as the list, from the same `where`. It had no
    // `where` at all, and scoping it to live rows only half-fixed that: the list
    // applies `consultantProfileId` and the rating bounds and deliberately does not
    // filter `deletedAt`, so a filtered queue still showed a histogram of a
    // different population. Two numbers on one screen have to count the same rows,
    // and on this screen that includes the removed ones — telling them apart is
    // what the queue is for.
    const ratingDistribution = await prisma.consultantReview.groupBy({
      by: ["rating"],
      where,
      _count: { id: true },
    });

    const distribution = Object.fromEntries(
      ratingDistribution.map((r) => [r.rating, r._count.id]),
    );

    return NextResponse.json({
      reviews: formattedReviews,
      distribution,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error("Error fetching reviews:", error);
    return NextResponse.json(
      { error: "Failed to fetch reviews" },
      { status: 500 },
    );
  }
}
