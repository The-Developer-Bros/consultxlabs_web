import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/errors";
import { validateTagName } from "@/utils/contentValidation";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// ---------------------------------------------------------------------------
// GET /api/user/content/tags?domainId={id}
//
// Returns all tags, optionally filtered by domainId.
// Each tag includes its parent domain. Results are sorted alphabetically.
// ---------------------------------------------------------------------------

const GetTagsQuerySchema = z.object({
  domainId: z.string().uuid("Invalid domain ID").optional(),
});

export async function GET(request: NextRequest) {
  try {
    const parsed = GetTagsQuerySchema.safeParse({
      domainId: request.nextUrl.searchParams.get("domainId") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0].message },
        { status: 400 },
      );
    }

    const { domainId } = parsed.data;

    const tags = await prisma.tag.findMany({
      where: domainId ? { domainId } : undefined,
      include: { domain: { select: { id: true, name: true } } },
      orderBy: { name: "asc" },
    });

    return NextResponse.json(tags);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "user" } });
    return apiError({ tag: "[Tags.GET]", error });
  }
}

// ---------------------------------------------------------------------------
// POST /api/user/content/tags
//
// Upserts a custom tag for a given domain. If a tag with the same name
// already exists under that domain (unique constraint: name + domainId),
// the existing record is returned. Used by the consultant onboarding form
// for free-text tag creation.
// ---------------------------------------------------------------------------

const CreateTagSchema = z.object({
  name: z
    .string()
    .min(1, "Tag name is required")
    .max(100, "Tag name too long")
    .transform((s) => s.trim()),
  domainId: z.string().uuid("Invalid domain ID"),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = CreateTagSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0].message },
        { status: 400 },
      );
    }

    const { name, domainId } = parsed.data;

    // Validate tag name for format, gibberish, and profanity
    const validation = validateTagName(name);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 },
      );
    }

    // Verify domain exists before upserting
    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
    });
    if (!domain) {
      return NextResponse.json(
        { error: "Domain not found" },
        { status: 404 },
      );
    }

    const tag = await prisma.tag.upsert({
      where: { name_domainId: { name, domainId } },
      update: {},
      create: { name, domainId },
      select: { id: true, name: true, domainId: true },
    });

    return NextResponse.json({ tag });
  } catch (error) {
    return apiError({ tag: "[Tags.POST]", error });
  }
}
