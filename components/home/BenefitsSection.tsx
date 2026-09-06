"use client";

import { motion } from "framer-motion";

import { renderLCPImage } from "@/utils/image";
import type { SupabaseImageFile } from "@/lib/supabase";
import { cn } from "@/utils/tailwind";
import { BENEFITS } from "./data";
import { SectionIntro, reveal, staggerDelay } from "./SectionIntro";

interface BenefitsSectionProps {
  images: SupabaseImageFile[];
}

export function BenefitsSection({ images }: BenefitsSectionProps) {
  // No photo means no frame: a grey placeholder inside a hairline border was
  // the most visible thing in the section whenever the storage read came back
  // empty, which on a local environment is always.
  const hasImage = images.length > 0;

  return (
    <section className="bg-muted/40 py-20 md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <div
          className={cn(
            "grid items-center gap-12",
            hasImage && "lg:grid-cols-2 lg:gap-20",
          )}
        >
          <div>
            <SectionIntro
              eyebrow="Why Familiarise"
              title="Expert guidance, without the guesswork"
              lede="Book someone who has already solved the problem in front of you, and spend an hour on it instead of a quarter."
            />

            <ul className="divide-y divide-border border-y border-border">
              {BENEFITS.map((benefit, index) => (
                <motion.li
                  key={benefit.title}
                  {...reveal(staggerDelay(index))}
                  className="grid grid-cols-[2.5rem_1fr] py-5"
                >
                  <span className="text-sm font-medium tabular-nums text-muted-foreground">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold tracking-tight text-foreground">
                      {benefit.title}
                    </h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {benefit.description}
                    </p>
                  </div>
                </motion.li>
              ))}
            </ul>
          </div>

          {hasImage && (
            <motion.div
              {...reveal()}
              className="overflow-hidden rounded-2xl border border-border"
            >
              {renderLCPImage(images, 0, "/placeholder.svg", 600, 400)}
            </motion.div>
          )}
        </div>
      </div>
    </section>
  );
}
