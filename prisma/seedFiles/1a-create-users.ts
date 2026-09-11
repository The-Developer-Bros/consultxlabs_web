import bcrypt from "bcrypt";
import { faker } from "@faker-js/faker";
import {
  AdminProfile,
  BudgetPreference,
  CareerStage,
  ConsultantProfile,
  ConsultantVerificationStatus,
  ConsulteeProfile,
  Gender,
  Prisma,
  ScheduleType,
  SessionType,
  StaffProfile,
  User,
  UserRole,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  sanitizePhone,
  sanitizeString,
  generateDateOfBirth,
  generateBio,
  generateHeadline,
  generateLanguages,
  generateToolsAndTechnologies,
  generateMentoringStyle,
  generateSkillsToDevelop,
  generateCountry,
  generateCity,
  generateCompanyName,
} from "./utils";
import { config } from "./config";

const SEED_PASSWORD = process.env.SEED_PASSWORD || "SeedPass123!";

export type UserWithProfiles = User & {
  consultantProfile?: ConsultantProfile | null;
  consulteeProfile?: ConsulteeProfile | null;
  staffProfile?: StaffProfile | null;
  adminProfile?: AdminProfile | null;
};

// User distribution - configurable via SEED_MODE environment variable
const NUM_CONSULTANTS = config.volumes.users.consultants;
const NUM_CONSULTEES = config.volumes.users.consultees;
const NUM_STAFF = config.volumes.users.staff;
const NUM_ADMINS = config.volumes.users.admins;
const NUM_USERS = NUM_CONSULTANTS + NUM_CONSULTEES + NUM_STAFF + NUM_ADMINS;

// Gender enum values
const GENDERS: Gender[] = ["MALE", "FEMALE", "NON_BINARY", "PREFER_NOT_TO_SAY"];

// Career stage enum values
const CAREER_STAGES: CareerStage[] = [
  "STUDENT",
  "EARLY_CAREER",
  "MID_CAREER",
  "SENIOR",
  "EXECUTIVE",
];

// Budget preference enum values
const BUDGET_PREFERENCES: BudgetPreference[] = [
  "BUDGET",
  "MODERATE",
  "PREMIUM",
  "FLEXIBLE",
];

// Session type enum values
const SESSION_TYPES: SessionType[] = ["ONE_ON_ONE", "GROUP", "ASYNC_REVIEW"];

// Curated name pools for realistic, consistent seed data
const FIRST_NAMES = [
  "Aarav",
  "Aditi",
  "Alex",
  "Amit",
  "Ananya",
  "Andrew",
  "Angela",
  "Arjun",
  "Benjamin",
  "Catherine",
  "Charlotte",
  "Daniel",
  "David",
  "Elena",
  "Emily",
  "Ethan",
  "Grace",
  "Hannah",
  "Isabella",
  "James",
  "Jessica",
  "John",
  "Karen",
  "Kevin",
  "Lauren",
  "Liam",
  "Maria",
  "Michael",
  "Natalie",
  "Nathan",
  "Olivia",
  "Patrick",
  "Priya",
  "Rachel",
  "Raj",
  "Rebecca",
  "Robert",
  "Samantha",
  "Sarah",
  "Sophia",
  "Thomas",
  "Victoria",
  "William",
  "Zara",
];

const LAST_NAMES = [
  "Anderson",
  "Brown",
  "Campbell",
  "Chen",
  "Davis",
  "Garcia",
  "Gupta",
  "Harris",
  "Jackson",
  "Johnson",
  "Kim",
  "Kumar",
  "Lee",
  "Martin",
  "Miller",
  "Nakamura",
  "Patel",
  "Rodriguez",
  "Sharma",
  "Singh",
  "Smith",
  "Taylor",
  "Thompson",
  "Williams",
  "Wilson",
  "Wright",
  "Young",
];

const EMAIL_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "hotmail.com",
  "protonmail.com",
];

/**
 * Generate a consistent name and email pair from user index.
 * Uses deterministic selection from name pools so names always match emails.
 */
