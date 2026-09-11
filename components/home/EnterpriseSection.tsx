"use client";

import { motion } from "framer-motion";
import { ArrowRight, Building2 } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { ENTERPRISE_FEATURES } from "./data";

/**
 * The B2C page had no path for the buyer who arrives on behalf of an
 * organisation — the enterprise subsystem (sponsored bookings, procurement
 * invoicing, hosted expert networks) was invisible from the landing page.
 */
export function EnterpriseSection() {
  return (
    <section className="py-20 md:py-28 bg-zinc-950 relative overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20" />
      <div className="absolute top-1/3 left-1/4 w-[420px] h-[420px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="max-w-2xl mb-14"
        >
          <Badge
            variant="outline"
            className="mb-5 border-zinc-700 bg-zinc-800/50 text-zinc-300"
          >
            <Building2 className="w-3.5 h-3.5 mr-1.5" />
            For teams &amp; organisations
          </Badge>
          <h2 className="text-fluid-4xl font-bold tracking-tight text-white mb-4">
            Bring Familiarise to your{" "}
            <span className="silver-text">whole team</span>
          </h2>
          <p className="text-lg text-zinc-400 leading-relaxed">
            Sponsor sessions for your people, run structured mentorship
            programs, or host your own experts on the platform — with the
            billing and compliance your finance team expects.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-12">
          {ENTERPRISE_FEATURES.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: index * 0.08 }}
                viewport={{ once: true }}
                className="flex gap-4 p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 backdrop-blur-sm"
              >
                <div className="w-11 h-11 rounded-xl bg-zinc-800 flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5 text-zinc-300" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-semibold text-white mb-1.5">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="flex flex-col sm:flex-row gap-3"
        >
          <Button
            size="lg"
            className="w-full sm:w-auto bg-white text-zinc-900 hover:bg-zinc-200"
            asChild
          >
            <Link href="/enterprise">
              Explore Enterprise
              <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="w-full sm:w-auto bg-transparent border-zinc-700 text-white hover:bg-zinc-800 hover:text-white"
            asChild
          >
            <Link href="/explore/enterprise/organisations">
              Browse organisations
            </Link>
          </Button>
        </motion.div>
      </div>
    </section>
  );
}
