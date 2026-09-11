"use client";

import { motion } from "framer-motion";
import { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { FEATURES } from "./data";

function FeatureCard({
  feature,
  index,
}: {
  feature: {
    icon: LucideIcon;
    title: string;
    description: string;
    gradient: string;
  };
  index: number;
}) {
  const Icon = feature.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      viewport={{ once: true }}
    >
      <Card className="feature-card-dark h-full border-0 bg-zinc-900/80 backdrop-blur-sm overflow-hidden group relative">
        <div className="absolute inset-0 bg-gradient-to-br from-white/[0.02] to-transparent" />
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-gradient-to-br from-white/[0.05] to-transparent" />
        <CardContent className="p-6 md:p-8 relative z-10">
          <div
            className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${feature.gradient} flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300 shadow-lg`}
          >
            <Icon className="w-7 h-7 text-white" />
          </div>
          <h3 className="text-xl font-semibold mb-3 text-white">
            {feature.title}
          </h3>
          <p className="text-zinc-400 leading-relaxed">{feature.description}</p>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export function FeaturesSection() {
  return (
    <section className="py-20 md:py-32 bg-zinc-950 relative overflow-hidden">
      <div className="absolute inset-0 dot-pattern opacity-40" />

      {/* Accent gradient */}
      <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-gradient-to-bl from-zinc-800/30 to-transparent blur-[100px]" />

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
            className="mb-4 bg-zinc-800 text-zinc-300 hover:bg-zinc-800 border-zinc-700"
          >
            Our Offerings
          </Badge>
          <h2 className="text-fluid-4xl font-bold text-white mb-4 tracking-tight">
            Multiple ways to <span className="text-zinc-400">learn & grow</span>
          </h2>
          <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
            Choose the format that works best for your learning style and
            schedule
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {FEATURES.map((feature, index) => (
            <FeatureCard key={feature.title} feature={feature} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}