function generateNameAndEmail(index: number): { name: string; email: string } {
  const firstName = FIRST_NAMES[index % FIRST_NAMES.length];
  const lastName =
    LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
  const fullName = `${firstName} ${lastName}`;
  const emailLocal = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`;
  const emailDomain = EMAIL_DOMAINS[index % EMAIL_DOMAINS.length];
  return { name: fullName, email: `${emailLocal}@${emailDomain}` };
}

// Predefined domains, subdomains, and tags
const domains = [
  {
    name: "Technology",
    subdomains: [
      "Web Development",
      "Mobile Development",
      "Data Science",
      "Cloud Computing",
      "Cybersecurity",
      "DevOps",
      "Artificial Intelligence",
      "Blockchain",
      "Software Development",
    ],
    tags: [
      "JavaScript",
      "Python",
      "React",
      "Machine Learning",
      "AWS",
      "Docker",
      "Kubernetes",
      "Node.js",
      "TypeScript",
      "Angular",
      "Vue.js",
      "TensorFlow",
      "Cyber Defense",
      "Cloud Architecture",
      "Smart Contracts",
      "System Design",
      "DSA & Algorithms",
      "Interview Prep",
      "Career Switching",
    ],
  },

  {
    name: "Business",
    subdomains: [
      "Marketing",
      "Finance",
      "Management",
      "Entrepreneurship",
      "Sales",
      "Operations",
      "Human Resources",
      "Strategy",
      "Supply Chain",
    ],
    tags: [
      "Digital Marketing",
      "Financial Planning",
      "Leadership",
      "Business Analytics",
      "Project Management",
      "Risk Management",
      "Strategic Planning",
      "Brand Development",
      "Market Research",
      "Investment Strategy",
      "Team Building",
      "Change Management",
    ],
  },

  {
    name: "Health",
    subdomains: [
      "Nutrition",
      "Fitness",
      "Mental Health",
      "Preventive Care",
      "Physical Therapy",
      "Sports Medicine",
      "Holistic Health",
      "Wellness Coaching",
    ],
    tags: [
      "Diet",
      "Yoga",
      "Meditation",
      "Stress Management",
      "Exercise Science",
      "Mindfulness",
      "Sports Performance",
      "Injury Prevention",
      "Healthy Lifestyle",
      "Weight Management",
      "Mental Wellness",
    ],
  },

  {
    name: "Education",
    subdomains: [
      "K-12 Education",
      "Higher Education",
      "Special Education",
      "Online Learning",
      "Educational Technology",
      "Curriculum Development",
    ],
    tags: [
      "Teaching Methods",
      "E-Learning",
      "Educational Psychology",
      "Instructional Design",
      "Student Assessment",
      "Learning Management Systems",
      "STEM Education",
    ],
  },

  {
    name: "Creative Arts",
    subdomains: [
      "Graphic Design",
      "Digital Art",
      "Photography",
      "Video Production",
      "Animation",
      "UI/UX Design",
    ],
    tags: [
      "Adobe Creative Suite",
      "Visual Design",
      "Motion Graphics",
      "Color Theory",
      "Typography",
      "Digital Photography",
      "Video Editing",
      "User Interface Design",
    ],
  },

  {
    name: "Personal Development",
    subdomains: [
      "Career Coaching",
      "Life Coaching",
      "Communication Skills",
      "Time Management",
      "Personal Finance",
    ],
    tags: [
      "Goal Setting",
      "Public Speaking",
      "Emotional Intelligence",
      "Productivity",
      "Work-Life Balance",
      "Personal Branding",
      "Networking Skills",
    ],
  },
];

async function createDomainsSubdomainsTags() {
  for (const domain of domains) {
    const createdDomain = await prisma.domain.create({
      data: {
        name: domain.name,
        subDomains: {
          create: domain.subdomains.map((sd) => ({ name: sd })),
        },
        tags: {
          create: domain.tags.map((t) => ({ name: t })),
        },
      },
    });
    console.log(`Created domain: ${createdDomain.name}`);
  }
}

async function createConsultantProfileData() {
  // Get all domains with their subdomains and tags
  const allDomains = await prisma.domain.findMany({
    include: {
      subDomains: true,
      tags: true,
    },
  });

  if (allDomains.length === 0) {
    throw new Error("No domains found");
  }

  // Randomly select a domain
  const domain = faker.helpers.arrayElement(allDomains);

  const subDomains = faker.helpers.arrayElements(domain.subDomains, {
    min: 1,
    max: 2,
  });
  const tags = faker.helpers.arrayElements(domain.tags, { min: 2, max: 4 });

  // Generate experience years (1-25)
  const experience = faker.number.float({
    min: 1,
    max: 25,
    multipleOf: 0.5,
  });

  // Generate session types (at least ONE_ON_ONE, possibly more)
  const sessionTypes = faker.helpers.arrayElements(SESSION_TYPES, {
    min: 1,
    max: 3,
  });
  if (!sessionTypes.includes("ONE_ON_ONE")) {
    sessionTypes.push("ONE_ON_ONE");
  }

  // Calculate profile completion percentage based on filled fields
  const profileCompletionPercentage = faker.number.int({ min: 60, max: 100 });

  // Verified status based on experience and completion
  const isVerified =
    experience > 5 && profileCompletionPercentage > 80
      ? faker.datatype.boolean({ probability: 0.7 })
      : faker.datatype.boolean({ probability: 0.2 });

  // Verification status should be consistent with isVerified
  const verificationStatus: ConsultantVerificationStatus = isVerified
    ? ConsultantVerificationStatus.VERIFIED
    : faker.helpers.arrayElement<ConsultantVerificationStatus>([
        ConsultantVerificationStatus.PENDING_VERIFICATION,
        ConsultantVerificationStatus.UNDER_REVIEW,
      ]);

  // Total mentees helped
  const totalMenteesHelped = Math.floor(
    experience * faker.number.int({ min: 5, max: 20 }),
  );

  return {
    rating: faker.number.float({ min: 3.5, max: 5, multipleOf: 0.1 }),
    experience,
    description: sanitizeString(faker.lorem.paragraph()),
    domain: { connect: { id: domain.id } },
    subDomains: {
      connect: subDomains.map((sd) => ({ id: sd.id })),
    },
    tags: {
      connect: tags.map((t) => ({ id: t.id })),
    },
    scheduleType: faker.helpers.arrayElement<ScheduleType>([
      ScheduleType.WEEKLY,
      ScheduleType.CUSTOM,
    ]),

    // Consultant profile fields
    headline: generateHeadline(domain.name),
    websiteUrl: faker.datatype.boolean({ probability: 0.6 })
      ? faker.internet.url()
      : null,
    twitterUrl: faker.datatype.boolean({ probability: 0.5 })
      ? `https://twitter.com/${faker.internet.username()}`
      : null,
    githubUrl: faker.datatype.boolean({ probability: 0.4 })
      ? `https://github.com/${faker.internet.username()}`
      : null,
    videoIntroUrl: faker.datatype.boolean({ probability: 0.3 })
      ? `https://youtube.com/watch?v=${faker.string.alphanumeric(11)}`
      : null,
    languages: generateLanguages(),
    toolsAndTechnologies: generateToolsAndTechnologies(domain.name),
    mentoringStyle: generateMentoringStyle(),
    sessionTypes,
    profileCompletionPercentage,
    isVerified,
    verificationStatus,
    totalMenteesHelped,
    domainName: domain.name, // For passing to work experience generation
  };
}

