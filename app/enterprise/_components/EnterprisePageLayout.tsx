"use client";

import { MotionConfig } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import {
  EnterpriseClosing,
  EnterpriseHero,
  type EnterpriseCta,
  type EnterpriseHeroData,
} from "./EnterpriseSections";

function StickyMobileCta({ cta }: { cta: EnterpriseCta }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      className={`md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur-sm p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-transform duration-300 ${
        visible ? "translate-y-0" : "translate-y-full"
      }`}
      aria-hidden={!visible}
    >
      <Button asChild size="lg" className="w-full h-12 text-base">
        <Link href={cta.href} tabIndex={visible ? undefined : -1}>
          {cta.label}
          <ArrowRight className="w-4 h-4 ml-2" />
        </Link>
      </Button>
    </div>
  );
}

export default function EnterprisePageLayout({
  hero,
  children,
  closing,
  faqsJsonLd,
}: {
  hero: EnterpriseHeroData;
  children: ReactNode;
  closing: {
    title: string;
    description: string;
    primaryCta: EnterpriseCta;
    secondaryCta: EnterpriseCta;
    reassurance: string;
  };
  /** Optional FAQPage JSON-LD for pages that include an FAQ section. */
  faqsJsonLd?: { question: string; answer: string }[];
}) {
  const faqJsonLd = faqsJsonLd
    ? {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faqsJsonLd.map((faq) => ({
          "@type": "Question",
          name: faq.question,
          acceptedAnswer: { "@type": "Answer", text: faq.answer },
        })),
      }
    : null;

  return (
    <MotionConfig reducedMotion="user">
      <div className="w-full pb-24 md:pb-0">
        {faqJsonLd && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c"),
            }}
          />
        )}
        <EnterpriseHero data={hero} />
        {children}
        <EnterpriseClosing {...closing} />
        <StickyMobileCta cta={hero.primaryCta} />
      </div>
    </MotionConfig>
  );
}
