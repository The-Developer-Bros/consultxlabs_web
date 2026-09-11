import {
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  FileCheck,
  Landmark,
  Receipt,
  Sparkles,
  Target,
  Wallet,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PAYOUT_CONSTANTS } from "@/lib/payments/payouts/constants";

export const metadata: Metadata = {
  title: "Become an Expert | Familiarise",
  description:
    "Share your expertise on Familiarise. Set your own rates, keep the majority of every session, and get paid with tax handled for you.",
};

// Derived from the real split rather than hardcoded copy, so the page can't
// drift away from what the payout pipeline actually pays.
const EXPERT_SHARE_PERCENT = 100 - PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE;

const STEPS = [
  {
    icon: Sparkles,
    title: "Apply",
    description:
      "Tell us who you are and what you do. It takes a few minutes and there's no cost to apply.",
  },
  {
    icon: BadgeCheck,
    title: "Get verified",
    description:
      "We review your credentials and experience so learners know every expert on the platform is genuine.",
  },
  {
    icon: Target,
    title: "Set your rates",
    description:
      "Decide what you charge and which formats you offer — one-off calls, ongoing mentorship, classes, or webinars.",
  },
  {
    icon: CalendarClock,
    title: "Start earning",
    description:
      "Publish the hours that suit you. Learners book only the slots you've opened.",
  },
];

const REQUIREMENTS = [
  {
    icon: BadgeCheck,
    title: "Demonstrable expertise",
    description:
      "Real professional experience in the field you want to advise on, which we verify before your profile goes live.",
  },
  {
    icon: FileCheck,
    title: "Identity and tax details",
    description:
      "PAN and the tax information we need to deduct TDS correctly and issue compliant invoices on your behalf.",
  },
  {
    icon: Landmark,
    title: "A bank account for payouts",
    description:
      "Indian bank account details so earnings can be settled to you. Payouts are made in INR.",
  },
  {
    icon: CalendarClock,
    title: "Availability you control",
    description:
      "There's no minimum commitment. You publish the slots you want and can change them whenever you like.",
  },
];

const FAQ = [
  {
    question: "How much does it cost to join?",
    answer:
      "Nothing. There is no listing fee and no subscription. Familiarise only earns when you do, through the platform fee taken from each completed booking.",
  },
  {
    question: "Who decides my pricing?",
    answer:
      "You do. You set the price for every plan you offer and can change it at any time. Learners always see the full price before they book.",
  },
  {
    question: "What happens about tax?",
    answer:
      "TDS is deducted at the applicable rate and recorded against your PAN, and GST-compliant invoices are generated for each booking. You'll find the records in your dashboard when you need them for filing.",
  },
  {
    question: "Do I have to commit to a fixed number of hours?",
    answer:
      "No. You publish availability when it suits you, and learners can only book the slots you have opened. There is no minimum.",
  },
  {
    question: "Can my agency or institution join instead of me individually?",
    answer:
      "Yes. Organisations can host their own experts on Familiarise and appear in the public directory. Get in touch and we'll set that up with you.",
  },
];

