"use client";

import { motion } from "framer-motion";
import { COMPANY_LOGOS } from "./data";

export function TrustedBySection() {
  return (
    <section className="py-16 bg-zinc-950 border-b border-zinc-900">
      <div className="container mx-auto px-4 md:px-6">
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="text-center text-zinc-400 text-sm mb-8"
        >
          Our experts have worked at leading companies
        </motion.p>
        <div className="flex flex-wrap items-center justify-center gap-8 md:gap-16">
          {COMPANY_LOGOS.map((company, i) => (
            <motion.div
              key={company}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.05 }}
              viewport={{ once: true }}
              className="text-zinc-500 font-semibold text-lg md:text-xl hover:text-zinc-300 transition-colors cursor-default"
            >
              {company}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
