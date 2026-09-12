"use client";

import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { motion } from "framer-motion";
import { Quote, Star } from "lucide-react";
import Image from "next/image";

const TESTIMONIALS = [
  {
    id: 1,
    name: "Sarah Johnson",
    role: "Product Manager",
    company: "TechCorp",
    image: "/placeholder-user.jpg",
    rating: 5,
    quote:
      "The expert I consulted with was incredibly knowledgeable and helped me solve my business challenges quickly. Their insights transformed my approach to product strategy.",
  },
  {
    id: 2,
    name: "Michael Chen",
    role: "Software Engineer",
    company: "StartupX",
    image: "/placeholder-user.jpg",
    rating: 5,
    quote:
      "Found an amazing mentor through Familiarise. The guidance I received accelerated my career growth by years. Highly recommend!",
  },
  {
    id: 3,
    name: "Emily Rodriguez",
    role: "Marketing Director",
    company: "BrandCo",
    image: "/placeholder-user.jpg",
    rating: 5,
    quote:
      "The quality of experts on this platform is outstanding. I've had multiple sessions and each one has been incredibly valuable for my professional development.",
  },
];

export function SatisfiedTestimonial() {
  return (
    <section className="relative py-20 md:py-28 bg-zinc-950 overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0">
        <div className="absolute top-1/3 left-1/4 w-[500px] h-[500px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
        <div className="absolute bottom-1/3 right-1/4 w-[400px] h-[400px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
      </div>
      <div className="absolute inset-0 grid-pattern opacity-20" />

      {/* Same container + gutters as every other landing section so the page
          gutter doesn't jump on this band. */}
      <div className="container mx-auto px-4 md:px-6 relative z-10">
        {/* Section Header */}
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/50 backdrop-blur-sm border border-zinc-700/50 rounded-full mb-6">
            <Quote className="w-4 h-4 text-white" />
            <span className="text-sm font-medium text-zinc-300">
              Testimonials
            </span>
          </div>
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-4">
            What <span className="silver-text">Professionals</span> Say
          </h2>
          <p className="text-lg text-zinc-400 max-w-2xl mx-auto">
            Hear from professionals who&apos;ve transformed their careers with
            expert mentors on Familiarise
          </p>
        </motion.div>

        {/* Testimonials Grid */}
        <div className="grid md:grid-cols-3 gap-6 max-w-6xl mx-auto">
          {TESTIMONIALS.map((testimonial, index) => (
            <motion.div
              key={testimonial.id}
              className="relative"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
            >
              <div className="h-full bg-zinc-900/50 backdrop-blur-sm border border-zinc-800 rounded-2xl p-6 hover:border-zinc-700 transition-colors">
                {/* Quote Icon */}
                <div className="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center mb-4">
                  <Quote className="w-5 h-5 text-zinc-400" />
                </div>

                {/* Rating */}
                <div className="flex gap-1 mb-4">
                  {[...Array(testimonial.rating)].map((_, i) => (
                    <Star
                      key={i}
                      className="w-4 h-4 fill-amber-400 text-amber-400"
                    />
                  ))}
                </div>

                {/* Quote */}
                <p className="text-zinc-300 leading-relaxed mb-6">
                  &ldquo;{testimonial.quote}&rdquo;
                </p>

                {/* Author */}
                <div className="flex items-center gap-3 pt-4 border-t border-zinc-800">
                  <Avatar className="h-10 w-10">
                    <AvatarImage
                      src={testimonial.image}
                      alt={testimonial.name}
                    />
                    <AvatarFallback className="bg-zinc-800 text-zinc-300">
                      {testimonial.name.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium text-white text-sm">
                      {testimonial.name}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {testimonial.role} at {testimonial.company}
                    </p>
                  </div>
                </div>

                {/* Reviewed on Familiarise */}
                <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-zinc-800">
                  <Image
                    src="/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif"
                    alt="Familiarise"
                    width={14}
                    height={14}
                  />
                  <span className="text-[10px] text-zinc-500">
                    Reviewed on Familiarise
                  </span>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
