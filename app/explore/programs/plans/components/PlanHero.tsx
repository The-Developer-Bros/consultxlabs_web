import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { cn } from "@/utils/tailwind";

export type PlanHeroStatusTone = "neutral" | "live" | "upcoming" | "done";

export interface PlanHeroProps {
  backHref: string;
  backLabel: string;
  /** The product family, e.g. "Class", "Webinar", "1:1 consultation". */
  kind: string;
  status?: { label: string; tone: PlanHeroStatusTone } | null;
  title: string;
  subtitle?: string | null;
  price: string;
  /** What the price buys, e.g. "for 3 months" or "per session". */
  priceNote: string;
  /** Cover image. Without one the band is a plain dark stage. */
  imageUrl?: string | null;
  host?: { name: string; image: string | null; href: string } | null;
}

const CHIP =
  "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium";

const STATUS_TONE: Record<PlanHeroStatusTone, string> = {
  neutral: "border-white/15 bg-white/10 text-white",
  live: "border-transparent bg-success text-success-foreground",
  upcoming: "border-transparent bg-white text-zinc-950",
  done: "border-white/10 bg-transparent text-zinc-400",
};

/**
 * The dark title band every plan detail page opens with.
 *
 * Class and webinar pages carry a cover image under a scrim; consultation and
 * subscription pages have no image and get the same band on a plain stage, so
 * the four products read as one family instead of two layouts.
 */
export function PlanHero({
  backHref,
  backLabel,
  kind,
  status,
  title,
  subtitle,
  price,
  priceNote,
  imageUrl,
  host,
}: Readonly<PlanHeroProps>) {
  return (
    <section className="relative overflow-hidden bg-zinc-950 text-white">
      {imageUrl ? (
        <>
          <Image
            src={imageUrl}
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover opacity-50"
          />
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/80 to-zinc-950/40"
          />
        </>
      ) : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(60%_50%_at_50%_0%,rgba(255,255,255,0.08),transparent)]"
        />
      )}

      <div
        className={cn(
          "relative mx-auto flex max-w-[1600px] flex-col px-4 md:px-8 lg:px-12",
          imageUrl && "min-h-[380px] md:min-h-[440px]",
        )}
      >
        <div className="pt-6 md:pt-8">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            {backLabel}
          </Link>
        </div>

        <div className="mt-auto pb-10 pt-10 md:pb-14 md:pt-16">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(CHIP, STATUS_TONE.neutral)}>{kind}</span>
            {status && (
              <span className={cn(CHIP, STATUS_TONE[status.tone])}>
                {status.label}
              </span>
            )}
          </div>

          <h1 className="mt-4 max-w-4xl text-fluid-3xl font-semibold tracking-[-0.02em] md:text-fluid-4xl">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-3 max-w-2xl text-base text-zinc-300 md:text-lg">
              {subtitle}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums md:text-3xl">
                {price}
              </span>
              <span className="text-sm text-zinc-400">{priceNote}</span>
            </div>
            {host && (
              <Link
                href={host.href}
                className="group flex items-center gap-2.5 sm:border-l sm:border-white/15 sm:pl-6"
              >
                <span className="relative h-7 w-7 overflow-hidden rounded-full ring-1 ring-white/20">
                  <Image
                    src={host.image ?? "/placeholder-user.jpg"}
                    alt=""
                    fill
                    sizes="28px"
                    className="object-cover"
                  />
                </span>
                <span className="text-sm text-zinc-400 transition-colors group-hover:text-white">
                  with{" "}
                  <span className="font-medium text-white">{host.name}</span>
                </span>
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
