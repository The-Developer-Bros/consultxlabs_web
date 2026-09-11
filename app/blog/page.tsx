"use client";

import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface BlogPost {
  title: string;
  teaser: string;
  readTime: string;
}

const BLOG_SECTIONS: { category: string; posts: BlogPost[] }[] = [
  {
    category: "Career Growth",
    posts: [
      {
        title: "How to Break Into Product Companies From a Service Background",
        teaser:
          "The playbook that hundreds of engineers have used to make the switch — and what most advice gets wrong.",
        readTime: "8 min read",
      },
      {
        title: "Salary Negotiation: What Your Recruiter Won't Tell You",
        teaser:
          "Real comp data and negotiation scripts from professionals who've been on both sides of the table.",
        readTime: "9 min read",
      },
      {
        title: "The Career Ladder Is a Myth — Here's What Actually Works",
        teaser:
          "Why linear promotions are the exception, and how to build a career through lateral moves and leverage.",
        readTime: "7 min read",
      },
    ],
  },
  {
    category: "Interview Prep",
    posts: [
      {
        title: "The Mock Interview Mistake That Costs You Offers",
        teaser:
          "Why practicing alone isn't working, and how structured feedback from hiring managers changes everything.",
        readTime: "5 min read",
      },
      {
        title: "System Design Interviews: The Preparation That Actually Works",
        teaser:
          "Forget memorizing architectures. Learn the thinking framework that top candidates use.",
        readTime: "12 min read",
      },
      {
        title:
          "Behavioral Interviews: Stop Memorizing STAR, Start Telling Stories",
        teaser:
          "The difference between a rehearsed answer and a compelling one — with real examples.",
        readTime: "6 min read",
      },
    ],
  },
  {
    category: "Mentorship",
    posts: [
      {
        title: "One-Off Calls vs. Long-Term Mentorship: Which Do You Need?",
        teaser:
          "A framework for deciding when you need a quick answer versus an ongoing relationship.",
        readTime: "6 min read",
      },
      {
        title: "How to Get the Most Out of a 30-Minute Expert Session",
        teaser:
          "The preparation ritual, question framework, and follow-up system that maximizes every consultation.",
        readTime: "4 min read",
      },
      {
        title: "Finding the Right Mentor: It's Not About Pedigree",
        teaser:
          "Why the best mentor for you isn't always the most senior person — and how to identify the right fit.",
        readTime: "5 min read",
      },
    ],
  },
  {
    category: "Skill Building",
    posts: [
      {
        title: "The 90-Day Learning Roadmap: How to Actually Close Skill Gaps",
        teaser:
          "Stop collecting courses. Here's a structured approach to learning that sticks, with accountability built in.",
        readTime: "6 min read",
      },
      {
        title: "From Side Gig to Full-Time: A Guide to Going Independent",
        teaser:
          "How top experts built sustainable consulting businesses while keeping their day jobs.",
        readTime: "10 min read",
      },
      {
        title: "The Skills That Actually Matter in Your First 3 Years",
        teaser:
          "Senior engineers share what they wish they'd focused on early — and what turned out to be noise.",
        readTime: "7 min read",
      },
    ],
  },
];

const FEATURED_POST: BlogPost = {
  title: "The Complete Guide to Career Transitions in Tech",
  teaser:
    "Everything you need to know about switching roles, domains, or companies — from people who've done it. A deep dive into timelines, trade-offs, and the decisions that matter most.",
  readTime: "15 min read",
};

function BlurredCard({ post }: { post: BlogPost }) {
  return (
    <div className="relative bg-card rounded-2xl border border-border overflow-hidden select-none">
      <div className="blur-[6px] pointer-events-none" aria-hidden>
        <div className="h-44 bg-gradient-to-br from-muted to-muted" />
        <div className="p-5">
          <h3 className="text-base font-semibold text-foreground mb-2 line-clamp-2">
            {post.title}
          </h3>
          <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
            {post.teaser}
          </p>
          <span className="text-xs text-muted-foreground/70">{post.readTime}</span>
        </div>
      </div>
    </div>
  );
}

export default function BlogPage() {
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
          <h1 className="text-fluid-5xl font-bold tracking-tight mb-6">
            The Familiarise Blog
          </h1>
          <p className="text-lg md:text-xl text-zinc-400 leading-relaxed">
            Career advice, interview strategies, and expert insights — written
            by the professionals you&apos;ll meet on the platform.
          </p>
        </div>
      </section>

      <main className="container mx-auto px-4 md:px-6 py-12 md:py-16 space-y-16">
        {/* Featured / Top Story */}
        <section>
          <h2 className="text-fluid-3xl font-bold tracking-tight mb-6">
            Featured
          </h2>
          <div className="relative bg-card rounded-2xl border border-border overflow-hidden select-none">
            <div className="blur-[6px] pointer-events-none" aria-hidden>
              <div className="grid grid-cols-1 md:grid-cols-2">
                <div className="h-64 md:h-auto bg-gradient-to-br from-muted to-muted" />
                <div className="p-6 md:p-8 flex flex-col justify-center">
                  <h3 className="text-xl font-bold text-foreground mb-3">
                    {FEATURED_POST.title}
                  </h3>
                  <p className="text-muted-foreground mb-4">
                    {FEATURED_POST.teaser}
                  </p>
                  <span className="text-sm text-muted-foreground/70">
                    {FEATURED_POST.readTime}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Category sections */}
        {BLOG_SECTIONS.map((section) => (
          <section key={section.category}>
            <h2 className="text-fluid-3xl font-bold tracking-tight mb-6">
              {section.category}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
              {section.posts.map((post, i) => (
                <BlurredCard key={i} post={post} />
              ))}
            </div>
          </section>
        ))}
      </main>

      {/* Bottom CTA */}
      <section className="py-16 md:py-20 bg-muted border-t border-border">
        <div className="container mx-auto px-4 md:px-6 text-center max-w-xl">
          <FileText className="w-10 h-10 text-muted-foreground/70 mx-auto mb-4" />
          <h2 className="text-fluid-3xl font-bold tracking-tight mb-3">
            We&apos;re writing the first articles now
          </h2>
          <p className="text-muted-foreground">
            Real stories, real advice, from the experts on our platform. No
            fluff, no filler — just the guidance you&apos;d pay for in a
            session, for free.
          </p>
        </div>
      </section>
    </div>
  );
}
