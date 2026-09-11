"use client";

import { motion } from "framer-motion";
import { ArrowRight, Clock, Mic, Target } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const EXPERT_BENEFITS = [
  { icon: Target, label: "Set Your Rates" },
  { icon: Clock, label: "Flexible Schedule" },
  { icon: Mic, label: "Build Your Brand" },
];

export function BecomeExpertSection() {
  return (
    <section className="py-20 md:py-32 bg-gradient-to-br from-zinc-200 via-zinc-100 to-white relative overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-1/4 right-1/4 w-[400px] h-[400px] bg-zinc-300/50 rounded-full blur-[100px] animate-blob" />
        <div className="absolute bottom-1/4 left-1/4 w-[500px] h-[500px] bg-zinc-200/50 rounded-full blur-[100px] animate-blob animation-delay-2000" />
      </div>
      <div className="absolute inset-0 dot-pattern-light opacity-40" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="max-w-3xl mx-auto text-center"
        >
          <Badge
            variant="secondary"
            className="mb-4 bg-primary text-primary-foreground hover:bg-primary"
          >
            Share Your Expertise
          </Badge>
          <h2 className="text-fluid-4xl font-bold text-foreground mb-6 tracking-tight">
            Become an expert on{" "}
            <span className="text-muted-foreground">Familiarise</span>
          </h2>
          <p className="text-lg text-muted-foreground mb-8 max-w-2xl mx-auto">
            Join our network of professionals. Share your knowledge, build your
            personal brand, and earn while helping others grow.
          </p>

          {/* Expert benefits */}
          <div className="grid sm:grid-cols-3 gap-6 mb-10">
            {EXPERT_BENEFITS.map((item, i) => (
              <motion.div
                key={item.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: i * 0.1 }}
                viewport={{ once: true }}
                className="flex items-center justify-center gap-2 text-foreground"
              >
                <item.icon className="w-5 h-5" />
                <span className="font-medium">{item.label}</span>
              </motion.div>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/become-an-expert">
              <Button
                size="lg"
                className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 h-14 text-base rounded-xl shadow-elevation-3"
              >
                Apply as Expert
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
            <Button
              size="lg"
              variant="outline"
              className="px-8 h-14 text-base rounded-xl border-border hover:bg-muted"
            >
              Learn More
            </Button>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
