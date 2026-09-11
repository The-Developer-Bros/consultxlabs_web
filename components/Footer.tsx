"use client";

import React, { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FaFacebook,
  FaInstagram,
  FaYoutube,
  FaLinkedin,
  FaXTwitter,
} from "react-icons/fa6";
import { ArrowUpRight, MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isChromeHidden } from "@/lib/navigation/public-chrome";
import familiariseLogoWhite from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_white.avif";

interface FooterLink {
  label: string;
  href: string;
  /** Renders the outbound glyph. Flagged explicitly rather than matched on
   *  display text, which silently breaks the moment the copy is reworded. */
  external?: boolean;
}

// Mirrors the Navbar's IA (Explore / Solutions / Enterprise / Company / Legal).
// Users who miss something in the nav look for it in the footer, so the two
// disagreeing costs clicks.
const FOOTER_COLUMNS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: "Explore",
    links: [
      { label: "Find experts", href: "/explore/experts" },
      { label: "Programs", href: "/explore/programs" },
      {
        label: "Organisations",
        href: "/explore/enterprise/organisations",
      },
      { label: "Community", href: "/explore/community" },
    ],
  },
  {
    heading: "Solutions",
    links: [
      { label: "College students", href: "/use-cases/college-students" },
      { label: "Early-career pros", href: "/use-cases/early-career" },
      { label: "Career switchers", href: "/use-cases/career-switchers" },
      { label: "Long-term mentorship", href: "/use-cases/mentorship" },
    ],
  },
  {
    heading: "Enterprise",
    links: [
      { label: "Overview", href: "/enterprise" },
      { label: "Team training", href: "/enterprise/team-training" },
      {
        label: "Corporate mentorship",
        href: "/enterprise/corporate-mentorship",
      },
      { label: "Talk to sales", href: "/contactus" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contactus" },
      { label: "Blog", href: "/blog" },
      { label: "Pricing", href: "/pricing" },
      { label: "How it works", href: "/#how-it-works" },
      { label: "Become an expert", href: "/become-an-expert", external: true },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Terms of Service", href: "/terms" },
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Refund Policy", href: "/refund" },
    ],
  },
];

// Internal-linking band. A marketplace's value is its long-tail catalog, so
// these deep links are worth more here than another column of company pages.
const EXPERTISE_LINKS: FooterLink[] = [
  { label: "Technology", href: "/explore/experts?domain=Technology" },
  { label: "Business", href: "/explore/experts?domain=Business" },
  { label: "Creative Arts", href: "/explore/experts?domain=Creative Arts" },
  { label: "Education", href: "/explore/experts?domain=Education" },
  { label: "Health", href: "/explore/experts?domain=Health" },
  {
    label: "Personal Development",
    href: "/explore/experts?domain=Personal Development",
  },
];

const SOCIAL_LINKS = [
  {
    icon: FaXTwitter,
    href: "https://twitter.com/familiarise",
    label: "X",
  },
  {
    icon: FaLinkedin,
    href: "https://linkedin.com/company/familiarise",
    label: "LinkedIn",
  },
  {
    icon: FaInstagram,
    href: "https://instagram.com/familiarise",
    label: "Instagram",
  },
  {
    icon: FaYoutube,
    href: "https://youtube.com/familiarise",
    label: "YouTube",
  },
  {
    icon: FaFacebook,
    href: "https://facebook.com/familiarise",
    label: "Facebook",
  },
];

