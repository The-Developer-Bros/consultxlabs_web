"use client";

import { motion } from "framer-motion";
import { TRUST_BADGES } from "./data";

export function TrustBadgesSection() {
  return (
    <section className="py-16 bg-zinc-950 border-y border-zinc-900">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {TRUST_BADGES.map((badge, index) => (
            <motion.div
              key={badge.label}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: index * 0.1 }}
              viewport={{ once: true }}
              className="text-center"
            >
              <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-3">
                <badge.icon className="w-6 h-6 text-zinc-300" />
              </div>
              <h3 className="font-semibold text-white mb-1">{badge.label}</h3>
              <p className="text-sm text-zinc-400">{badge.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