function createConsulteeProfileData() {
  const careerStage = faker.helpers.arrayElement(CAREER_STAGES);
  const budgetPreference = faker.helpers.arrayElement(BUDGET_PREFERENCES);

  return {
    preferredLanguage: faker.helpers.arrayElement([
      "English",
      "Spanish",
      "French",
      "German",
      "Chinese",
    ]),
    aboutMe: sanitizeString(faker.lorem.paragraph()),
    goals: sanitizeString(faker.lorem.sentence()),
    careerStage,
    skillsToDevelop: generateSkillsToDevelop(),
    budgetPreference,
  };
}

function createStaffProfileData() {
  const departments = [
    "Customer Support",
    "Operations",
    "Quality Assurance",
    "Content Moderation",
    "Training",
  ];
  const positions = [
    "Support Specialist",
    "Operations Coordinator",
    "QA Analyst",
    "Content Moderator",
    "Training Coordinator",
    "Team Lead",
  ];

  return {
    department: faker.helpers.arrayElement(departments),
    position: faker.helpers.arrayElement(positions),
  };
}

function createAdminProfileData(_adminIndex: number): {
  notes: string | null;
} {
  // AdminLevel enum was dropped — all admins are full ADMIN via UserRole.ADMIN.
  // STAFF vs ADMIN differentiation lives on User.role, not AdminProfile.
  return {
    notes: faker.datatype.boolean({ probability: 0.3 })
      ? sanitizeString(faker.lorem.paragraph())
      : null,
  };
}

