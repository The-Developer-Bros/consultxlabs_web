/**
 * Utility functions for seed data generation
 */

import { faker } from "@faker-js/faker";
import { prorate } from "../../lib/payments/utils/money";

/**
 * Sanitizes a string by removing null bytes and control characters that can cause PostgreSQL errors
 */
export function sanitizeString(input: string): string {
  if (!input) return input;

  return input
    .replace(/\0/g, "") // Remove null bytes
    .replace(/[\x00-\x1F\x7F]/g, "") // Remove control characters
    .trim();
}

/**
 * Sanitizes an email address while preserving validity
 */
export function sanitizeEmail(email: string): string {
  if (!email) return email;

  // Split email into local and domain parts
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return sanitizeString(email);

  const localPart = sanitizeString(email.substring(0, atIndex));
  const domainPart = sanitizeString(email.substring(atIndex + 1));

  // Ensure we have valid parts
  if (!localPart || !domainPart) {
    return "fallback@example.com";
  }

  return `${localPart}@${domainPart}`;
}

/**
 * Sanitizes a phone number while preserving format
 */
export function sanitizePhone(phone: string): string {
  if (!phone) return phone;

  // Remove null bytes and control characters, but keep phone number characters
  return phone
    .replace(/\0/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
    .trim();
}

/**
 * Random helper to pick from an array
 */
export function randomFromArray<T>(arr: T[]): T {
  return faker.helpers.arrayElement(arr);
}

/**
 * Generate a random date of birth for adults (18-65 years old)
 */
export function generateDateOfBirth(): Date {
  const now = new Date();
  const minAge = 18;
  const maxAge = 65;
  const minDate = new Date(
    now.getFullYear() - maxAge,
    now.getMonth(),
    now.getDate(),
  );
  const maxDate = new Date(
    now.getFullYear() - minAge,
    now.getMonth(),
    now.getDate(),
  );
  return faker.date.between({ from: minDate, to: maxDate });
}

/**
 * Generate a realistic bio (max 160 chars)
 */
export function generateBio(): string {
  const bios = [
    "Passionate about helping others grow. Technology enthusiast and lifelong learner.",
    "Experienced professional dedicated to mentoring the next generation of leaders.",
    "Building bridges between ambition and achievement through personalized guidance.",
    "Turning career challenges into opportunities for growth and success.",
    "Committed to unlocking potential and fostering professional development.",
    "Helping professionals navigate their career journey with clarity and purpose.",
    "Your success is my mission. Let's achieve your goals together.",
    "Bringing 10+ years of industry experience to help you succeed.",
    "Career strategist helping professionals reach their full potential.",
    "Transforming careers through expert guidance and actionable insights.",
  ];
  return faker.helpers.arrayElement(bios);
}

/**
 * Generate a professional headline (max 120 chars)
 */
export function generateHeadline(domain: string): string {
  const headlines = [
    `Senior ${domain} Expert | Helping Professionals Excel`,
    `${domain} Consultant | Career Coach | Mentor`,
    `Experienced ${domain} Professional | Building Future Leaders`,
    `${domain} Specialist | 10+ Years Experience`,
    `${domain} Mentor | Transforming Careers`,
    `Award-winning ${domain} Consultant | Speaker`,
    `${domain} Strategist | Executive Coach`,
    `Certified ${domain} Expert | Industry Leader`,
  ];
  return faker.helpers.arrayElement(headlines);
}

/**
 * Generate programming languages/spoken languages
 */
export function generateLanguages(): string[] {
  const languages = [
    "English",
    "Spanish",
    "French",
    "German",
    "Chinese",
    "Hindi",
    "Portuguese",
    "Japanese",
    "Korean",
    "Arabic",
    "Italian",
    "Russian",
  ];
  const count = faker.number.int({ min: 1, max: 4 });
  return faker.helpers.arrayElements(languages, count);
}

/**
 * Generate tools and technologies based on domain
 */
export function generateToolsAndTechnologies(domain: string): string[] {
  const toolsByDomain: Record<string, string[]> = {
    Technology: [
      "JavaScript",
      "TypeScript",
      "Python",
      "React",
      "Node.js",
      "AWS",
      "Docker",
      "Kubernetes",
      "Git",
      "PostgreSQL",
      "MongoDB",
      "Redis",
      "GraphQL",
      "REST APIs",
    ],
    Business: [
      "Excel",
      "PowerPoint",
      "Tableau",
      "Power BI",
      "Salesforce",
      "HubSpot",
      "SAP",
      "Jira",
      "Confluence",
      "Slack",
    ],
    Health: [
      "EMR Systems",
      "Telehealth Platforms",
      "HIPAA Compliance",
      "Health Analytics",
      "Patient Management",
    ],
    Education: [
      "LMS Platforms",
      "Moodle",
      "Canvas",
      "Google Classroom",
      "Zoom",
      "Microsoft Teams",
    ],
    "Creative Arts": [
      "Adobe Photoshop",
      "Adobe Illustrator",
      "Figma",
      "Sketch",
      "InVision",
      "After Effects",
      "Premiere Pro",
    ],
    "Personal Development": [
      "Coaching Frameworks",
      "Assessment Tools",
      "Goal Setting Methods",
      "Time Management Systems",
    ],
  };

  const tools = toolsByDomain[domain] || toolsByDomain["Technology"];
  const count = faker.number.int({ min: 3, max: 8 });
  return faker.helpers.arrayElements(tools, count);
}

/**
 * Generate mentoring style description
 */
export function generateMentoringStyle(): string {
  const styles = [
    "I believe in a collaborative approach where we work together to identify your goals and create actionable plans. My style is supportive yet challenging, pushing you to grow while providing the guidance you need.",
    "My mentoring philosophy centers on practical, hands-on learning. We'll tackle real-world challenges together, building your skills through direct experience and constructive feedback.",
    "I focus on building lasting habits and mindsets rather than quick fixes. Through structured sessions and accountability, we'll develop sustainable growth patterns that serve you long-term.",
    "I combine strategic thinking with emotional intelligence to help you navigate both technical and interpersonal challenges. Expect honest feedback delivered with empathy.",
    "My approach is highly personalized - I adapt my style to match your learning preferences and goals. Whether you need intensive coaching or gentle guidance, I adjust accordingly.",
    "I emphasize self-discovery and empowerment. Rather than giving you all the answers, I'll help you develop the frameworks and critical thinking skills to solve problems independently.",
  ];
  return faker.helpers.arrayElement(styles);
}

/**
 * Generate skills to develop for consultees
 */
export function generateSkillsToDevelop(): string[] {
  const skills = [
    "Leadership",
    "Communication",
    "Technical Skills",
    "Project Management",
    "Strategic Thinking",
    "Negotiation",
    "Public Speaking",
    "Data Analysis",
    "Problem Solving",
    "Time Management",
    "Team Collaboration",
    "Career Planning",
    "Networking",
    "Interview Skills",
    "Executive Presence",
  ];
  const count = faker.number.int({ min: 2, max: 5 });
  return faker.helpers.arrayElements(skills, count);
}

/**
 * Generate industries for consultees
 */
export function generateIndustry(): string {
  const industries = [
    "Technology",
    "Finance",
    "Healthcare",
    "Education",
    "Consulting",
    "Marketing",
    "Manufacturing",
    "Retail",
    "Real Estate",
    "Media & Entertainment",
    "Non-profit",
    "Government",
    "Legal",
    "Energy",
    "Telecommunications",
  ];
  return faker.helpers.arrayElement(industries);
}

/**
 * Generate realistic company names
 */
const COMPANY_DOMAIN_MAP: Record<string, string> = {
  Google: "google.com",
  Microsoft: "microsoft.com",
  Amazon: "amazon.com",
  Meta: "meta.com",
  Apple: "apple.com",
  Netflix: "netflix.com",
  Salesforce: "salesforce.com",
  Oracle: "oracle.com",
  IBM: "ibm.com",
  Accenture: "accenture.com",
  Deloitte: "deloitte.com",
  McKinsey: "mckinsey.com",
  "Goldman Sachs": "goldmansachs.com",
  "JP Morgan": "jpmorgan.com",
  Stripe: "stripe.com",
  Uber: "uber.com",
  Airbnb: "airbnb.com",
  Spotify: "spotify.com",
  Adobe: "adobe.com",
  Cisco: "cisco.com",
  VMware: "vmware.com",
  Snowflake: "snowflake.com",
  Databricks: "databricks.com",
  Palantir: "palantir.com",
  Coinbase: "coinbase.com",
};

export function generateCompanyName(): string {
  const companies = [
    ...Object.keys(COMPANY_DOMAIN_MAP),
    faker.company.name(),
    faker.company.name(),
    faker.company.name(),
  ];
  return faker.helpers.arrayElement(companies);
}

/** Get the domain for a known company name, or null for unknown companies */
export function getCompanyDomain(companyName: string): string | null {
  return COMPANY_DOMAIN_MAP[companyName] || null;
}

/**
 * Generate job titles
 */
export function generateJobTitle(domain: string): string {
  const titlesByDomain: Record<string, string[]> = {
    Technology: [
      "Software Engineer",
      "Senior Software Engineer",
      "Staff Engineer",
      "Principal Engineer",
      "Engineering Manager",
      "VP of Engineering",
      "CTO",
      "Tech Lead",
      "DevOps Engineer",
      "Data Scientist",
      "Product Manager",
    ],
    Business: [
      "Business Analyst",
      "Management Consultant",
      "Strategy Manager",
      "Operations Director",
      "VP of Operations",
      "COO",
      "Project Manager",
      "Business Development Manager",
    ],
    Health: [
      "Health Coach",
      "Wellness Consultant",
      "Fitness Director",
      "Nutrition Specialist",
      "Mental Health Counselor",
      "Physical Therapist",
    ],
    Education: [
      "Curriculum Developer",
      "Educational Consultant",
      "Training Manager",
      "Learning Designer",
      "Academic Advisor",
      "Department Head",
    ],
    "Creative Arts": [
      "Creative Director",
      "UI/UX Designer",
      "Art Director",
      "Brand Designer",
      "Motion Designer",
      "Design Lead",
    ],
    "Personal Development": [
      "Life Coach",
      "Career Coach",
      "Executive Coach",
      "Leadership Consultant",
      "Performance Coach",
    ],
  };

  const titles = titlesByDomain[domain] || titlesByDomain["Technology"];
  return faker.helpers.arrayElement(titles);
}

/**
 * Generate certification names based on domain
 */
export function generateCertificationName(domain: string): string {
  const certsByDomain: Record<string, string[]> = {
    Technology: [
      "AWS Solutions Architect",
      "AWS Developer Associate",
      "Google Cloud Professional",
      "Azure Solutions Architect",
      "Kubernetes Administrator (CKA)",
      "Certified Scrum Master (CSM)",
      "PMP Certification",
      "CISSP",
      "Terraform Associate",
      "Docker Certified Associate",
    ],
    Business: [
      "Six Sigma Black Belt",
      "PMP Certification",
      "MBA",
      "CFA Charterholder",
      "CPA Certification",
      "SHRM-CP",
      "Lean Certification",
      "Change Management Certification",
    ],
    Health: [
      "ACE Certified Personal Trainer",
      "Registered Dietitian (RD)",
      "Certified Health Coach",
      "CPR/AED Certification",
      "Yoga Alliance RYT-200",
      "NASM Certified",
    ],
    Education: [
      "TESOL Certification",
      "Teaching License",
      "Instructional Design Certificate",
      "EdTech Certification",
      "Curriculum Development Certificate",
    ],
    "Creative Arts": [
      "Adobe Certified Expert",
      "UX Design Certificate",
      "Google UX Design",
      "Interaction Design Foundation",
      "HCD Certification",
    ],
    "Personal Development": [
      "ICF Certified Coach (ACC/PCC/MCC)",
      "Life Coaching Certification",
      "NLP Practitioner",
      "Executive Coaching Certificate",
      "Leadership Development Certificate",
    ],
  };

  const certs = certsByDomain[domain] || certsByDomain["Technology"];
  return faker.helpers.arrayElement(certs);
}

/**
 * Generate issuing organizations for certifications
 */
export function generateIssuingOrganization(certName: string): string {
  const orgMap: Record<string, string> = {
    AWS: "Amazon Web Services",
    Google: "Google Cloud",
    Azure: "Microsoft",
    Kubernetes: "Cloud Native Computing Foundation",
    Scrum: "Scrum Alliance",
    PMP: "Project Management Institute",
    CISSP: "ISC2",
    Terraform: "HashiCorp",
    Docker: "Docker Inc.",
    "Six Sigma": "ASQ",
    CFA: "CFA Institute",
    CPA: "AICPA",
    SHRM: "SHRM",
    ACE: "American Council on Exercise",
    NASM: "National Academy of Sports Medicine",
    Yoga: "Yoga Alliance",
    TESOL: "TESOL International Association",
    Adobe: "Adobe Inc.",
    ICF: "International Coaching Federation",
    NLP: "NLP Association",
  };

  for (const [key, org] of Object.entries(orgMap)) {
    if (certName.includes(key)) {
      return org;
    }
  }
  return faker.company.name();
}

/**
 * Generate universities/institutions
 */
export function generateInstitution(): string {
  const institutions = [
    "Stanford University",
    "MIT",
    "Harvard University",
    "UC Berkeley",
    "Carnegie Mellon University",
    "University of Michigan",
    "Georgia Tech",
    "University of Texas at Austin",
    "University of Washington",
    "Columbia University",
    "NYU",
    "UCLA",
    "University of Chicago",
    "Northwestern University",
    "Duke University",
    "University of Pennsylvania",
    "Cornell University",
    "Yale University",
    "Princeton University",
    "University of Illinois",
    "University of Toronto",
    "Oxford University",
    "Cambridge University",
    "Imperial College London",
    "ETH Zurich",
    "National University of Singapore",
    "IIT Delhi",
    "IIT Bombay",
    faker.company.name() + " University",
  ];
  return faker.helpers.arrayElement(institutions);
}

/**
 * Generate degree types
 */
export function generateDegree(): string {
  const degrees = [
    "Bachelor of Science",
    "Bachelor of Arts",
    "Bachelor of Engineering",
    "Bachelor of Business Administration",
    "Master of Science",
    "Master of Business Administration",
    "Master of Engineering",
    "Master of Arts",
    "Doctor of Philosophy",
    "Associate Degree",
  ];
  return faker.helpers.arrayElement(degrees);
}

/**
 * Generate field of study based on domain
 */
export function generateFieldOfStudy(domain: string): string {
  const fieldsByDomain: Record<string, string[]> = {
    Technology: [
      "Computer Science",
      "Software Engineering",
      "Information Technology",
      "Data Science",
      "Electrical Engineering",
      "Computer Engineering",
      "Cybersecurity",
      "Artificial Intelligence",
    ],
    Business: [
      "Business Administration",
      "Finance",
      "Marketing",
      "Economics",
      "Management",
      "Accounting",
      "Operations Management",
      "International Business",
    ],
    Health: [
      "Public Health",
      "Nutrition",
      "Kinesiology",
      "Health Sciences",
      "Psychology",
      "Nursing",
      "Physical Therapy",
    ],
    Education: [
      "Education",
      "Educational Psychology",
      "Curriculum Development",
      "Special Education",
      "Educational Technology",
      "Teaching",
    ],
    "Creative Arts": [
      "Graphic Design",
      "Fine Arts",
      "Digital Media",
      "Visual Communication",
      "Interactive Design",
      "Film Studies",
    ],
    "Personal Development": [
      "Psychology",
      "Counseling",
      "Organizational Development",
      "Human Resources",
      "Leadership Studies",
    ],
  };

  const fields = fieldsByDomain[domain] || fieldsByDomain["Technology"];
  return faker.helpers.arrayElement(fields);
}

/**
 * Generate countries
 */
export function generateCountry(): string {
  const countries = [
    "United States",
    "Canada",
    "United Kingdom",
    "Germany",
    "France",
    "Australia",
    "India",
    "Singapore",
    "Japan",
    "Netherlands",
    "Sweden",
    "Switzerland",
    "Ireland",
    "Brazil",
    "Mexico",
    "UAE",
    "South Korea",
    "Spain",
    "Italy",
    "New Zealand",
  ];
  return faker.helpers.arrayElement(countries);
}

/**
 * Generate cities based on country
 */
export function generateCity(country: string): string {
  const citiesByCountry: Record<string, string[]> = {
    "United States": [
      "San Francisco",
      "New York",
      "Seattle",
      "Austin",
      "Boston",
      "Los Angeles",
      "Chicago",
      "Denver",
      "Portland",
      "Miami",
    ],
    Canada: ["Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa"],
    "United Kingdom": ["London", "Manchester", "Edinburgh", "Bristol", "Leeds"],
    Germany: ["Berlin", "Munich", "Frankfurt", "Hamburg", "Cologne"],
    France: ["Paris", "Lyon", "Marseille", "Toulouse", "Nice"],
    Australia: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide"],
    India: [
      "Bangalore",
      "Mumbai",
      "Delhi",
      "Hyderabad",
      "Chennai",
      "Pune",
      "Kolkata",
    ],
    Singapore: ["Singapore"],
    Japan: ["Tokyo", "Osaka", "Kyoto", "Yokohama", "Nagoya"],
    Netherlands: ["Amsterdam", "Rotterdam", "The Hague", "Utrecht"],
    Sweden: ["Stockholm", "Gothenburg", "Malmo"],
    Switzerland: ["Zurich", "Geneva", "Basel", "Bern"],
    Ireland: ["Dublin", "Cork", "Galway"],
    Brazil: ["Sao Paulo", "Rio de Janeiro", "Brasilia"],
    Mexico: ["Mexico City", "Guadalajara", "Monterrey"],
    UAE: ["Dubai", "Abu Dhabi"],
    "South Korea": ["Seoul", "Busan", "Incheon"],
    Spain: ["Madrid", "Barcelona", "Valencia"],
    Italy: ["Milan", "Rome", "Florence"],
    "New Zealand": ["Auckland", "Wellington", "Christchurch"],
  };

  const cities = citiesByCountry[country] || ["Unknown City"];
  return faker.helpers.arrayElement(cities);
}

// ============================================================
// PAYOUT SYSTEM UTILITIES
// ============================================================

/**
 * Indian bank data for realistic payout account generation
 */
export const INDIAN_BANKS = [
  { name: "HDFC Bank", ifscPrefix: "HDFC0" },
  { name: "ICICI Bank", ifscPrefix: "ICIC0" },
  { name: "State Bank of India", ifscPrefix: "SBIN0" },
  { name: "Axis Bank", ifscPrefix: "UTIB0" },
  { name: "Kotak Mahindra Bank", ifscPrefix: "KKBK0" },
  { name: "Punjab National Bank", ifscPrefix: "PUNB0" },
  { name: "Bank of Baroda", ifscPrefix: "BARB0" },
  { name: "Yes Bank", ifscPrefix: "YESB0" },
  { name: "IndusInd Bank", ifscPrefix: "INDB0" },
  { name: "IDBI Bank", ifscPrefix: "IBKL0" },
  { name: "Federal Bank", ifscPrefix: "FDRL0" },
  { name: "Canara Bank", ifscPrefix: "CNRB0" },
] as const;

export type IndianBank = (typeof INDIAN_BANKS)[number];

/**
 * UPI suffixes for realistic UPI ID generation
 */
export const UPI_SUFFIXES = [
  "@upi",
  "@paytm",
  "@gpay",
  "@phonepe",
  "@ybl",
  "@okaxis",
  "@okhdfcbank",
  "@okicici",
  "@oksbi",
  "@apl",
] as const;

/**
 * Generate realistic IFSC code for a bank
 * IFSC format: 4 letter bank code + 0 + 6 digit branch code
 */
export function generateIfscCode(bank: IndianBank): string {
  const branchCode = faker.string.numeric(6);
  return `${bank.ifscPrefix}${branchCode}`;
}

/**
 * Generate realistic UPI ID from user name
 * Format: sanitizedname@suffix
 */
export function generateUpiId(userName: string): string {
  const cleanName = userName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20);
  const suffix = faker.helpers.arrayElement(UPI_SUFFIXES);
  // Add random numbers for uniqueness
  const randomNum = faker.string.numeric({ length: { min: 0, max: 4 } });
  return `${cleanName}${randomNum}${suffix}`;
}

