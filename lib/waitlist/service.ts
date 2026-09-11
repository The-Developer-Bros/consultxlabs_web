/**
 * Newsletter subscription service.
 *
 * Double opt-in: a signup lands as PENDING and only becomes SUBSCRIBED after
 * the confirm link is clicked. Nothing here throws on a bad email or a repeat
 * signup — the public route must stay enumeration-safe, so callers get a
 * result object and render the same copy either way.
 */

import * as Sentry from "@sentry/nextjs";
import { createHash } from "node:crypto";
import { Prisma, WaitlistSource, WaitlistStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  sendWaitlistConfirmEmail,
  sendWaitlistWelcomeEmail,
} from "@/lib/email";
import {
  canSignLinks,
  verifyConfirmToken,
  verifyUnsubscribeToken,
} from "./tokens";

export type SubscribeInput = {
  email: string;
  name?: string | null;
  source?: WaitlistSource;
  tags?: string[];
  userId?: string | null;
  /** Raw request IP — hashed before it touches the database. */
  ip?: string | null;
  userAgent?: string | null;
};

export type SubscribeResult =
  | { outcome: "CONFIRMATION_SENT" }
  | { outcome: "ALREADY_SUBSCRIBED" }
  /** Row is on the list as PENDING but the confirmation could not be sent. */
  | { outcome: "CONFIRMATION_FAILED" };

/**
 * Consent proof without storing a raw IP. Salted with the HMAC secret when
 * present so the digest isn't reversible from a rainbow table of v4 space.
 */
function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256")
    .update(`${process.env.WAITLIST_HMAC_SECRET ?? "waitlist"}|${ip}`)
    .digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Upsert the address into the list and send a confirmation.
 *
 * A previously unsubscribed address goes back to PENDING rather than straight
 * to SUBSCRIBED: re-consent has to be a fresh click, not a side effect of
 * someone re-entering an address.
 */
export async function subscribe(
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const email = normalizeEmail(input.email);
  const now = new Date();

  // Checked before the membership lookup, deliberately. If this ran after the
  // ALREADY_SUBSCRIBED short-circuit, a signing outage would answer 200 for
  // subscribed addresses and fail for everyone else — letting a caller probe
  // membership by status code. Config health must not depend on the address.
  if (!canSignLinks()) {
    Sentry.captureMessage("waitlist signing key unavailable", {
      level: "error",
      tags: { subsystem: "waitlist" },
    });
    return { outcome: "CONFIRMATION_FAILED" };
  }

  const existing = await prisma.waitlist.findUnique({
    where: { email },
    select: { status: true },
  });

  if (existing?.status === WaitlistStatus.SUBSCRIBED) {
    return { outcome: "ALREADY_SUBSCRIBED" };
  }

  const consent = {
    consentIpHash: hashIp(input.ip),
    consentUserAgent: input.userAgent?.slice(0, 500) ?? null,
  };

  await prisma.waitlist.upsert({
    where: { email },
    create: {
      email,
      name: input.name ?? null,
      status: WaitlistStatus.PENDING,
      source: input.source ?? WaitlistSource.FOOTER,
      tags: input.tags ?? [],
      userId: input.userId ?? null,
      ...consent,
    },
    update: {
      status: WaitlistStatus.PENDING,
      unsubscribedAt: null,
      confirmedAt: null,
      // A re-signup from a different surface retags the row; the original
      // source is not worth preserving once someone opts in again.
      ...(input.source ? { source: input.source } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      ...consent,
    },
  });

  const sent = await sendWaitlistConfirmEmail({
    email,
    name: input.name ?? null,
    issuedAt: now.getTime(),
  });

  if (!sent.success) {
    // The row is written and the address is on the list; only the email
    // failed. Report it rather than claiming a confirmation went out — the
    // subscriber is otherwise stuck at PENDING with no way to advance.
    // The reason is carried through so every failure isn't one flat warning;
    // neither the address nor the signed link is included.
    const reason = sent.error;
    if (reason instanceof Error) {
      Sentry.captureException(reason, {
        level: "warning",
        tags: { subsystem: "waitlist" },
      });
    } else {
      Sentry.captureMessage(
        `waitlist confirmation email failed to send: ${String(reason)}`,
        { level: "warning", tags: { subsystem: "waitlist" } },
      );
    }
    return { outcome: "CONFIRMATION_FAILED" };
  }

  return { outcome: "CONFIRMATION_SENT" };
}

export type ConfirmResult =
  | { outcome: "CONFIRMED" }
  | { outcome: "ALREADY_CONFIRMED" }
  | { outcome: "INVALID" };

export async function confirmSubscription(params: {
  email: string;
  token: string;
  issuedAt: number;
}): Promise<ConfirmResult> {
  const email = normalizeEmail(params.email);

  if (!verifyConfirmToken(email, params.token, params.issuedAt)) {
    return { outcome: "INVALID" };
  }

  const existing = await prisma.waitlist.findUnique({
    where: { email },
    select: { status: true, name: true },
  });
  if (!existing) return { outcome: "INVALID" };
  if (existing.status === WaitlistStatus.SUBSCRIBED) {
    return { outcome: "ALREADY_CONFIRMED" };
  }

  await prisma.waitlist.update({
    where: { email },
    data: {
      status: WaitlistStatus.SUBSCRIBED,
      confirmedAt: new Date(),
      unsubscribedAt: null,
    },
  });

  await sendWaitlistWelcomeEmail({ email, name: existing.name });

  return { outcome: "CONFIRMED" };
}

/**
 * Always reports success. An unsubscribe endpoint that distinguished "you were
 * on the list" from "you were not" would leak membership to anyone holding a
 * valid token for a guessed address.
 */
export async function unsubscribe(params: {
  email: string;
  token: string;
}): Promise<{ ok: boolean }> {
  const email = normalizeEmail(params.email);

  if (!verifyUnsubscribeToken(email, params.token)) {
    return { ok: false };
  }

  await prisma.waitlist.updateMany({
    where: { email, status: { not: WaitlistStatus.UNSUBSCRIBED } },
    data: {
      status: WaitlistStatus.UNSUBSCRIBED,
      unsubscribedAt: new Date(),
    },
  });

  return { ok: true };
}

export type SubscriberFilters = {
  status?: WaitlistStatus;
  source?: WaitlistSource;
  search?: string;
  page?: number;
  perPage?: number;
};

function buildWhere(filters: SubscriberFilters): Prisma.WaitlistWhereInput {
  return {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.search
      ? {
          OR: [
            {
              email: { contains: filters.search, mode: "insensitive" as const },
            },
            {
              name: { contains: filters.search, mode: "insensitive" as const },
            },
          ],
        }
      : {}),
  };
}

