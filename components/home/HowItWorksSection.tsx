"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HOW_IT_WORKS } from "./data";

function HowItWorksStep({
  step,
  index,
  isLast,
}: {
  step: (typeof HOW_IT_WORKS)[0];
  index: number;
  isLast: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      whileInView={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.5, delay: index * 0.15 }}
      viewport={{ once: true }}
      className="relative"
    >
      <div className="flex gap-6">
        <div className="flex flex-col items-center">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-zinc-100 to-zinc-300 flex items-center justify-center text-zinc-900 font-bold text-lg shadow-elevation-2 border border-border">
            {step.step}
          </div>
          {!isLast && (
            <div className="w-0.5 h-full bg-gradient-to-b from-border to-transparent mt-4" />
          )}
        </div>
        <div className="pb-12 min-w-0">
          <h4 className="text-xl font-semibold text-foreground mb-2">
            {step.title}
          </h4>
          <p className="text-muted-foreground leading-relaxed">
            {step.description}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

export function HowItWorksSection() {
  return (
    <section
      id="how-it-works"
      className="py-20 md:py-32 bg-gradient-to-b from-zinc-50 to-white relative overflow-hidden scroll-mt-20"
    >
      <div className="absolute inset-0 diagonal-stripes" />

      {/* Decorative circles */}
      <div className="absolute top-40 right-20 w-64 h-64 border border-border rounded-full opacity-50" />
      <div className="absolute bottom-40 left-20 w-48 h-48 border border-border rounded-full opacity-50" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <div className="grid lg:grid-cols-2 gap-16 items-start">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            viewport={{ once: true }}
            className="lg:sticky lg:top-32"
          >
            <Badge
              variant="secondary"
              className="mb-4 bg-secondary text-secondary-foreground hover:bg-secondary border-0"
            >
              Getting Started
            </Badge>
            <h2 className="text-fluid-4xl font-bold text-foreground mb-6 tracking-tight">
              How it <span className="text-muted-foreground">works</span>
            </h2>
            <p className="text-lg text-muted-foreground mb-8">
              Get started in minutes. Our streamlined process makes it easy to
              connect with the right expert for your needs.
            </p>
            <Link href="/explore/experts">
              <Button
                size="lg"
                className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-elevation-2"
              >
                Start Your Journey
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
          </motion.div>

          <div>
            {HOW_IT_WORKS.map((step, index) => (
              <HowItWorksStep
                key={step.step}
                step={step}
                index={index}
                isLast={index === HOW_IT_WORKS.length - 1}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