/**
 * Generate Razorpay Contact ID
 * Format: cont_XXXXXXXXXXXX (14 alphanumeric chars)
 */
export function generateRazorpayContactId(): string {
  return `cont_${faker.string.alphanumeric(14)}`;
}

/**
 * Generate Razorpay Fund Account ID
 * Format: fa_XXXXXXXXXXXX (14 alphanumeric chars)
 */
export function generateRazorpayFundAccountId(): string {
  return `fa_${faker.string.alphanumeric(14)}`;
}

/**
 * Generate Razorpay Payout ID
 * Format: pout_XXXXXXXXXXXX (14 alphanumeric chars)
 */
export function generateRazorpayPayoutId(): string {
  return `pout_${faker.string.alphanumeric(14)}`;
}

/**
 * Generate Stripe Account ID (for Stripe Connect)
 * Format: acct_XXXXXXXXXXXXXXXX (16 alphanumeric chars)
 */
export function generateStripeAccountId(): string {
  return `acct_${faker.string.alphanumeric(16)}`;
}

/**
 * Generate Stripe Payout ID
 * Format: po_XXXXXXXXXXXXXXXXXXXXXXXX (24 alphanumeric chars)
 */
export function generateStripePayoutId(): string {
  return `po_${faker.string.alphanumeric(24)}`;
}