export async function listSubscribers(filters: SubscriberFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 50));
  const where = buildWhere(filters);

  const [items, total, byStatus] = await prisma.$transaction([
    prisma.waitlist.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        source: true,
        tags: true,
        confirmedAt: true,
        unsubscribedAt: true,
        createdAt: true,
      },
    }),
    prisma.waitlist.count({ where }),
    prisma.waitlist.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const stats = Object.fromEntries(
    Object.values(WaitlistStatus).map((status) => [
      status,
      byStatus.find((row) => row.status === status)?._count._all ?? 0,
    ]),
  ) as Record<WaitlistStatus, number>;

  return { items, total, page, perPage, stats };
}

/** Addresses a broadcast may go to. */
export async function listSendableSubscribers() {
  return prisma.waitlist.findMany({
    where: { status: WaitlistStatus.SUBSCRIBED },
    select: { email: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

function csvCell(value: string | null | undefined = ""): string {
  const raw = value ?? "";
  // Guard against a leading =, +, - or @ being interpreted as a formula when
  // the export is opened in a spreadsheet.
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function exportSubscribersCsv(
  filters: SubscriberFilters,
): Promise<string> {
  const rows = await prisma.waitlist.findMany({
    where: buildWhere(filters),
    orderBy: { createdAt: "desc" },
    select: {
      email: true,
      name: true,
      status: true,
      source: true,
      tags: true,
      confirmedAt: true,
      unsubscribedAt: true,
      createdAt: true,
    },
  });

  const header = [
    "email",
    "name",
    "status",
    "source",
    "tags",
    "confirmedAt",
    "unsubscribedAt",
    "createdAt",
  ].join(",");

  const body = rows.map((row) =>
    [
      csvCell(row.email),
      csvCell(row.name),
      csvCell(row.status),
      csvCell(row.source),
      csvCell(row.tags.join(" ")),
      csvCell(row.confirmedAt?.toISOString()),
      csvCell(row.unsubscribedAt?.toISOString()),
      csvCell(row.createdAt.toISOString()),
    ].join(","),
  );

  return [header, ...body].join("\n");
}
