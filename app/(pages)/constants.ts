// Company Information - Update these values with your actual business details
export const COMPANY_INFO = {
  name: "Practitionist",
  // TODO: real contact email before launch
  email: "[EMAIL]",
  // TODO: real contact email before launch
  supportEmail: "[SUPPORT_EMAIL]",
  phone: "[PHONE]",
  jurisdiction: "[JURISDICTION]",
} as const;

// Policy Dates - Update when policies are revised
export const POLICY_DATES = {
  privacyLastUpdated: "[LAST UPDATED]",
  termsLastUpdated: "[LAST UPDATED]",
  refundLastUpdated: "[LAST UPDATED]",
} as const;

// Business Hours
export const BUSINESS_HOURS = {
  weekdays: "Monday - Friday: 9:00 AM - 6:00 PM IST",
  saturday: "Saturday: 10:00 AM - 4:00 PM IST",
  sunday: "Sunday: Closed",
} as const;

// Contact Form Categories
export const INQUIRY_CATEGORIES = [
  { value: "", label: "Select a category" },
  { value: "general", label: "General Inquiry" },
  { value: "technical", label: "Technical Support" },
  { value: "billing", label: "Billing & Payments" },
  { value: "booking", label: "Booking Issues" },
  { value: "consultant", label: "Consultant Support" },
  // #1230 wave-4b — the enterprise funnel (#1132): these two route into the
  // Lead pipeline instead of the support queue.
  { value: "enterprise", label: "Enterprise / Platform demo" },
  { value: "team-training", label: "Team training program" },
  { value: "feedback", label: "Feedback" },
  { value: "other", label: "Other" },
] as const;

// Support Resources Links
export const SUPPORT_LINKS = [
  { href: "/pricing", label: "Pricing & Platform Fees" },
  { href: "/refund", label: "Cancellation & Refund Policy" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms & Conditions" },
] as const;

// Page Meta Information
export const PAGE_META = {
  about: {
    title: "About Familiarise",
    description:
      "Connecting expert consultants with learners worldwide through live, interactive educational experiences",
  },
  contact: {
    title: "Contact Us",
    description:
      "We're here to help! Reach out to us with any questions, concerns, or feedback.",
  },
  pricing: {
    title: "Pricing",
    description: "Transparent, consultant-driven pricing with no hidden fees",
  },
  privacy: {
    title: "Privacy Policy",
    description:
      "Your privacy is important to us. This policy explains how we collect, use, and protect your personal information.",
  },
  terms: {
    title: "Terms & Conditions",
    description: "Please read these terms carefully before using our services",
  },
  refund: {
    title: "Cancellation & Refund Policy",
    description:
      "Understanding our cancellation and refund procedures for all service types",
  },
} as const;

// About Page Data
export const ABOUT_DATA = {
  mission:
    "To democratize access to quality education by connecting learners with expert consultants and educators from around the world. We strive to make personalized learning accessible, affordable, and effective for everyone.",
  vision:
    "To become the world's leading platform for live, interactive learning experiences where knowledge flows freely between experts and learners, fostering a global community of continuous growth and development.",
  offerings: [
    {
      title: "Live Classes",
      description:
        "Interactive group learning sessions with scheduled appointments and real-time engagement",
    },
    {
      title: "Webinars",
      description:
        "Large-scale educational events and workshops on diverse topics",
    },
    {
      title: "1-on-1 Consultations",
      description:
        "Personalized expert guidance sessions tailored to your specific needs",
    },
    {
      title: "Subscriptions",
      description:
        "Ongoing learning programs with recurring sessions and continuous support",
    },
  ],
  howItWorks: [
    {
      step: 1,
      title: "Discover Experts",
      description:
        "Browse our curated list of verified consultants and educators across various domains",
    },
    {
      step: 2,
      title: "Book & Pay Securely",
      description:
        "Choose your session, schedule your appointment, and make secure payments through our integrated payment system",
    },
    {
      step: 3,
      title: "Learn & Grow",
      description:
        "Join live sessions via integrated video conferencing, interact in real-time, and access course materials",
    },
  ],
  benefits: [
    {
      title: "Verified Experts",
      description: "All consultants are verified and reviewed by students",
    },
    {
      title: "Secure Payments",
      description: "Industry-standard payment processing with Razorpay",
    },
    {
      title: "Flexible Scheduling",
      description:
        "Book sessions at your convenience with real-time availability",
    },
    {
      title: "Integrated Platform",
      description: "Video conferencing, chat, and materials all in one place",
    },
    {
      title: "Transparent Pricing",
      description: "Clear pricing with no hidden fees",
    },
    {
      title: "24/7 Support",
      description: "Dedicated customer support to help you anytime",
    },
  ],
} as const;

// Pricing Page Data
export const PRICING_DATA = {
  howItWorks: [
    "Consultants set their own rates based on their expertise and market demand",
    "You see the exact price before booking any session",
    "No hidden fees - the displayed price is what you pay",
    "Platform commission is already included in the price",
  ],
  commissionBenefits: [
    "Maintain secure payment processing infrastructure",
    "Provide integrated video conferencing and communication tools",
    "Host and deliver course materials and content",
    "Ensure platform security and data protection",
    "Offer 24/7 customer support",
    "Continuously improve the user experience",
  ],
  paymentMethods: [
    "Credit Cards",
    "Debit Cards",
    "UPI",
    "Net Banking",
    "Wallets",
  ],
  faqs: [
    {
      question: "How do I know the price before booking?",
      answer:
        "The price for each service is clearly displayed on the consultant's profile and on the booking page. You will see the exact amount you need to pay before confirming your booking.",
    },
    {
      question: "Are there any additional fees?",
      answer:
        "No, there are no hidden fees. The price displayed is the final amount you will pay. The platform commission is already included in the displayed price.",
    },
    {
      question: "Can I get a refund if I cancel?",
      answer:
        "Yes, refunds are available based on our cancellation policy. The refund eligibility depends on when you cancel and the type of service.",
    },
    {
      question: "Why do prices vary between consultants?",
      answer:
        "Consultants set their own prices based on their expertise, experience, qualifications, and market demand. This allows you to choose consultants that fit your budget while ensuring consultants are fairly compensated for their knowledge and time.",
    },
    {
      question: "Do you offer discounts or promotional pricing?",
      answer:
        "Individual consultants may offer promotional pricing or discounts for their services. These will be clearly displayed on their profiles and during the booking process. We also occasionally run platform-wide promotions - subscribe to our newsletter to stay updated.",
    },
    {
      question: "How are consultants paid?",
      answer:
        "Consultants receive their earnings after the session is completed successfully. The platform commission is automatically deducted, and the remaining amount is transferred to the consultant's registered bank account according to the settlement schedule.",
    },
  ],
} as const;

// Helper function to get mailto link
export const getMailtoLink = (email: string = COMPANY_INFO.email) =>
  `mailto:${email}`;

// Helper function to get tel link
export const getTelLink = (phone: string = COMPANY_INFO.phone) =>
  `tel:${phone}`;
