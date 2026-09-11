"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  Award,
  BadgeCheck,
  Banknote,
  Briefcase,
  Building2,
  CalendarClock,
  Check,
  ClipboardList,
  Code2,
  Compass,
  FileText,
  GitBranch,
  GraduationCap,
  Globe2,
  Handshake,
  LineChart,
  MapPin,
  MessageSquare,
  Plane,
  Repeat,
  Route,
  ScrollText,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  UserCheck,
  Users,
  Video,
  Wallet,
} from "lucide-react";
import Link from "next/link";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ─── Icons ───────────────────────────────────────────────────────────────────

/**
 * Page data lives in server components so each route can export `metadata`, and
 * component references cannot cross that boundary — so pages name an icon and
 * this client module resolves it.
 */
export const USE_CASE_ICONS = {
  award: Award,
  badgeCheck: BadgeCheck,
  banknote: Banknote,
  briefcase: Briefcase,
  building: Building2,
  calendar: CalendarClock,
  clipboard: ClipboardList,
  code: Code2,
  compass: Compass,
  file: FileText,
  branch: GitBranch,
  globe: Globe2,
  graduation: GraduationCap,
  handshake: Handshake,
  chart: LineChart,
  map: MapPin,
  message: MessageSquare,
  plane: Plane,
  repeat: Repeat,
  route: Route,
  scroll: ScrollText,
  search: Search,
  shield: ShieldCheck,
  sparkles: Sparkles,
  target: Target,
  trending: TrendingUp,
  userCheck: UserCheck,
  users: Users,
  video: Video,
  wallet: Wallet,
} as const;

export type UseCaseIcon = keyof typeof USE_CASE_ICONS;

// ─── Shared bits ─────────────────────────────────────────────────────────────

/**
 * Shared entrance animation.
 *
 * Reduced motion is handled once, at the layout, via
 * `<MotionConfig reducedMotion="user">` — framer-motion then strips transform
 * animations (keeping opacity) for every motion component in the subtree. That
 * beats threading a hook through all 14 call sites here, and it can't be
 * forgotten when a new animated block is added.
 */
const fadeUp = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true },
};

function SectionHeading({
  eyebrow,
  title,
  intro,
  align = "center",
}: {
  eyebrow: string;
  title: string;
  intro: string;
  align?: "center" | "left";
}) {
  const isCentered = align === "center";
  return (
    <motion.div
      {...fadeUp}
      transition={{ duration: 0.5 }}
      className={
        isCentered ? "max-w-2xl mx-auto text-center mb-12" : "max-w-2xl mb-12"
      }
    >
      <Badge
        variant="secondary"
        className="mb-4 bg-secondary text-secondary-foreground hover:bg-secondary border-0"
      >
        {eyebrow}
      </Badge>
      <h2 className="text-fluid-3xl md:text-fluid-4xl font-bold tracking-tight text-foreground mb-4">
        {title}
      </h2>
      <p className="text-muted-foreground leading-relaxed">{intro}</p>
    </motion.div>
  );
}

function Footnote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-10 text-center text-fluid-sm text-muted-foreground max-w-2xl mx-auto">
      {children}
    </p>
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseCaseCta {
  label: string;
  href: string;
}

export interface UseCaseItem {
  /** Timeline period, glossary term, or "from → to" route marker. */
  label?: string;
  title: string;
  description: string;
  icon?: UseCaseIcon;
}

export interface UseCaseSectionData {
  eyebrow: string;
  title: string;
  intro: string;
  items: UseCaseItem[];
  footnote?: string;
}

// ─── Hero ────────────────────────────────────────────────────────────────────

export interface UseCaseHeroData {
  eyebrow: string;
  titleLead: string;
  titleAccent: string;
  subtitle: string;
  primaryCta: UseCaseCta;
  secondaryCta: UseCaseCta;
  /** Verifiable platform mechanics only — never volume or outcome claims. */
  assurances: string[];
  card: {
    title: string;
    items: string[];
    footnote?: string;
  };
}

