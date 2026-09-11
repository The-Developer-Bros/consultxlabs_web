"use client";

import {
  MessageCircle,
  Users,
  Calendar,
  Trophy,
  BookOpen,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

const COMMUNITY_FEATURES = [
  {
    icon: MessageCircle,
    title: "Discussion Forums",
    description:
      "Domain-specific channels for career advice, interview prep, and industry trends.",
  },
  {
    icon: Users,
    title: "Peer Groups",
    description:
      "Get matched with people at your career stage for accountability and support.",
  },
  {
    icon: Calendar,
    title: "Weekly AMAs",
    description:
      "Live ask-me-anything sessions with senior professionals across industries.",
  },
  {
    icon: Trophy,
    title: "Challenges & Sprints",
    description:
      "30-day skill challenges with community accountability and expert-reviewed submissions.",
  },
  {
    icon: BookOpen,
    title: "Resource Library",
    description:
      "Curated templates, roadmaps, and guides shared by experts and community members.",
  },
  {
    icon: Zap,
    title: "Quick Help",
    description:
      "Post a question, get answers from peers and experts within hours — not days.",
  },
];

const PLACEHOLDER_DISCUSSIONS = [
  {
    channel: "Career Transitions",
    title: "Just switched from TCS to a Series B startup — AMA",
    replies: 47,
    author: "Priya S.",
    role: "Backend Engineer",
  },
  {
    channel: "Interview Prep",
    title:
      "My system design interview template (got offers from 3 FAANG companies)",
    replies: 124,
    author: "Arjun M.",
    role: "Senior SDE",
  },
  {
    channel: "Resume Reviews",
    title:
      "Reviewed 200+ resumes this year. Here are the top 5 mistakes I see.",
    replies: 89,
    author: "Neha K.",
    role: "Tech Recruiter",
  },
  {
    channel: "Freelancing",
    title: "How I went from 0 to 3L/month consulting on the side",
    replies: 203,
    author: "Rohit D.",
    role: "Independent Consultant",
  },
  {
    channel: "Career Growth",
    title: "Negotiated a 40% raise by changing one thing about my approach",
    replies: 67,
    author: "Ananya R.",
    role: "Product Manager",
  },
  {
    channel: "Skill Building",
    title: "The 3-month roadmap that took me from service to product company",
    replies: 156,
    author: "Vikram P.",
    role: "Full-Stack Developer",
  },
  {
    channel: "Mentorship",
    title:
      "Finding a mentor changed my career trajectory. Here's how I did it.",
    replies: 38,
    author: "Sanya T.",
    role: "Data Scientist",
  },
  {
    channel: "Interview Prep",
    title: "Behavioral interview answers that actually work (with examples)",
    replies: 91,
    author: "Karthik V.",
    role: "Engineering Manager",
  },
];

const UPCOMING_EVENTS = [
  {
    title: "AMA: Breaking into Product Management",
    host: "Meera J., PM at Razorpay",
    date: "Coming Soon",
  },
  {
    title: "Resume Roast: Live Review Session",
    host: "Community Team",
    date: "Coming Soon",
  },
  {
    title: "30-Day DSA Challenge Kickoff",
    host: "Familiarise Community",
    date: "Coming Soon",
  },
];

export default function CommunityPage() {
  return (
    <div className="w-full">
      {/* Hero */}
      <section className="bg-zinc-950 text-white py-20 md:py-28">
        <div className="container mx-auto px-4 md:px-6 text-center max-w-3xl">
          <Badge
            variant="outline"
            className="border-zinc-700 text-zinc-400 mb-6 text-sm px-4 py-1.5"
          >
            Coming Soon
          </Badge>
          <h1 className="text-fluid-4xl font-bold tracking-tight mb-6">
            Your Career, Together
          </h1>
          <p className="text-lg md:text-xl text-zinc-300 leading-relaxed">
            A community of professionals helping each other grow — through peer
            advice, expert AMAs, skill challenges, and real conversations about
            career moves.
          </p>
        </div>
      </section>

      {/* Features grid */}
      <section className="py-16 md:py-24 bg-card">
        <div className="container mx-auto px-4 md:px-6 max-w-5xl">
          <h2 className="text-fluid-3xl font-bold tracking-tight text-center mb-4">
            What&apos;s Coming
          </h2>
          <p className="text-muted-foreground text-center mb-12 max-w-2xl mx-auto">
            We&apos;re building the community features right now. Here&apos;s
            what to expect.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {COMMUNITY_FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <div
                  key={feature.title}
                  className="p-6 rounded-2xl border border-border bg-muted"
                >
                  <div className="w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center mb-4">
                    <Icon className="w-5 h-5" />
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Placeholder discussions — visible but locked */}
      <section className="py-16 md:py-24 bg-muted">
        <div className="container mx-auto px-4 md:px-6 max-w-4xl">
          <h2 className="text-fluid-3xl font-bold tracking-tight text-center mb-4">
            Conversations You&apos;ll Find Here
          </h2>
          <p className="text-muted-foreground text-center mb-12 max-w-2xl mx-auto">
            A preview of the kind of discussions our community will have.
          </p>
          <div className="space-y-3">
            {PLACEHOLDER_DISCUSSIONS.map((post, i) => (
              <div
                key={i}
                className="relative bg-card rounded-xl border border-border overflow-hidden select-none"
              >
                <div
                  className="blur-[6px] pointer-events-none flex items-start gap-4 p-4"
                  aria-hidden
                >
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0 text-sm font-bold text-muted-foreground/70">
                    {post.author.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                        {post.channel}
                      </span>
                    </div>
                    <h3 className="text-sm font-semibold text-foreground line-clamp-1">
                      {post.title}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      {post.author} &middot; {post.role} &middot; {post.replies}{" "}
                      replies
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Upcoming events preview */}
      <section className="py-16 md:py-24 bg-card">
        <div className="container mx-auto px-4 md:px-6 max-w-3xl">
          <h2 className="text-fluid-3xl font-bold tracking-tight text-center mb-4">
            Upcoming Events
          </h2>
          <p className="text-muted-foreground text-center mb-10 max-w-2xl mx-auto">
            Live sessions, challenges, and workshops — all free for community
            members.
          </p>
          <div className="space-y-4">
            {UPCOMING_EVENTS.map((event, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 p-5 rounded-2xl border border-border bg-muted"
              >
                <div className="min-w-0">
                  <h3 className="font-semibold text-foreground">{event.title}</h3>
                  <p className="text-sm text-muted-foreground mt-0.5">{event.host}</p>
                </div>
                <Badge
                  variant="outline"
                  className="border-border text-muted-foreground/70 shrink-0"
                >
                  {event.date}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="py-20 md:py-28 bg-zinc-950 text-white">
        <div className="container mx-auto px-4 md:px-6 text-center max-w-2xl">
          <Users className="w-10 h-10 text-zinc-400 mx-auto mb-4" />
          <h2 className="text-fluid-3xl font-bold tracking-tight mb-4">
            Be the first to join
          </h2>
          <p className="text-zinc-300 leading-relaxed">
            We&apos;re building a community where career conversations happen in
            the open — not behind paywalls or locked DMs. Stay tuned.
          </p>
        </div>
      </section>
    </div>
  );
}