/**
 * Generate payout batch ID
 * Format: PAYOUT-BATCH-YYYYMMDD-XXXX
 */
export function generateBatchId(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const sequence = faker.string.alphanumeric(4).toUpperCase();
  return `PAYOUT-BATCH-${year}${month}${day}-${sequence}`;
}

/**
 * Generate a unique idempotency key for Razorpay payouts
 * Using UUID v4 format
 */
export function generateIdempotencyKey(): string {
  return faker.string.uuid();
}

/**
 * Generate sequential invoice number
 * Format: FMR-YYYYMM-XXXXX
 */
let invoiceSequence = 0;
export function generateInvoiceNumber(paymentDate: Date): string {
  invoiceSequence++;
  const year = paymentDate.getFullYear();
  const month = String(paymentDate.getMonth() + 1).padStart(2, "0");
  const sequence = String(invoiceSequence).padStart(5, "0");
  return `FMR-${year}${month}-${sequence}`;
}

/**
 * Reset invoice sequence (useful for testing)
 */
export function resetInvoiceSequence(): void {
  invoiceSequence = 0;
}

/**
 * Weighted random selection helper
 * @param items Array of objects with value and weight properties
 * @returns Selected value based on weighted probability
 */
export function weightedRandom<T>(
  items: Array<{ value: T; weight: number }>,
): T {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let random = faker.number.float({ min: 0, max: totalWeight });

  for (const item of items) {
    random -= item.weight;
    if (random <= 0) {
      return item.value;
    }
  }
  return items[items.length - 1].value;
}

