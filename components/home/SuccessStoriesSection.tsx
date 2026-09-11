"use client";

import { motion } from "framer-motion";
import { Rocket } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { SUCCESS_STORIES } from "./data";

function SuccessStoryCard({
  story,
  index,
}: {
  story: (typeof SUCCESS_STORIES)[0];
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      viewport={{ once: true }}
    >
      <Card className="h-full border border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950 overflow-hidden group">
        <CardContent className="p-6 md:p-8">
          <div className="flex items-center gap-4 mb-6">
            <Avatar className="w-14 h-14 border-2 border-zinc-700">
              <AvatarImage src={story.image} />
              <AvatarFallback className="bg-zinc-800 text-white">
                {story.name.charAt(0)}
              </AvatarFallback>
            </Avatar>
            <div>
              <h4 className="font-semibold text-white">{story.name}</h4>
              <p className="text-sm text-zinc-400">{story.role}</p>
              <p className="text-xs text-zinc-500">Now at {story.company}</p>
            </div>
          </div>
          <p className="text-zinc-300 mb-6 leading-relaxed">
            &ldquo;{story.story}&rdquo;
          </p>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 text-white text-sm font-medium">
            <Rocket className="w-4 h-4" />
            {story.metric}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export function SuccessStoriesSection() {
  return (
    <section className="py-20 md:py-32 bg-gradient-to-b from-zinc-900 to-black relative overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20" />

      <div className="absolute top-0 left-1/4 w-96 h-96 bg-zinc-700/20 rounded-full blur-[150px]" />
      <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-zinc-600/15 rounded-full blur-[150px]" />

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
            Success Stories
          </Badge>
          <h2 className="text-fluid-4xl font-bold text-white mb-4 tracking-tight">
            Real transformations,{" "}
            <span className="text-zinc-400">real results</span>
          </h2>
          <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
            See how our mentees have achieved their career goals
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {SUCCESS_STORIES.map((story, index) => (
            <SuccessStoryCard key={story.name} story={story} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}