export default function BecomeAnExpertPage() {
  return (
    <main className="min-h-screen bg-background">
      {/* Hero */}
      <section className="relative overflow-hidden bg-zinc-950 pt-32 pb-20">
        <div className="absolute inset-0">
          <div className="animate-blob absolute left-1/4 top-1/4 h-[500px] w-[500px] rounded-full bg-zinc-800/30 blur-[120px]" />
          <div className="animate-blob animation-delay-2000 absolute bottom-1/4 right-1/4 h-[400px] w-[400px] rounded-full bg-zinc-700/20 blur-[100px]" />
        </div>
        <div className="grid-pattern absolute inset-0 opacity-20" />

        <div className="relative z-10 mx-auto max-w-[1100px] px-4 md:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-zinc-700/50 bg-zinc-800/50 px-4 py-2 backdrop-blur-sm">
              <Sparkles className="h-4 w-4 text-white" />
              <span className="text-sm font-medium text-zinc-300">
                Share your expertise
              </span>
            </div>
            <h1 className="text-fluid-4xl mb-6 font-bold tracking-tight text-white">
              Share what you know.{" "}
              <span className="silver-text">Get paid for it.</span>
            </h1>
            <p className="mx-auto mb-10 max-w-xl text-lg text-zinc-300">
              Advise people who need exactly what you already know — on your own
              schedule, at rates you set, with the billing and compliance
              handled for you.
            </p>
            <div className="flex flex-col justify-center gap-3 sm:flex-row">
              <Button
                size="lg"
                className="w-full bg-white text-zinc-900 hover:bg-zinc-200 sm:w-auto"
                asChild
              >
                <Link href="/auth/signup">
                  Apply to join
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="w-full border-zinc-700 bg-transparent text-white hover:bg-zinc-800 hover:text-white sm:w-auto"
                asChild
              >
                <Link href="/explore/experts">See who&apos;s already here</Link>
              </Button>
            </div>
            <p className="mt-5 text-sm text-zinc-500">
              Free to apply · No listing fee · No minimum hours
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-20 md:py-24">
        <div className="mx-auto max-w-[1100px] px-4 md:px-8">
          <div className="mb-12 max-w-2xl">
            <Badge variant="secondary" className="mb-4">
              How it works
            </Badge>
            <h2 className="text-fluid-3xl font-bold tracking-tight text-foreground">
              From application to first booking
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => {
              const Icon = step.icon;
              return (
                <div
                  key={step.title}
                  className="rounded-2xl border border-border bg-card p-6"
                >
                  <div className="mb-4 flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
                      {index + 1}
                    </div>
                    <Icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <h3 className="mb-2 font-semibold text-foreground">
                    {step.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {step.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Earnings */}
      <section className="bg-muted py-20 md:py-24">
        <div className="mx-auto max-w-[1100px] px-4 md:px-8">
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
            <div>
              <Badge variant="secondary" className="mb-4">
                What you earn
              </Badge>
              <h2 className="text-fluid-3xl mb-4 font-bold tracking-tight text-foreground">
                You keep {EXPERT_SHARE_PERCENT}% of every session
              </h2>
              <p className="mb-6 leading-relaxed text-muted-foreground">
                You set the price; Familiarise takes a{" "}
                {PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE}% platform fee from
                each completed booking and the rest is yours. There is no
                listing fee and no subscription, so we only earn when you do.
              </p>
              <p className="text-sm text-muted-foreground">
                Experts who join through an agency or institution on Familiarise
                keep the same {EXPERT_SHARE_PERCENT}% share; the hosting
                organisation&apos;s cut comes out of the platform fee, not out
                of your earnings.
              </p>
            </div>

            <div className="space-y-4">
              <div className="flex gap-4 rounded-2xl border border-border bg-card p-6">
                <Wallet className="h-5 w-5 shrink-0 text-muted-foreground" />
                <div>
                  <h3 className="mb-1 font-semibold text-foreground">
                    Settled to your bank account
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Earnings accrue per completed session and are paid out in
                    INR to the account you register.
                  </p>
                </div>
              </div>
              <div className="flex gap-4 rounded-2xl border border-border bg-card p-6">
                <Receipt className="h-5 w-5 shrink-0 text-muted-foreground" />
                <div>
                  <h3 className="mb-1 font-semibold text-foreground">
                    Tax handled for you
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    TDS is deducted at the applicable rate against your PAN and
                    GST-compliant invoices are generated automatically.
                  </p>
                </div>
              </div>
              <div className="flex gap-4 rounded-2xl border border-border bg-card p-6">
                <Target className="h-5 w-5 shrink-0 text-muted-foreground" />
                <div>
                  <h3 className="mb-1 font-semibold text-foreground">
                    Your rates, your formats
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Offer one-off calls, ongoing mentorship, classes or webinars
                    — priced however you choose.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Requirements */}
      <section className="py-20 md:py-24">
        <div className="mx-auto max-w-[1100px] px-4 md:px-8">
          <div className="mb-12 max-w-2xl">
            <Badge variant="secondary" className="mb-4">
              What we need from you
            </Badge>
            <h2 className="text-fluid-3xl font-bold tracking-tight text-foreground">
              What it takes to get verified
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {REQUIREMENTS.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.title}
                  className="flex gap-4 rounded-2xl border border-border bg-card p-6"
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted">
                    <Icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="mb-1.5 font-semibold text-foreground">
                      {item.title}
                    </h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="bg-muted py-20 md:py-24">
        <div className="mx-auto max-w-[800px] px-4 md:px-8">
          <div className="mb-10 text-center">
            <Badge variant="secondary" className="mb-4">
              FAQ
            </Badge>
            <h2 className="text-fluid-3xl font-bold tracking-tight text-foreground">
              Questions people ask before applying
            </h2>
          </div>

          <Accordion type="single" collapsible className="w-full">
            {FAQ.map((item) => (
              <AccordionItem key={item.question} value={item.question}>
                <AccordionTrigger className="text-left font-medium text-foreground">
                  {item.question}
                </AccordionTrigger>
                <AccordionContent className="leading-relaxed text-muted-foreground">
                  {item.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="py-20 md:py-28">
        <div className="mx-auto max-w-[800px] px-4 text-center md:px-8">
          <h2 className="text-fluid-3xl mb-4 font-bold tracking-tight text-foreground">
            Ready to start advising?
          </h2>
          <p className="mx-auto mb-8 max-w-xl text-muted-foreground">
            Apply in a few minutes. We&apos;ll review your details and get back
            to you about verification.
          </p>
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            <Button size="lg" className="w-full sm:w-auto" asChild>
              <Link href="/auth/signup">
                Apply to join
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto"
              asChild
            >
              <Link href="/contactus">Talk to us first</Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
