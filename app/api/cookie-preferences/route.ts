/**
 * GET /api/cookie-preferences — read the caller's saved consent.
 * PUT /api/cookie-preferences — persist granular consent (#381).
 *
 * Works for authenticated users (userId-keyed) and anonymous visitors
 * (sessionId via a cookie set on first save). The model existed since the
 * MVP but had zero writers — this route closes that gap (#1230 wave-6a).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { cookies } from "next/headers";

const SESSION_COOKIE = "cp_sid";

const PrefsSchema = z.object({
  analytics: z.boolean(),
  marketing: z.boolean(),
  functional: z.boolean(),
});

async function resolveIdentity(): Promise<{
  userId: string | null;
  sessionId: string | null;
}> {
  const session = await getSession();
  if (session?.user?.id) return { userId: session.user.id, sessionId: null };

  const jar = await cookies();
  let sid = jar.get(SESSION_COOKIE)?.value ?? null;
  if (!sid) {
    sid = crypto.randomUUID();
    try {
      jar.set(SESSION_COOKIE, sid, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    } catch {
      // Read-only cookie context (server component render) — skip.
    }
  }
  return { userId: null, sessionId: sid };
}

export async function GET() {
  const { userId, sessionId } = await resolveIdentity();
  if (!userId && !sessionId) {
    return NextResponse.json({ error: "No identity" }, { status: 401 });
  }

  const pref = await prisma.cookiePreference.findFirst({
    where: userId ? { userId } : { sessionId },
    select: { essential: true, analytics: true, marketing: true, functional: true },
  });

  return NextResponse.json(
    pref ?? { essential: true, analytics: false, marketing: false, functional: false },
  );
}

export async function PUT(req: NextRequest) {
  const parsed = PrefsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { userId, sessionId } = await resolveIdentity();
  if (!userId && !sessionId) {
    return NextResponse.json({ error: "No identity" }, { status: 401 });
  }

  const identity = userId ? { userId } : { sessionId };
  const data = { ...identity, ...parsed.data };

  await prisma.cookiePreference.upsert({
    where: userId ? { userId } : { sessionId: sessionId! },
    create: data,
    update: parsed.data,
  });

  return NextResponse.json({ ok: true });
}
