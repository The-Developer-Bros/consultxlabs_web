"use client";

import { motion } from "framer-motion";
import { Calendar, ChevronRight, Clock, Star } from "lucide-react";
import Link from "next/link";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ReviewWithProfiles } from "@/types/review";
import { UPCOMING_EVENTS } from "./data";

function EventCard({
  event,
  index,
}: {
  event: (typeof UPCOMING_EVENTS)[0];
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      whileInView={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.4, delay: index * 0.1 }}
      viewport={{ once: true }}
    >
      <Card className="border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 transition-colors group">
        <CardContent className="p-5">
          <div className="flex items-start justify-between mb-3">
            <Badge
              variant="secondary"
              className="bg-zinc-800 text-zinc-300 text-xs"
            >
              {event.type}
            </Badge>
            <span className="text-xs text-zinc-500">
              {event.attendees} attending
            </span>
          </div>
          <h4 className="font-semibold text-white mb-2 group-hover:text-zinc-200">
            {event.title}
          </h4>
          <p className="text-sm text-zinc-400 mb-3">Hosted by {event.host}</p>
          <div className="flex items-center gap-4 text-xs text-zinc-500">
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              {event.date}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {event.time}
            </span>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

interface UpcomingEventsSectionProps {
  reviews: ReviewWithProfiles[];
}

export function UpcomingEventsSection({ reviews }: UpcomingEventsSectionProps) {
  const slicedReviews = reviews.slice(0, 3);

  return (
    <section className="py-20 md:py-32 bg-gradient-to-b from-black via-zinc-950 to-zinc-900 overflow-hidden relative">
      <div className="absolute inset-0 grid-pattern opacity-20" />

      {/* Glow accents */}
      <div className="absolute top-1/2 left-0 w-96 h-96 bg-zinc-700/20 rounded-full blur-[150px] -translate-y-1/2" />
      <div className="absolute top-1/2 right-0 w-96 h-96 bg-zinc-600/15 rounded-full blur-[150px] -translate-y-1/2" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <div className="grid lg:grid-cols-2 gap-16">
          {/* Testimonials Column */}
          <div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              viewport={{ once: true }}
              className="mb-8"
            >
              <Badge
                variant="secondary"
                className="mb-4 bg-zinc-800 text-zinc-300 hover:bg-zinc-800 border-zinc-700"
              >
                Reviews
              </Badge>
              <h2 className="text-fluid-3xl font-bold text-white mb-4 tracking-tight">
                What our users say
              </h2>
            </motion.div>

            <div className="space-y-4">
              {slicedReviews.map((review, i) => (
                <motion.div
                  key={review.id}
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                  viewport={{ once: true }}
                >
                  <Card className="border border-zinc-800 bg-zinc-900/50 backdrop-blur-sm">
                    <CardContent className="p-5">
                      <div className="flex items-center gap-1 mb-3">
                        {Array.from({ length: 5 }).map((_, j) => (
                          <Star
                            key={j}
                            className={`w-3 h-3 ${j < review.rating ? "fill-white text-white" : "fill-zinc-700 text-zinc-700"}`}
                          />
                        ))}
                      </div>
                      <p className="text-zinc-300 text-sm mb-3 line-clamp-2">
                        &ldquo;{review.reviewDescription || "Great experience!"}
                        &rdquo;
                      </p>
                      <div className="flex items-center gap-2">
                        <Avatar className="w-6 h-6 border border-zinc-700">
                          <AvatarImage
                            src={review.consulteeProfile?.user?.image ?? ""}
                          />
                          <AvatarFallback className="bg-zinc-800 text-zinc-300 text-xs">
                            {review.consulteeProfile?.user?.name?.charAt(0) ??
                              "U"}
                          </AvatarFallback>
                        </Avatar>
                        <p className="text-xs text-zinc-500">
                          — {review.consulteeProfile?.user?.name || "Anonymous"}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Upcoming Events Column */}
          <div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              viewport={{ once: true }}
              className="mb-8"
            >
              <Badge
                variant="secondary"
                className="mb-4 bg-zinc-800 text-zinc-300 hover:bg-zinc-800 border-zinc-700"
              >
                Coming Soon
              </Badge>
              <h2 className="text-fluid-3xl font-bold text-white mb-4 tracking-tight">
                Upcoming events
              </h2>
            </motion.div>

            <div className="space-y-4">
              {UPCOMING_EVENTS.map((event, index) => (
                <EventCard key={event.title} event={event} index={index} />
              ))}
            </div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.3 }}
              viewport={{ once: true }}
              className="mt-6"
            >
              <Link href="/explore/programs">
                <Button className="w-full bg-white text-zinc-900 hover:bg-zinc-200 font-medium">
                  View All Events
                  <ChevronRight className="ml-2 w-4 h-4" />
                </Button>
              </Link>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}