export function UseCaseHero({ data }: { data: UseCaseHeroData }) {
  return (
    <section className="relative pt-32 pb-20 md:pb-28 bg-zinc-950 overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
      </div>
      <div className="absolute inset-0 grid-pattern opacity-20" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <div className="grid lg:grid-cols-[1.15fr_1fr] gap-12 lg:gap-16 items-center">
          <motion.div {...fadeUp} transition={{ duration: 0.5 }}>
            <Badge
              variant="outline"
              className="mb-5 border-zinc-700 bg-zinc-800/50 text-zinc-300"
            >
              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
              {data.eyebrow}
            </Badge>
            <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight text-white mb-5">
              {data.titleLead}{" "}
              <span className="silver-text">{data.titleAccent}</span>
            </h1>
            <p className="text-fluid-lg text-zinc-400 leading-relaxed mb-8 max-w-xl">
              {data.subtitle}
            </p>

            <div className="flex flex-col sm:flex-row gap-3 mb-8">
              <Button
                size="lg"
                className="w-full sm:w-auto bg-white text-zinc-900 hover:bg-zinc-200 px-8 h-12 text-base"
                asChild
              >
                <Link href={data.primaryCta.href} className="w-full sm:w-auto">
                  {data.primaryCta.label}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Link>
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="w-full sm:w-auto bg-transparent border-zinc-700 text-white hover:bg-zinc-800 hover:text-white px-8 h-12 text-base"
                asChild
              >
                <Link
                  href={data.secondaryCta.href}
                  className="w-full sm:w-auto"
                >
                  {data.secondaryCta.label}
                </Link>
              </Button>
            </div>

            <ul className="flex flex-wrap gap-x-6 gap-y-2">
              {data.assurances.map((line) => (
                <li
                  key={line}
                  className="flex items-center gap-2 text-fluid-sm text-zinc-400"
                >
                  <Check className="w-4 h-4 text-zinc-500 shrink-0" />
                  {line}
                </li>
              ))}
            </ul>
          </motion.div>

          <motion.div
            {...fadeUp}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="rounded-2xl border border-zinc-800 bg-zinc-900/60 backdrop-blur-sm p-6 md:p-8"
          >
            <h2 className="text-fluid-lg font-semibold text-white mb-5">
              {data.card.title}
            </h2>
            <ul className="space-y-4">
              {data.card.items.map((item) => (
                <li key={item} className="flex gap-3">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-zinc-500 shrink-0" />
                  <span className="text-fluid-sm text-zinc-300 leading-relaxed">
                    {item}
                  </span>
                </li>
              ))}
            </ul>
            {data.card.footnote && (
              <p className="mt-6 pt-5 border-t border-zinc-800 text-fluid-xs text-zinc-500 leading-relaxed">
                {data.card.footnote}
              </p>
            )}
          </motion.div>
        </div>
      </div>
    </section>
  );
}

// ─── Pain points ─────────────────────────────────────────────────────────────

export function UseCasePains({ data }: { data: UseCaseSectionData }) {
  return (
    <section className="py-16 md:py-24 bg-card">
      <div className="container mx-auto px-4 md:px-6 max-w-5xl">
        <SectionHeading
          eyebrow={data.eyebrow}
          title={data.title}
          intro={data.intro}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {data.items.map((item, i) => (
            <motion.div
              key={item.title}
              {...fadeUp}
              transition={{ duration: 0.4, delay: i * 0.06 }}
              className="relative overflow-hidden p-6 rounded-2xl border border-border bg-muted"
            >
              <span
                aria-hidden
                className="absolute -top-3 right-3 text-7xl font-bold text-foreground/[0.06] select-none"
              >
                {i + 1}
              </span>
              <h3 className="relative text-fluid-lg font-semibold text-foreground mb-2 pr-10">
                {item.title}
              </h3>
              <p className="relative text-fluid-sm text-muted-foreground leading-relaxed">
                {item.description}
              </p>
            </motion.div>
          ))}
        </div>
        {data.footnote && <Footnote>{data.footnote}</Footnote>}
      </div>
    </section>
  );
}

// ─── Spine: timeline ─────────────────────────────────────────────────────────