const Footer: React.FC = () => {
  const pathname = usePathname();
  const [email, setEmail] = useState("");
  const [waitlistStatus, setWaitlistStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");

  // Check if we're on the home page
  const isHomePage = pathname === "/";

  // Route list lives in lib/navigation/public-chrome.ts — it was duplicated
  // across Navbar/Footer/HeaderSpacer and had already drifted.
  if (isChromeHidden(pathname)) return null;

  // The heading says "Stay in the loop" and the copy promises a weekly email,
  // but the button still said "Join waitlist" — left over from the
  // waitlist→newsletter rework. The endpoint is unchanged; only the label was
  // stale.
  const subscribeButtonLabel = {
    idle: "Subscribe",
    loading: "Subscribing...",
    success: "Check your email",
    error: "Subscribe",
  }[waitlistStatus];

  const handleWaitlistSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || waitlistStatus === "loading") return;

    setWaitlistStatus("loading");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Tagged by surface so the admin list can tell where signups come from.
        body: JSON.stringify({ email, source: "FOOTER" }),
      });
      if (!res.ok) throw new Error("Failed");
      setEmail("");
      setWaitlistStatus("success");
    } catch {
      setWaitlistStatus("error");
    }
  };

  return (
    <footer className="bg-black text-white mt-auto relative overflow-hidden">
      {/* Animated background - only on home page for continuous effect */}
      {isHomePage && (
        <>
          <div className="absolute inset-0">
            <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
            <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
            <div className="absolute top-1/2 right-1/3 w-[300px] h-[300px] bg-zinc-600/15 rounded-full blur-[80px] animate-blob animation-delay-4000" />
          </div>
          <div className="absolute inset-0 grid-pattern opacity-20" />
        </>
      )}

      {/* Waitlist signup — every marketing page, merged with the footer */}
      <div className="relative z-10 border-b border-zinc-800">
        <div className="container mx-auto px-4 md:px-6 py-20 md:py-28">
          <div className="max-w-2xl mx-auto text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-zinc-700 to-zinc-900 flex items-center justify-center mx-auto mb-6 shadow-lg">
              <MessageSquare className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-fluid-5xl font-bold tracking-tight text-white mb-4">
              Stay in the <span className="silver-text">loop</span>
            </h2>
            <p className="text-lg text-zinc-500 mb-8">
              Get expert tips, career advice, and exclusive offers delivered to
              your inbox weekly.
            </p>

            <form
              className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto"
              onSubmit={handleWaitlistSubmit}
            >
              <Input
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-14 bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-600 rounded-xl focus:border-zinc-600 focus:ring-zinc-600"
              />
              <Button
                type="submit"
                size="lg"
                disabled={
                  waitlistStatus === "loading" || waitlistStatus === "success"
                }
                className="h-14 bg-white text-zinc-900 hover:bg-zinc-200 px-8 rounded-xl font-medium shrink-0"
              >
                {subscribeButtonLabel}
              </Button>
            </form>

            {waitlistStatus === "error" && (
              <p className="text-sm text-red-400 mt-2">
                Something went wrong. Please try again.
              </p>
            )}

            <p className="text-sm text-zinc-600 mt-4">
              No spam, unsubscribe anytime.{" "}
              <Link
                href="/privacy"
                className="underline hover:text-zinc-400 transition-colors"
              >
                Privacy Policy
              </Link>
            </p>
          </div>
        </div>
      </div>

      {/* Main Footer Content */}
      <div className="container mx-auto px-4 md:px-6 py-16 md:py-20 relative z-10">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-8 lg:gap-10">
          {/* Brand Column */}
          <div className="col-span-2 md:col-span-3 lg:col-span-2">
            <Link href="/" className="inline-block mb-6">
              <div className="relative h-10 w-36">
                <Image
                  src={familiariseLogoWhite}
                  alt="Familiarise"
                  fill
                  className="object-contain object-left"
                  sizes="144px"
                />
              </div>
            </Link>
            <p className="text-zinc-400 text-sm leading-relaxed mb-6 max-w-xs">
              Connect with world-class experts for personalized mentorship,
              classes, and career guidance. Transform your career today.
            </p>

            {/* Social Links */}
            <div className="flex items-center gap-3">
              {SOCIAL_LINKS.map((social) => (
                <a
                  key={social.label}
                  href={social.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={social.label}
                  className="w-10 h-10 rounded-full bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center transition-colors group"
                >
                  <social.icon className="w-4 h-4 text-zinc-400 group-hover:text-white transition-colors" />
                </a>
              ))}
            </div>
          </div>

          {FOOTER_COLUMNS.map((column) => (
            <div key={column.heading}>
              <h3 className="font-semibold text-white mb-4">
                {column.heading}
              </h3>
              <ul className="space-y-3">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-400 hover:text-white transition-colors inline-flex items-center gap-1"
                    >
                      {link.label}
                      {link.external && <ArrowUpRight className="w-3 h-3" />}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Expertise band — deep links into the catalog */}
        <div className="mt-12 pt-8 border-t border-zinc-800">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-3">
            Find an expert in
          </h3>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {EXPERTISE_LINKS.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="text-sm text-zinc-400 hover:text-white transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Bar — legal lives in its own column above, so this carries
          only the copyright line. */}
      <div className="border-t border-zinc-800 relative z-10">
        <div className="container mx-auto px-4 md:px-6 py-6">
          <p className="text-sm text-zinc-500 text-center md:text-left">
            © {new Date().getFullYear()} Familiarise. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
