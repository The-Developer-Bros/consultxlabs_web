import {
  Award,
  BadgeCheck,
  BookOpen,
  Briefcase,
  Calendar,
  Clock,
  Code,
  FileCheck,
  Globe,
  GraduationCap,
  HeadphonesIcon,
  HeartHandshake,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  Lock,
  MessageSquare,
  Monitor,
  Palette,
  Shield,
  Star,
  TrendingUp,
  Users,
  Video,
  Zap,
} from "lucide-react";

export const FEATURES = [
  {
    icon: Video,
    title: "1-on-1 Sessions",
    description:
      "Personal video consultations with industry experts tailored to your specific needs and goals.",
    gradient: "from-zinc-700 to-zinc-900",
  },
  {
    icon: Calendar,
    title: "Subscriptions",
    description:
      "Ongoing mentorship programs with regular check-ins and continuous support for your growth.",
    gradient: "from-neutral-600 to-neutral-800",
  },
  {
    icon: GraduationCap,
    title: "Expert Classes",
    description:
      "Structured learning programs led by professionals with hands-on projects and certifications.",
    gradient: "from-stone-600 to-stone-800",
  },
  {
    icon: Users,
    title: "Live Webinars",
    description:
      "Interactive group sessions on trending topics with Q&A and networking opportunities.",
    gradient: "from-gray-600 to-gray-800",
  },
];

// #1490 — the hardcoded "150+ experts" line under each category is gone. The
// card now renders a real per-domain consultant count, looked up by name from
// the landing loader, and renders no line at all where that count is zero.
export const CATEGORIES = [
  {
    icon: Code,
    name: "Technology",
    color: "bg-zinc-900",
  },
  {
    icon: Briefcase,
    name: "Business",
    color: "bg-zinc-800",
  },
  { icon: Palette, name: "Design", color: "bg-zinc-700" },
  {
    icon: TrendingUp,
    name: "Marketing",
    color: "bg-zinc-800",
  },
  {
    icon: HeartHandshake,
    name: "Career Coach",
    color: "bg-zinc-900",
  },
  {
    icon: GraduationCap,
    name: "Education",
    color: "bg-zinc-700",
  },
  {
    icon: Lightbulb,
    name: "Startups",
    color: "bg-zinc-800",
  },
  {
    icon: Globe,
    name: "Languages",
    color: "bg-zinc-900",
  },
];

export const BENEFITS = [
  {
    title: "Accelerate Your Growth",
    description:
      "Gain years of industry insights in hours through personalized 1-on-1 sessions with vetted experts.",
    icon: Zap,
  },
  {
    title: "Build Your Network",
    description:
      "Connect with industry leaders and like-minded professionals in our exclusive community events.",
    icon: Users,
  },
  {
    title: "Learn From The Best",
    description:
      "Access cutting-edge knowledge from top professionals across tech, business, design, and more.",
    icon: GraduationCap,
  },
  {
    title: "Flexible Learning",
    description:
      "Choose your schedule, pace, and learning format. From quick consultations to comprehensive courses.",
    icon: Calendar,
  },
];

export const HOW_IT_WORKS = [
  {
    step: 1,
    title: "Find Your Expert",
    description:
      "Browse our curated network of verified professionals across various domains.",
  },
  {
    step: 2,
    title: "Book a Session",
    description:
      "Choose your preferred time slot and session type that fits your schedule.",
  },
  {
    step: 3,
    title: "Connect & Learn",
    description:
      "Join your session via our platform and start your transformation journey.",
  },
  {
    step: 4,
    title: "Grow Together",
    description:
      "Continue learning with follow-ups, resources, and our supportive community.",
  },
];

export const SUCCESS_STORIES = [
  {
    name: "Sarah Chen",
    role: "Software Engineer → Tech Lead",
    company: "Google",
    image: "/placeholder-user.jpg",
    story:
      "After 3 months of mentorship, I successfully transitioned from an individual contributor to leading a team of 8 engineers.",
    metric: "50% salary increase",
  },
  {
    name: "Marcus Johnson",
    role: "Student → Product Manager",
    company: "Stripe",
    image: "/placeholder-user.jpg",
    story:
      "My mentor helped me break into product management with zero experience. The mock interviews were game-changing.",
    metric: "Landed dream job",
  },
  {
    name: "Elena Rodriguez",
    role: "Designer → Design Director",
    company: "Airbnb",
    image: "/placeholder-user.jpg",
    story:
      "The strategic guidance I received helped me build a portfolio that stood out and accelerated my career.",
    metric: "3 promotions in 2 years",
  },
];

