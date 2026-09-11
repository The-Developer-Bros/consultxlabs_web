"use client";

import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Input } from "@/components/ui/input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  HelpCircle,
  Search,
  User,
  Calendar,
  Briefcase,
  Video,
  CreditCard,
  ChevronRight,
  MessageCircleQuestion,
  Wallet,
  Share2,
  FileText,
  Users,
  Gift,
  CirclePlay,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import { type FAQ } from "./questions";

interface HelpPanelProps {
  faqs: FAQ[];
}

// Category configuration with icons and colors
const categoryConfig: Record<
  string,
  { icon: typeof User; color: string; bgColor: string }
> = {
  Profile: {
    icon: User,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
  },
  Scheduling: {
    icon: Calendar,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
  },
  Services: {
    icon: Briefcase,
    color: "text-purple-600",
    bgColor: "bg-purple-50",
  },
  Meetings: {
    icon: Video,
    color: "text-amber-600",
    bgColor: "bg-amber-50",
  },
  Payments: {
    icon: CreditCard,
    color: "text-rose-600",
    bgColor: "bg-rose-50",
  },
  "Earnings & Payouts": {
    icon: Wallet,
    color: "text-green-600",
    bgColor: "bg-green-50",
  },
  Referrals: {
    icon: Share2,
    color: "text-indigo-600",
    bgColor: "bg-indigo-50",
  },
  Recordings: {
    icon: CirclePlay,
    color: "text-amber-600",
    bgColor: "bg-amber-50",
  },
  Documents: {
    icon: FileText,
    color: "text-slate-600",
    bgColor: "bg-slate-50",
  },
  Collaborations: {
    icon: Users,
    color: "text-teal-600",
    bgColor: "bg-teal-50",
  },
  Trials: {
    icon: Gift,
    color: "text-pink-600",
    bgColor: "bg-pink-50",
  },
};

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.2,
      ease: "easeOut",
    },
  },
};