/**
 * Platform fee percentage (20%)
 */
export const PLATFORM_FEE_PERCENTAGE = 0.2;

/**
 * Consultant share percentage (80%)
 */
export const CONSULTANT_SHARE_PERCENTAGE = 0.8;

/**
 * Calculate platform fee from gross amount
 * @param grossAmount Amount in smallest currency unit (paise/cents)
 */
export function calculatePlatformFee(grossAmount: number): number {
  // #778 §C-2 — same integer floor as createEarningsFromPayment (prorate);
  // the consultant share absorbs the remainder.
  return prorate(grossAmount, PLATFORM_FEE_PERCENTAGE * 100, 100);
}

/**
 * Calculate consultant share from gross amount
 * @param grossAmount Amount in smallest currency unit (paise/cents)
 */
export function calculateConsultantShare(grossAmount: number): number {
  // Complement of the fee — two independent roundings could miss gross by a
  // paisa and unbalance the seeded booking journal (#773).
  return grossAmount - calculatePlatformFee(grossAmount);
}

/**
 * GST tax rate for services in India (18%)
 */
export const GST_TAX_RATE = 0.18;

/**
 * HSN/SAC code for consulting/advisory services
 */
export const HSN_CODE_CONSULTING = "999293";

/**
 * Calculate tax breakdown from total amount (inclusive of tax)
 * @param totalAmount Total amount including tax
 * @param taxRate Tax rate (default 18% GST)
 * @returns Object with baseAmount and taxAmount
 */
