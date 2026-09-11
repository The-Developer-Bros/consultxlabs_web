"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  Briefcase,
  Building2,
  Check,
  FileCheck,
  GraduationCap,
  Shield,
  Users,
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

/**
 * Page data lives in server components so each route can export `metadata`, and
 * component references cannot cross that boundary — so pages name an icon and
 * this client module resolves it. (Same pattern as app/use-cases/UseCaseSections.)
 */
export const ENTERPRISE_ICONS = {
  users: Users,
  briefcase: Briefcase,
  fileCheck: FileCheck,
  shield: Shield,
  graduation: GraduationCap,
  wallet: Wallet,
  building: Building2,
} as const;

export type EnterpriseIcon = keyof typeof ENTERPRISE_ICONS;

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true },
};

export interface EnterpriseCta {
  label: string;
  href: string;
}

export interface EnterpriseHeroData {
  eyebrow: string;
  /** Brand-level line — kept short so Familiarise stays the hero signal. */
  brandLine: string;
  titleLead: string;
  titleAccent: string;
  subtitle: string;
  primaryCta: EnterpriseCta;
  secondaryCta: EnterpriseCta;
  assurances: string[];
  card: {
    title: string;
    items: string[];
    footnote?: string;
  };
}

export interface EnterpriseFeature {
  icon: EnterpriseIcon;
  title: string;
  description: string;
  href?: string;
}

export interface EnterprisePath {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  ctaLabel: string;
  icon: EnterpriseIcon;
}

export interface EnterpriseFaq {
  question: string;
  answer: string;
}

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

