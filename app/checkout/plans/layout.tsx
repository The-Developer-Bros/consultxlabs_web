"use client";

import { motion } from "framer-motion";
import { Check, Lock } from "lucide-react";

const STEPS = ["Details", "Payment", "Done"] as const;
/** plans/* pages combine details review + payment, so step 2 is current. */
const CURRENT_STEP = 1;

function CheckoutSteps() {
  return (
    <div className="border-b border-border bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4 sm:px-8">
        <p className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
          <Lock className="h-4 w-4" aria-hidden />
          Secure checkout
        </p>
        <ol
          className="flex items-center gap-1.5 text-xs sm:text-sm"
          aria-label="Checkout progress"
        >
          {STEPS.map((label, i) => {
            const done = i < CURRENT_STEP;
            const current = i === CURRENT_STEP;
            return (
              <li key={label} className="flex items-center gap-1.5">
                {i > 0 && (
                  <span
                    aria-hidden
                    className={`mx-1 h-px w-4 sm:w-8 ${done || current ? "bg-primary" : "bg-border"}`}
                  />
                )}
                <span
                  aria-current={current ? "step" : undefined}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
                    done
                      ? "bg-primary/10 text-primary"
                      : current
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {done ? (
                    <Check className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <span aria-hidden>{i + 1}</span>
                  )}
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

export default function CheckoutLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen w-full overflow-hidden"
    >
      <CheckoutSteps />
      <div className="grid w-full lg:grid-cols-[60%_40%]">{children}</div>
    </motion.div>
  );
}