export function calculateTaxBreakdown(
  totalAmount: number,
  taxRate: number = GST_TAX_RATE,
): { baseAmount: number; taxAmount: number } {
  const baseAmount = Math.round(totalAmount / (1 + taxRate));
  const taxAmount = totalAmount - baseAmount;
  return { baseAmount, taxAmount };
}

/**
 * Generate random account number last 4 digits
 */
export function generateAccountNumberLast4(): string {
  return faker.string.numeric(4);
}

/**
 * Generate random hold period in days (7-14 days)
 */
export function generateHoldPeriodDays(): number {
  return faker.number.int({ min: 7, max: 14 });
}

/**
 * Generate a date with hold period added
 */
export function generateHoldUntilDate(fromDate: Date): Date {
  const holdDays = generateHoldPeriodDays();
  const holdUntil = new Date(fromDate);
  holdUntil.setDate(holdUntil.getDate() + holdDays);
  return holdUntil;
}

/**
 * Earning status distribution for seeding
 */
export const EARNING_STATUS_WEIGHTS = [
  { value: "PAID" as const, weight: 0.3 },
  { value: "READY" as const, weight: 0.3 },
  { value: "PENDING" as const, weight: 0.25 },
  { value: "HELD" as const, weight: 0.1 },
  { value: "REFUNDED" as const, weight: 0.05 },
];