/** Vertical rail with a period marker per row — for calendar-shaped stories. */
export function UseCaseTimeline({ data }: { data: UseCaseSectionData }) {
  return (
    <section className="py-16 md:py-24 bg-muted relative overflow-hidden">
      <div className="absolute inset-0 dot-pattern-light opacity-60" />
      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <div className="grid lg:grid-cols-[1fr_1.2fr] gap-12 lg:gap-16 items-start">
          <div className="lg:sticky lg:top-32">
            <SectionHeading
              eyebrow={data.eyebrow}
              title={data.title}
              intro={data.intro}
              align="left"
            />
            {data.footnote && (
              <p className="text-fluid-sm text-muted-foreground max-w-md -mt-6">
                {data.footnote}
              </p>
            )}
          </div>

          <div>
            {data.items.map((item, i) => (
              <motion.div
                key={item.title}
                {...fadeUp}
                transition={{ duration: 0.45, delay: i * 0.08 }}
                className="flex gap-5"
              >
                <div className="flex flex-col items-center">
                  <div className="w-3 h-3 rounded-full bg-foreground shrink-0 mt-2" />
                  {i < data.items.length - 1 && (
                    <div className="w-px flex-1 bg-border my-2" />
                  )}
                </div>
                <div className="pb-10 min-w-0">
                  {item.label && (
                    <span className="inline-block mb-2 px-2.5 py-0.5 rounded-md bg-primary text-primary-foreground text-fluid-xs font-semibold">
                      {item.label}
                    </span>
                  )}
                  <h3 className="text-fluid-lg font-semibold text-foreground mb-1.5">
                    {item.title}
                  </h3>
                  <p className="text-fluid-sm text-muted-foreground leading-relaxed">
                    {item.description}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Spine: decoder ──────────────────────────────────────────────────────────

/** Glossary/ledger rows — term on the left, plain-English meaning on the right. */
export function UseCaseDecoder({ data }: { data: UseCaseSectionData }) {
  return (
    <section className="py-16 md:py-24 bg-muted">
      <div className="container mx-auto px-4 md:px-6 max-w-4xl">
        <SectionHeading
          eyebrow={data.eyebrow}
          title={data.title}
          intro={data.intro}
        />
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          {data.items.map((item, i) => (
            <motion.div
              key={item.title}
              {...fadeUp}
              transition={{ duration: 0.35, delay: i * 0.05 }}
              className={`grid sm:grid-cols-[13rem_1fr] gap-x-6 gap-y-2 p-6 ${
                i > 0 ? "border-t border-border" : ""
              }`}
            >
              <div>
                {item.label && (
                  <span className="block text-fluid-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">
                    {item.label}
                  </span>
                )}
                <h3 className="text-fluid-base font-semibold text-foreground">
                  {item.title}
                </h3>
              </div>
              <p className="text-fluid-sm text-muted-foreground leading-relaxed">
                {item.description}
              </p>
            </motion.div>
          ))}
        </div>
        {data.footnote && <Footnote>{data.footnote}</Footnote>}
      </div>
    </section>
  );
}

// ─── Spine: matrix ───────────────────────────────────────────────────────────

/** "From → to" route cards, for readers choosing between named transitions. */
export function UseCaseMatrix({ data }: { data: UseCaseSectionData }) {
  return (
    <section className="py-16 md:py-24 bg-muted">
      <div className="container mx-auto px-4 md:px-6 max-w-5xl">
        <SectionHeading
          eyebrow={data.eyebrow}
          title={data.title}
          intro={data.intro}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {data.items.map((item, i) => {
            const Icon = item.icon ? USE_CASE_ICONS[item.icon] : Route;
            return (
              <motion.div
                key={item.title}
                {...fadeUp}
                transition={{ duration: 0.4, delay: i * 0.06 }}
                className="p-6 rounded-2xl border border-border bg-card"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4" />
                  </div>
                  {item.label && (
                    <span className="text-fluid-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      {item.label}
                    </span>
                  )}
                </div>
                <h3 className="text-fluid-base font-semibold text-foreground mb-2">
                  {item.title}
                </h3>
                <p className="text-fluid-sm text-muted-foreground leading-relaxed">
                  {item.description}
                </p>
              </motion.div>
            );
          })}
        </div>
        {data.footnote && <Footnote>{data.footnote}</Footnote>}
      </div>
    </section>
  );
}

// ─── Spine: cadence ──────────────────────────────────────────────────────────

/** Horizontal stepped rail — for an engagement that unfolds over months. */
export function UseCaseCadence({ data }: { data: UseCaseSectionData }) {
  return (
    <section className="py-16 md:py-24 bg-muted">
      <div className="container mx-auto px-4 md:px-6 max-w-6xl">
        <SectionHeading
          eyebrow={data.eyebrow}
          title={data.title}
          intro={data.intro}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-2xl overflow-hidden border border-border">
          {data.items.map((item, i) => (
            <motion.div
              key={item.title}
              {...fadeUp}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className="bg-card p-6"
            >
              <div className="flex items-center gap-2 mb-4">
                <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground text-fluid-xs font-bold flex items-center justify-center shrink-0">
                  {i + 1}
                </span>
                {item.label && (
                  <span className="text-fluid-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {item.label}
                  </span>
                )}
              </div>
              <h3 className="text-fluid-base font-semibold text-foreground mb-2">
                {item.title}
              </h3>
              <p className="text-fluid-sm text-muted-foreground leading-relaxed">
                {item.description}
              </p>
            </motion.div>
          ))}
        </div>
        {data.footnote && <Footnote>{data.footnote}</Footnote>}
      </div>
    </section>
  );
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/** What the reader actually books — the offer, stated concretely. */
export function UseCaseSessions({ data }: { data: UseCaseSectionData }) {
  return (
    <section className="py-16 md:py-24 bg-card">
      <div className="container mx-auto px-4 md:px-6 max-w-5xl">
        <SectionHeading
          eyebrow={data.eyebrow}
          title={data.title}
          intro={data.intro}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {data.items.map((item, i) => {
            const Icon = item.icon ? USE_CASE_ICONS[item.icon] : Target;
            return (
              <motion.div
                key={item.title}
                {...fadeUp}
                transition={{ duration: 0.4, delay: i * 0.06 }}
                className="flex gap-4 p-6 rounded-2xl border border-border bg-muted"
              >
                <div className="w-11 h-11 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-fluid-base font-semibold text-foreground mb-1.5">
                    {item.title}
                  </h3>
                  <p className="text-fluid-sm text-muted-foreground leading-relaxed">
                    {item.description}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
        {data.footnote && <Footnote>{data.footnote}</Footnote>}
      </div>
    </section>
  );
}

// ─── Checklist ───────────────────────────────────────────────────────────────

export function UseCaseChecklist({ data }: { data: UseCaseSectionData }) {
  return (
    <section className="py-16 md:py-24 bg-card">
      <div className="container mx-auto px-4 md:px-6 max-w-3xl">
        <SectionHeading
          eyebrow={data.eyebrow}
          title={data.title}
          intro={data.intro}
        />
        <ul className="rounded-2xl border border-border bg-muted divide-y divide-border">
          {data.items.map((item, i) => (
            <motion.li
              key={item.title}
              {...fadeUp}
              transition={{ duration: 0.35, delay: i * 0.05 }}
              className="flex gap-4 p-5"
            >
              <span className="mt-0.5 w-6 h-6 rounded-md border border-border bg-card flex items-center justify-center shrink-0">
                <Check className="w-3.5 h-3.5 text-foreground" />
              </span>
              <div className="min-w-0">
                <h3 className="text-fluid-base font-semibold text-foreground mb-1">
                  {item.title}
                </h3>
                <p className="text-fluid-sm text-muted-foreground leading-relaxed">
                  {item.description}
                </p>
              </div>
            </motion.li>
          ))}
        </ul>
        {data.footnote && <Footnote>{data.footnote}</Footnote>}
      </div>
    </section>
  );
}

// ─── Comparison ──────────────────────────────────────────────────────────────

export interface UseCaseComparisonData {
  eyebrow: string;
  title: string;
  intro: string;
  /** The two substitutes the reader is genuinely weighing us against. */
  alternatives: [string, string];
  ourLabel: string;
  rows: {
    criterion: string;
    alternatives: [string, string];
    ours: string;
  }[];
  footnote?: string;
}

export function UseCaseComparison({ data }: { data: UseCaseComparisonData }) {
  return (
    <section className="py-16 md:py-24 bg-muted">
      <div className="container mx-auto px-4 md:px-6 max-w-5xl">
        <SectionHeading
          eyebrow={data.eyebrow}
          title={data.title}
          intro={data.intro}
        />
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5 }}
          className="overflow-x-auto rounded-2xl border border-border bg-card"
        >
          <table className="w-full min-w-[42rem] text-left border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className="p-4 md:p-5 text-fluid-xs font-semibold uppercase tracking-widest text-muted-foreground w-[22%]">
                  <span className="sr-only">Criterion</span>
                </th>
                {data.alternatives.map((alt) => (
                  <th
                    key={alt}
                    className="p-4 md:p-5 text-fluid-sm font-semibold text-muted-foreground w-[26%]"
                  >
                    {alt}
                  </th>
                ))}
                <th className="p-4 md:p-5 text-fluid-sm font-semibold bg-primary text-primary-foreground w-[26%]">
                  {data.ourLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr
                  key={row.criterion}
                  className={i > 0 ? "border-t border-border" : ""}
                >
                  <th
                    scope="row"
                    className="p-4 md:p-5 align-top text-fluid-sm font-semibold text-foreground"
                  >
                    {row.criterion}
                  </th>
                  {row.alternatives.map((cell, j) => (
                    <td
                      key={j}
                      className="p-4 md:p-5 align-top text-fluid-sm text-muted-foreground leading-relaxed"
                    >
                      {cell}
                    </td>
                  ))}
                  <td className="p-4 md:p-5 align-top text-fluid-sm text-foreground leading-relaxed bg-muted font-medium">
                    {row.ours}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </motion.div>
        {data.footnote && <Footnote>{data.footnote}</Footnote>}
      </div>
    </section>
  );
}

// ─── Categories ──────────────────────────────────────────────────────────────

export interface UseCaseCategoriesData {
  eyebrow: string;
  title: string;
  intro: string;
  links: { label: string; href: string }[];
}

export function UseCaseCategories({ data }: { data: UseCaseCategoriesData }) {
  return (
    <section className="py-16 md:py-24 bg-card">
      <div className="container mx-auto px-4 md:px-6 max-w-4xl text-center">
        <SectionHeading
          eyebrow={data.eyebrow}
          title={data.title}
          intro={data.intro}
        />
        <div className="flex flex-wrap justify-center gap-3">
          {data.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="px-5 py-2.5 rounded-full border border-border bg-muted text-fluid-sm font-medium text-muted-foreground hover:bg-primary hover:text-primary-foreground hover:border-primary transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── FAQ ─────────────────────────────────────────────────────────────────────

export interface UseCaseFaq {
  question: string;
  answer: string;
}

export function UseCaseFaqs({
  eyebrow,
  title,
  intro,
  items,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  items: UseCaseFaq[];
}) {
  return (
    <section className="py-16 md:py-24 bg-muted">
      <div className="container mx-auto px-4 md:px-6 max-w-3xl">
        <SectionHeading eyebrow={eyebrow} title={title} intro={intro} />
        <div className="rounded-2xl border border-border bg-card px-6">
          <Accordion type="single" collapsible className="w-full">
            {items.map((faq, i) => (
              <AccordionItem
                key={faq.question}
                value={`faq-${i}`}
                className={i === items.length - 1 ? "border-b-0" : ""}
              >
                <AccordionTrigger className="text-left text-fluid-base font-semibold text-foreground hover:no-underline py-5">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-fluid-sm text-muted-foreground leading-relaxed pb-5 pr-6">
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </section>
  );
}

// ─── Closing CTA ─────────────────────────────────────────────────────────────

export interface UseCaseClosingData {
  title: string;
  description: string;
  primaryCta: UseCaseCta;
  secondaryCta: UseCaseCta;
  reassurance: string;
}

export function UseCaseClosing({ data }: { data: UseCaseClosingData }) {
  return (
    <section className="py-20 md:py-28 bg-zinc-950 relative overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />

      <div className="container mx-auto px-4 md:px-6 relative z-10 text-center max-w-2xl">
        <motion.h2
          {...fadeUp}
          transition={{ duration: 0.5 }}
          className="text-fluid-3xl md:text-fluid-4xl font-bold tracking-tight text-white mb-4"
        >
          {data.title}
        </motion.h2>
        <motion.p
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="text-zinc-400 leading-relaxed mb-8"
        >
          {data.description}
        </motion.p>
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="flex flex-col sm:flex-row gap-3 justify-center"
        >
          <Button
            size="lg"
            className="w-full sm:w-auto bg-white text-zinc-900 hover:bg-zinc-200 px-8 h-12 text-base"
            asChild
          >
            <Link href={data.primaryCta.href} className="w-full sm:w-auto">
              {data.primaryCta.label}
              <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:w-auto bg-transparent border-zinc-700 text-white hover:bg-zinc-800 hover:text-white px-8 h-12 text-base"
            asChild
          >
            <Link href={data.secondaryCta.href} className="w-full sm:w-auto">
              {data.secondaryCta.label}
            </Link>
          </Button>
        </motion.div>
        <p className="mt-6 text-fluid-xs text-zinc-500">{data.reassurance}</p>
      </div>
    </section>
  );
}