export async function createUsers(): Promise<UserWithProfiles[]> {
  await createDomainsSubdomainsTags();

  const users: UserWithProfiles[] = [];
  let consultantIndex = 0;
  let consulteeIndex = 0;
  let staffIndex = 0;
  let adminIndex = 0;

  const hashedPassword = await bcrypt.hash(SEED_PASSWORD, 12);
  console.log(`  Password for all seed users: ${SEED_PASSWORD}`);

  console.log(`Creating ${NUM_USERS} users...`);
  console.log(`  - ${NUM_CONSULTANTS} consultants`);
  console.log(`  - ${NUM_CONSULTEES} consultees`);
  console.log(`  - ${NUM_STAFF} staff members`);
  console.log(`  - ${NUM_ADMINS} admins`);

  for (let i = 0; i < NUM_USERS; i++) {
    // Determine user role based on index
    let userRole: UserRole;
    if (consultantIndex < NUM_CONSULTANTS) {
      userRole = "CONSULTANT";
      consultantIndex++;
    } else if (consulteeIndex < NUM_CONSULTEES) {
      userRole = "CONSULTEE";
      consulteeIndex++;
    } else if (staffIndex < NUM_STAFF) {
      userRole = "STAFF";
      staffIndex++;
    } else {
      userRole = "ADMIN";
      adminIndex++;
    }

    try {
      // Generate consistent name and email from index
      const { name, email } = generateNameAndEmail(i);
      const country = generateCountry();
      const city = generateCity(country);
      const gender = faker.helpers.arrayElement(GENDERS);

      const userData: Prisma.UserCreateInput = {
        name,
        email,
        emailVerified: true,
        image: sanitizeString(faker.image.avatar()),
        phone: sanitizePhone(faker.phone.number()),
        address: sanitizeString(faker.location.streetAddress()),
        onlineStatus: faker.datatype.boolean(),
        timezone: sanitizeString(faker.location.timeZone()),
        onboardingCompleted: faker.datatype.boolean(),
        role: userRole,

        // New fields for enhanced user
        dateOfBirth: faker.datatype.boolean({ probability: 0.8 })
          ? generateDateOfBirth()
          : null,
        gender,
        city,
        country,
        linkedinUrl: faker.datatype.boolean({ probability: 0.5 })
          ? `https://linkedin.com/in/${faker.internet.username()}`
          : null,
        bio: faker.datatype.boolean({ probability: 0.7 })
          ? generateBio()
          : null,

        cookiePreferences: {
          create: {
            essential: true,
            analytics: faker.datatype.boolean(),
            marketing: faker.datatype.boolean(),
            functional: faker.datatype.boolean(),
          },
        },
        notificationPreferences: {
          create: {
            allNotifications: faker.datatype.boolean(),
            mentions: faker.datatype.boolean(),
            directMessages: faker.datatype.boolean(),
            updates: faker.datatype.boolean(),
          },
        },
      };

      // Add role-specific profile
      if (userRole === "CONSULTANT") {
        const consultantData = await createConsultantProfileData();
        // Remove the domainName property before passing to Prisma
        const { domainName, ...consultantProfileData } = consultantData;
        userData.consultantProfile = {
          create: consultantProfileData,
        };
      } else if (userRole === "CONSULTEE") {
        userData.consulteeProfile = {
          create: createConsulteeProfileData(),
        };
      } else if (userRole === "STAFF") {
        userData.staffProfile = {
          create: createStaffProfileData(),
        };
      } else if (userRole === "ADMIN") {
        userData.adminProfile = {
          create: createAdminProfileData(adminIndex - 1),
        };
      }

      const user = await prisma.user.create({
        data: userData,
        include: {
          consultantProfile: true,
          consulteeProfile: true,
          staffProfile: true,
          adminProfile: true,
        },
      });

      // Sync the denormalized User.*ProfileId columns the session layer
      // reads (BetterAuth additionalFields). Runtime onboarding sets these;
      // the seed previously left them null — every seeded session then
      // carried an undefined profile id, which (pre-guard) dropped
      // ownership filters in routes that fed it straight into a Prisma
      // where clause.
      await prisma.user.update({
        where: { id: user.id },
        data: {
          consultantProfileId: user.consultantProfile?.id ?? null,
          consulteeProfileId: user.consulteeProfile?.id ?? null,
          staffProfileId: user.staffProfile?.id ?? null,
          adminProfileId: user.adminProfile?.id ?? null,
        },
      });
      // Keep the in-memory object consistent with the row — downstream seed
      // files receive this `user` and would otherwise read stale nulls.
      user.consultantProfileId = user.consultantProfile?.id ?? null;
      user.consulteeProfileId = user.consulteeProfile?.id ?? null;
      user.staffProfileId = user.staffProfile?.id ?? null;
      user.adminProfileId = user.adminProfile?.id ?? null;

      await prisma.account.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          password: hashedPassword,
        },
      });

      // For consultees, add a WorkExperience or Education record at User level
      if (userRole === "CONSULTEE") {
        const consulteeStage = user.consulteeProfile?.careerStage;
        if (consulteeStage === "STUDENT") {
          await prisma.education.create({
            data: {
              userId: user.id,
              institution: faker.helpers.arrayElement([
                "IIT Bombay",
                "Stanford University",
                "MIT",
                "Delhi University",
                "BITS Pilani",
              ]),
              degree: "Student",
              fieldOfStudy: faker.helpers.arrayElement([
                "Computer Science",
                "Engineering",
                "Business",
                "Data Science",
              ]),
              endYear:
                new Date().getFullYear() +
                faker.number.int({ min: 1, max: 3 }),
            },
          });
        } else {
          await prisma.workExperience.create({
            data: {
              userId: user.id,
              company: generateCompanyName(),
              title: sanitizeString(faker.person.jobTitle()),
              isCurrent: true,
              startDate: faker.date.past({ years: 3 }),
            },
          });
        }
      }

      users.push(user);
    } catch (error) {
      console.error("Failed to create user:", error);
    }
    if ((i + 1) % 10 === 0) {
      console.log(`Created ${i + 1} users`);
    }
  }
  console.log(`Created ${users.length} users successfully.`);
  return users;
}