/**
 * Payout status distribution for seeding
 */
export const PAYOUT_STATUS_WEIGHTS = [
  { value: "COMPLETED" as const, weight: 0.5 },
  { value: "PROCESSING" as const, weight: 0.2 },
  { value: "PENDING" as const, weight: 0.15 },
  { value: "APPROVED" as const, weight: 0.1 },
  { value: "FAILED" as const, weight: 0.05 },
];

/**
 * Payout provider distribution for seeding
 */
export const PAYOUT_PROVIDER_WEIGHTS = [
  { value: "RAZORPAY" as const, weight: 0.85 },
  { value: "STRIPE" as const, weight: 0.15 },
];

/**
 * Payout account type distribution for seeding
 */
export const PAYOUT_ACCOUNT_TYPE_WEIGHTS = [
  { value: "BANK_ACCOUNT" as const, weight: 0.6 },
  { value: "UPI" as const, weight: 0.3 },
  { value: "STRIPE_CONNECT" as const, weight: 0.1 },
];

/**
 * Generate failure reason for failed payouts
 */
export function generatePayoutFailureReason(): string {
  const reasons = [
    "Insufficient funds in payout account",
    "Invalid bank account details",
    "Bank account closed",
    "IFSC code mismatch",
    "UPI ID inactive",
    "Transfer limit exceeded",
    "Bank server unavailable",
    "Account holder name mismatch",
    "Beneficiary bank rejected transfer",
    "Timeout while processing",
  ];
  return faker.helpers.arrayElement(reasons);
}