export function HelpPanel({ faqs: initialFaqs }: Readonly<HelpPanelProps>) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  // Get unique categories
  const categories = useMemo(() => {
    const categorySet = new Set(initialFaqs.map((faq) => faq.category));
    return Array.from(categorySet);
  }, [initialFaqs]);

  // Count FAQs per category (stable counts based on initial data)
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    initialFaqs.forEach((faq) => {
      counts[faq.category] = (counts[faq.category] || 0) + 1;
    });
    return counts;
  }, [initialFaqs]);

  // Filter FAQs based on search and category
  const filteredFaqs = useMemo(() => {
    let result = initialFaqs;

    if (selectedCategory) {
      result = result.filter((faq) => faq.category === selectedCategory);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (faq) =>
          faq.question.toLowerCase().includes(query) ||
          faq.answer.toLowerCase().includes(query),
      );
    }

    return result;
  }, [initialFaqs, searchQuery, selectedCategory]);

  // Group FAQs by category
  const groupedFaqs = useMemo(() => {
    const groups: Record<string, FAQ[]> = {};
    filteredFaqs.forEach((faq) => {
      if (!groups[faq.category]) {
        groups[faq.category] = [];
      }
      groups[faq.category].push(faq);
    });
    return groups;
  }, [filteredFaqs]);

  return (
    <div className="min-h-full">
      <div className="w-full px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* Page Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-8 sm:mb-10"
        >
          <div className="flex items-start sm:items-center gap-3 sm:gap-4 mb-5 sm:mb-6">
            <div className="flex h-11 w-11 sm:h-14 sm:w-14 items-center justify-center rounded-xl sm:rounded-2xl bg-zinc-900 shrink-0">
              <HelpCircle className="h-5 w-5 sm:h-7 sm:w-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-zinc-900 tracking-tight">
                Help Center
              </h1>
              <p className="text-sm sm:text-base text-zinc-500 mt-0.5 sm:mt-1">
                Find answers to common questions about using the platform
              </p>
            </div>
          </div>

          {/* Search Bar */}
          <div className="relative w-full lg:max-w-xl">
            <Search className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-zinc-400" />
            <Input
              type="search"
              placeholder="Search for help..."
              className="w-full pl-10 sm:pl-12 pr-4 py-2.5 sm:py-3 h-10 sm:h-12 text-sm sm:text-base rounded-lg sm:rounded-xl border-zinc-200 bg-zinc-50/50 focus:bg-white focus:ring-2 focus:ring-zinc-900/10 transition-all"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Category Filters */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mt-4 sm:mt-6">
            <button
              onClick={() => setSelectedCategory(null)}
              className={cn(
                "px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium transition-all",
                selectedCategory === null
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
              )}
            >
              All Topics ({initialFaqs.length})
            </button>
            {categories.map((category) => {
              const config = categoryConfig[category] || {
                icon: HelpCircle,
                color: "text-zinc-600",
                bgColor: "bg-zinc-50",
              };
              const Icon = config.icon;
              const isSelected = selectedCategory === category;

              return (
                <button
                  key={category}
                  onClick={() =>
                    setSelectedCategory(isSelected ? null : category)
                  }
                  className={cn(
                    "flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium transition-all",
                    isSelected
                      ? "bg-zinc-900 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  {category} ({categoryCounts[category]})
                </button>
              );
            })}
          </div>

          {/* Results count */}
          <div className="mt-3 sm:mt-4 text-xs sm:text-sm text-zinc-500">
            {filteredFaqs.length}{" "}
            {filteredFaqs.length === 1 ? "result" : "results"} found
            {searchQuery && ` for "${searchQuery}"`}
            {selectedCategory && ` in ${selectedCategory}`}
          </div>
        </motion.div>

        {/* FAQ Content */}
        <AnimatePresence mode="wait">
          {filteredFaqs.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col items-center justify-center py-10 sm:py-16 text-center"
            >
              <div className="flex h-14 w-14 sm:h-20 sm:w-20 items-center justify-center rounded-xl sm:rounded-2xl bg-zinc-100 mb-4 sm:mb-6">
                <MessageCircleQuestion className="h-7 w-7 sm:h-10 sm:w-10 text-zinc-400" />
              </div>
              <h3 className="text-base sm:text-lg font-semibold text-zinc-900 mb-1.5 sm:mb-2">
                No results found
              </h3>
              <p className="text-sm sm:text-base text-zinc-500 max-w-sm px-4">
                We couldn&apos;t find any FAQs matching your search. Try
                adjusting your filters or search terms.
              </p>
              {(searchQuery || selectedCategory) && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setSelectedCategory(null);
                  }}
                  className="mt-3 sm:mt-4 px-4 py-2 text-xs sm:text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
                >
                  Clear all filters
                </button>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="content"
              variants={containerVariants}
              initial="hidden"
              animate="visible"
              className="space-y-4 sm:space-y-6 lg:space-y-8"
            >
              {Object.entries(groupedFaqs).map(([category, faqs]) => {
                const config = categoryConfig[category] || {
                  icon: HelpCircle,
                  color: "text-zinc-600",
                  bgColor: "bg-zinc-50",
                };
                const Icon = config.icon;

                return (
                  <motion.div
                    key={category}
                    variants={itemVariants}
                    className="bg-zinc-50/50 border border-zinc-100 rounded-xl sm:rounded-2xl p-4 sm:p-6"
                  >
                    {/* Category Header */}
                    <div className="flex items-center gap-2.5 sm:gap-3 mb-4 sm:mb-5">
                      <div
                        className={cn(
                          "flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-lg sm:rounded-xl shrink-0",
                          config.bgColor,
                        )}
                      >
                        <Icon
                          className={cn("h-4 w-4 sm:h-5 sm:w-5", config.color)}
                        />
                      </div>
                      <div>
                        <h2 className="text-base sm:text-lg font-semibold text-zinc-900">
                          {category}
                        </h2>
                        <p className="text-xs sm:text-sm text-zinc-500">
                          {faqs.length}{" "}
                          {faqs.length === 1 ? "question" : "questions"}
                        </p>
                      </div>
                    </div>

                    {/* FAQ Items */}
                    <Accordion
                      type="single"
                      collapsible
                      className="space-y-1.5 sm:space-y-2"
                    >
                      {faqs.map((faq) => (
                        <AccordionItem
                          key={faq.id}
                          value={faq.id}
                          className="border border-zinc-200/60 rounded-lg sm:rounded-xl bg-white overflow-hidden data-[state=open]:shadow-sm transition-shadow"
                        >
                          <AccordionTrigger className="px-3 sm:px-5 py-3 sm:py-4 text-left text-sm sm:text-base font-medium text-zinc-900 hover:text-zinc-900 hover:no-underline hover:bg-zinc-50/50 [&[data-state=open]]:bg-zinc-50/50 transition-colors">
                            <div className="flex items-start sm:items-center gap-2 sm:gap-3 pr-2 sm:pr-4">
                              <ChevronRight className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-zinc-400 shrink-0 transition-transform duration-200 [[data-state=open]_&]:rotate-90 mt-0.5 sm:mt-0" />
                              <span className="leading-snug">
                                {faq.question}
                              </span>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-3 sm:px-5 pb-3 sm:pb-5 pt-0">
                            <div className="pl-5 sm:pl-7 text-xs sm:text-sm text-zinc-600 leading-relaxed">
                              {faq.answer}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer Help */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="mt-8 sm:mt-12 text-center py-6 sm:py-8 border-t border-zinc-100"
        >
          <p className="text-sm sm:text-base text-zinc-500">
            Still have questions?{" "}
            <a
              href="mailto:support@familiarise.com"
              className="text-zinc-900 font-medium hover:underline"
            >
              Contact our support team
            </a>{" "}
            — we typically respond within 24 hours.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