export function EnterpriseHero({ data }: { data: EnterpriseHeroData }) {
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
              <Building2 className="w-3.5 h-3.5 mr-1.5" />
              {data.eyebrow}
            </Badge>
            <p className="text-fluid-sm font-medium tracking-[0.2em] uppercase text-zinc-500 mb-4">
              {data.brandLine}
            </p>
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

export function EnterpriseCapabilities({
  eyebrow,
  title,
  intro,
  features,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  features: EnterpriseFeature[];
}) {
  return (
    <section className="py-16 md:py-24 bg-card">
      <div className="container mx-auto px-4 md:px-6 max-w-5xl">
        <SectionHeading eyebrow={eyebrow} title={title} intro={intro} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {features.map((feature, i) => {
            const Icon = ENTERPRISE_ICONS[feature.icon];
            const body = (
              <>
                <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-semibold text-foreground mb-1.5 flex items-center gap-2">
                    {feature.title}
                    {feature.href && (
                      <ArrowRight className="w-4 h-4 text-muted-foreground" />
                    )}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </>
            );

            return (
              <motion.div
                key={feature.title}
                {...fadeUp}
                transition={{ duration: 0.4, delay: i * 0.06 }}
              >
                {feature.href ? (
                  <Link
                    href={feature.href}
                    className="flex gap-4 p-6 rounded-2xl border border-border bg-muted hover:border-foreground/20 transition-colors h-full"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex gap-4 p-6 rounded-2xl border border-border bg-muted h-full">
                    {body}
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function EnterprisePaths({
  eyebrow,
  title,
  intro,
  paths,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  paths: EnterprisePath[];
}) {
  return (
    <section className="py-16 md:py-24 bg-muted">
      <div className="container mx-auto px-4 md:px-6 max-w-5xl">
        <SectionHeading eyebrow={eyebrow} title={title} intro={intro} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {paths.map((path, i) => {
            const Icon = ENTERPRISE_ICONS[path.icon];
            return (
              <motion.div
                key={path.title}
                {...fadeUp}
                transition={{ duration: 0.4, delay: i * 0.08 }}
                className="flex flex-col p-6 md:p-8 rounded-2xl border border-border bg-card"
              >
                <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center mb-5">
                  <Icon className="w-5 h-5 text-muted-foreground" />
                </div>
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
                  {path.eyebrow}
                </p>
                <h3 className="text-fluid-xl font-semibold text-foreground mb-2">
                  {path.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-6 flex-1">
                  {path.description}
                </p>
                <Button variant="outline" className="w-fit" asChild>
                  <Link href={path.href}>
                    {path.ctaLabel}
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Link>
                </Button>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function EnterpriseHowItWorks({
  eyebrow,
  title,
  intro,
  steps,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  steps: { title: string; description: string }[];
}) {
  return (
    <section className="py-16 md:py-24 bg-card">
      <div className="container mx-auto px-4 md:px-6 max-w-5xl">
        <SectionHeading eyebrow={eyebrow} title={title} intro={intro} />
        <ol className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {steps.map((step, i) => (
            <motion.li
              key={step.title}
              {...fadeUp}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className="relative overflow-hidden p-6 rounded-2xl border border-border bg-muted"
            >
              <span
                aria-hidden
                className="absolute -top-3 right-3 text-7xl font-bold text-foreground/[0.06] select-none"
              >
                {i + 1}
              </span>
              <h3 className="font-semibold text-foreground mb-2 relative">
                {step.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed relative">
                {step.description}
              </p>
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** Vertical spine — used on team-training so rollout doesn't mirror the 3-up cards. */
export function EnterpriseVerticalTimeline({
  eyebrow,
  title,
  intro,
  steps,
}: Readonly<{
  eyebrow: string;
  title: string;
  intro: string;
  steps: { label: string; title: string; description: string }[];
}>) {
  return (
    <section className="py-16 md:py-24 bg-muted">
      <div className="container mx-auto px-4 md:px-6 max-w-3xl">
        <SectionHeading eyebrow={eyebrow} title={title} intro={intro} align="left" />
        <ol className="relative space-y-0 border-l border-border ml-3 md:ml-4">
          {steps.map((step, i) => (
            <motion.li
              key={step.title}
              {...fadeUp}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className="relative pl-8 md:pl-10 pb-10 last:pb-0"
            >
              <span
                aria-hidden
                className="absolute -left-2 top-1.5 h-4 w-4 rounded-full border-2 border-foreground bg-background"
              />
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
                {step.label}
              </p>
              <h3 className="font-semibold text-foreground mb-1.5">
                {step.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {step.description}
              </p>
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** Alternating rows — used on corporate-mentorship instead of a 2×2 card grid. */
export function EnterpriseAlternatingRows({
  eyebrow,
  title,
  intro,
  rows,
}: Readonly<{
  eyebrow: string;
  title: string;
  intro: string;
  rows: {
    icon: EnterpriseIcon;
    title: string;
    description: string;
  }[];
}>) {
  return (
    <section className="py-16 md:py-24 bg-card">
      <div className="container mx-auto px-4 md:px-6 max-w-5xl">
        <SectionHeading eyebrow={eyebrow} title={title} intro={intro} />
        <div className="space-y-8 md:space-y-12">
          {rows.map((row, i) => {
            const Icon = ENTERPRISE_ICONS[row.icon];
            const reverse = i % 2 === 1;
            return (
              <motion.div
                key={row.title}
                {...fadeUp}
                transition={{ duration: 0.4, delay: i * 0.06 }}
                className={`flex flex-col md:flex-row gap-6 md:gap-10 items-center ${
                  reverse ? "md:flex-row-reverse" : ""
                }`}
              >
                <div className="w-full md:w-2/5 rounded-2xl border border-border bg-muted p-8 flex items-center justify-center min-h-[140px]">
                  <Icon className="w-12 h-12 text-muted-foreground" />
                </div>
                <div className="w-full md:w-3/5">
                  <h3 className="text-fluid-xl font-semibold text-foreground mb-2">
                    {row.title}
                  </h3>
                  <p className="text-muted-foreground leading-relaxed">
                    {row.description}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Two-column contrast table — used on team-training vs mentorship. */
export function EnterpriseComparison({
  eyebrow,
  title,
  intro,
  left,
  right,
}: Readonly<{
  eyebrow: string;
  title: string;
  intro: string;
  left: {
    label: string;
    title: string;
    points: string[];
    href: string;
    ctaLabel: string;
  };
  right: {
    label: string;
    title: string;
    points: string[];
    href: string;
    ctaLabel: string;
  };
}>) {
  return (
    <section className="py-16 md:py-24 bg-card">
      <div className="container mx-auto px-4 md:px-6 max-w-5xl">
        <SectionHeading eyebrow={eyebrow} title={title} intro={intro} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-0 md:gap-0 rounded-2xl border border-border overflow-hidden">
          {[left, right].map((col, i) => (
            <motion.div
              key={col.title}
              {...fadeUp}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className={`p-6 md:p-8 ${
                i === 0
                  ? "bg-muted border-b md:border-b-0 md:border-r border-border"
                  : "bg-background"
              }`}
            >
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
                {col.label}
              </p>
              <h3 className="text-fluid-xl font-semibold text-foreground mb-4">
                {col.title}
              </h3>
              <ul className="space-y-3 mb-6">
                {col.points.map((point) => (
                  <li key={point} className="flex gap-2 text-sm text-muted-foreground">
                    <Check className="w-4 h-4 text-foreground shrink-0 mt-0.5" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              <Button variant={i === 0 ? "default" : "outline"} asChild>
                <Link href={col.href}>
                  {col.ctaLabel}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Link>
              </Button>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function EnterpriseFaqs({
  eyebrow,
  title,
  intro,
  items,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  items: EnterpriseFaq[];
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

export function EnterpriseClosing({
  title,
  description,
  primaryCta,
  secondaryCta,
  reassurance,
}: {
  title: string;
  description: string;
  primaryCta: EnterpriseCta;
  secondaryCta: EnterpriseCta;
  reassurance: string;
}) {
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
          {title}
        </motion.h2>
        <motion.p
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="text-zinc-400 leading-relaxed mb-8"
        >
          {description}
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
            <Link href={primaryCta.href} className="w-full sm:w-auto">
              {primaryCta.label}
              <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:w-auto bg-transparent border-zinc-700 text-white hover:bg-zinc-800 hover:text-white px-8 h-12 text-base"
            asChild
          >
            <Link href={secondaryCta.href} className="w-full sm:w-auto">
              {secondaryCta.label}
            </Link>
          </Button>
        </motion.div>
        <p className="mt-6 text-fluid-xs text-zinc-500">{reassurance}</p>
      </div>
    </section>
  );
}
