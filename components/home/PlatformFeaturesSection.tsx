"use client";

import { motion } from "framer-motion";
import { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { PLATFORM_FEATURES } from "./data";

function PlatformFeatureCard({
  feature,
  index,
}: {
  feature: { icon: LucideIcon; title: string; description: string };
  index: number;
}) {
  const Icon = feature.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.1 }}
      viewport={{ once: true }}
      className="text-center group"
    >
      <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4 group-hover:bg-secondary transition-colors group-hover:scale-110 duration-300">
        <Icon className="w-8 h-8 text-foreground" />
      </div>
      <h4 className="font-semibold text-foreground mb-2">{feature.title}</h4>
      <p className="text-sm text-muted-foreground">{feature.description}</p>
    </motion.div>
  );
}

export function PlatformFeaturesSection() {
  return (
    <section className="py-20 md:py-32 bg-gradient-to-b from-zinc-50 to-white relative overflow-hidden">
      <div className="absolute inset-0 diagonal-stripes" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <Badge
            variant="secondary"
            className="mb-4 bg-secondary text-secondary-foreground hover:bg-secondary border-0"
          >
            Platform Features
          </Badge>
          <h2 className="text-fluid-4xl font-bold text-foreground mb-4 tracking-tight">
            Everything you need to{" "}
            <span className="text-muted-foreground">succeed</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            A seamless experience built for learning and growth
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-10 md:gap-12">
          {PLATFORM_FEATURES.map((feature, index) => (
            <PlatformFeatureCard
              key={feature.title}
              feature={feature}
              index={index}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
