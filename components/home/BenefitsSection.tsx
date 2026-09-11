"use client";

import { motion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { renderLCPImage } from "@/utils/image";
import type { SupabaseImageFile } from "@/lib/supabase";
import { BENEFITS } from "./data";

interface BenefitsSectionProps {
  images: SupabaseImageFile[];
}

export function BenefitsSection({ images }: BenefitsSectionProps) {
  return (
    <section className="py-20 md:py-32 bg-gradient-to-b from-zinc-100 to-white relative overflow-hidden">
      <div className="absolute inset-0 grid-pattern-dark opacity-50" />

      {/* Decorative elements */}
      <div className="absolute top-20 left-10 w-72 h-72 bg-zinc-200/50 rounded-full blur-[100px]" />
      <div className="absolute bottom-20 right-10 w-96 h-96 bg-zinc-300/30 rounded-full blur-[120px]" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <Badge
              variant="secondary"
              className="mb-4 bg-secondary text-secondary-foreground hover:bg-secondary border-0"
            >
              Why Familiarise?
            </Badge>
            <h2 className="text-fluid-4xl font-bold text-foreground mb-6 tracking-tight">
              Transform your career with{" "}
              <span className="text-muted-foreground">expert guidance</span>
            </h2>
            <p className="text-lg text-muted-foreground mb-8">
              Join thousands of professionals who have accelerated their careers
              through personalized mentorship and expert guidance.
            </p>

            <div className="space-y-6">
              {BENEFITS.map((benefit, index) => (
                <motion.div
                  key={benefit.title}
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                  viewport={{ once: true }}
                  className="flex gap-4 group"
                >
                  <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform shadow-elevation-2">
                    <benefit.icon className="w-6 h-6 text-primary-foreground" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="font-semibold text-foreground mb-1">
                      {benefit.title}
                    </h4>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                      {benefit.description}
                    </p>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
            className="relative"
          >
            <div className="relative rounded-2xl overflow-hidden shadow-elevation-3 border border-border">
              {renderLCPImage(images, 0, "/placeholder.svg", 600, 400)}
            </div>
            {/* Floating card decoration */}
            <div className="absolute -bottom-6 -left-6 bg-card rounded-xl shadow-elevation-3 p-4 hidden md:block border border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5 text-primary-foreground" />
                </div>
                <div>
                  <p className="font-semibold text-foreground text-sm">
                    Session Complete
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Great progress today!
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