export const PLATFORM_FEATURES = [
  {
    icon: Monitor,
    title: "HD Video Calls",
    description:
      "Crystal clear video with screen sharing powered by Stream. Works on any device.",
  },
  {
    icon: Calendar,
    title: "Smart Scheduling",
    description:
      "Automatic timezone detection with weekly and custom availability slots.",
  },
  {
    icon: Lock,
    title: "Secure Payments",
    description:
      "Protected transactions with Stripe & Razorpay. Refunds and dispute handling built-in.",
  },
  {
    icon: LayoutDashboard,
    title: "Personal Dashboard",
    description:
      "Your command center for bookings, sessions, earnings, and analytics—all in one place.",
  },
  {
    icon: Video,
    title: "Session Recordings",
    description:
      "Record your sessions with one click. Review key moments and insights anytime.",
  },
  {
    icon: Star,
    title: "Reviews & Ratings",
    description:
      "Rate your sessions and read verified reviews to find the perfect expert.",
  },
  {
    icon: BadgeCheck,
    title: "Verified Profiles",
    description:
      "Document-based verification for consultants. Staff review ensures quality experts.",
  },
  {
    icon: MessageSquare,
    title: "In-app Messaging",
    description:
      "Direct communication with experts. Create support tickets and track issue resolution.",
  },
  {
    icon: HeadphonesIcon,
    title: "Support System",
    description:
      "Priority-based ticket system with issue tracking for sessions, payments, and more.",
  },
  {
    icon: FileCheck,
    title: "Document Review",
    description:
      "Upload resumes, portfolios, or documents for expert review with detailed feedback.",
  },
  {
    icon: BookOpen,
    title: "Learning Materials",
    description:
      "Consultants upload resources, guides, and materials for each plan you purchase.",
  },
  {
    icon: ListChecks,
    title: "Live Seat Counts",
    description:
      "Every webinar and class shows exactly how many seats are left, and hosts can open more at any time.",
  },
];

export const TRUST_BADGES = [
  {
    icon: Shield,
    label: "Verified Experts",
    description: "All mentors are background-checked",
  },
  {
    icon: Lock,
    label: "Secure Platform",
    description: "Bank-level encryption for all data",
  },
  {
    icon: Clock,
    label: "Money-back Guarantee",
    description: "Full refund if not satisfied",
  },
  {
    icon: Award,
    label: "Quality Assured",
    // #1485 — was "4.9★ average session rating", a number with nothing behind
    // it. What replaces it is a property of the review system itself, so it
    // stays true at every scale.
    description: "Ratings come only from verified session participants",
  },
];

export const UPCOMING_EVENTS = [
  {
    title: "Breaking into Tech Leadership",
    host: "David Park",
    date: "Dec 20, 2025",
    time: "6:00 PM EST",
    attendees: 156,
    type: "Webinar",
  },
  {
    title: "Portfolio Review Workshop",
    host: "Lisa Wang",
    date: "Dec 22, 2025",
    time: "2:00 PM EST",
    attendees: 89,
    type: "Workshop",
  },
  {
    title: "Startup Fundraising 101",
    host: "Alex Rivera",
    date: "Dec 28, 2025",
    time: "11:00 AM EST",
    attendees: 234,
    type: "Class",
  },
];

export const FAQ_ITEMS = [
  {
    question: "How do I find the right expert for my needs?",
    answer:
      "Our platform features detailed expert profiles with specializations, reviews, and ratings. You can filter by domain, experience level, availability, and price range. We also offer a matching service for personalized recommendations.",
  },
  {
    question: "What types of sessions are available?",
    answer:
      "We offer four main formats: 1-on-1 video consultations for personalized guidance, subscription plans for ongoing mentorship, structured classes for in-depth learning, and live webinars for group learning and networking.",
  },
  {
    question: "How does the payment and refund process work?",
    answer:
      "We use secure payment processing. Payment is held in escrow until your session is completed. If you're not satisfied or your session doesn't happen, you can request a full refund within our guarantee period.",
  },
  {
    question: "Can I become an expert on the platform?",
    answer:
      "Yes! We're always looking for qualified professionals. Apply through our 'Become an Expert' page. We verify credentials and experience to ensure quality for our users.",
  },
  {
    question: "What if I need to reschedule a session?",
    answer:
      "You can reschedule up to 24 hours before your session at no extra cost. Both you and your expert receive notifications, and you can pick a new time that works for both parties.",
  },
];

export const COMPANY_LOGOS = [
  "Google",
  "Microsoft",
  "Amazon",
  "Meta",
  "Apple",
  "Netflix",
  "Stripe",
  "Airbnb",
];

export const ENTERPRISE_FEATURES = [
  {
    icon: Users,
    title: "Team training",
    description:
      "Book vetted experts for a whole team, with one plan covering every seat instead of individual expensing.",
  },
  {
    icon: Briefcase,
    title: "Sponsored sessions",
    description:
      "Your organisation pays; your people book. Set a budget or a per-seat allowance and let them choose their own experts.",
  },
  {
    icon: FileCheck,
    title: "Invoicing built for procurement",
    description:
      "Purchase orders, GST-compliant invoices, and Net-60 terms — not a corporate card and a pile of receipts.",
  },
  {
    icon: Shield,
    title: "Run your own expert network",
    description:
      "Agencies and institutions can host their experts on Familiarise and take a share of every booking.",
  },
];
