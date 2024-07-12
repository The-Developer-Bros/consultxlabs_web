// schemas/userSchema.ts
import { z } from "zod";

export const personalInfoAndRoleSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  role: z.enum(["CONSULTANT", "CONSULTEE", "STAFF"]),
  phone: z.string().optional(),
  address: z.string().optional(),
});

export type PersonalInfoAndRole = z.infer<typeof personalInfoAndRoleSchema>;

export const consultantProfileSchema = z.object({
  specialization: z.string().optional(),
  experience: z.string().optional(),
  location: z.string().optional(),
  domain: z.string().optional(),
  subDomains: z.string().optional(),

  // Schedule
  scheduleType: z.enum(['weekly', 'custom']),
  weeklySlots: z.record(z.array(z.object({
    startTime: z.string(),
    endTime: z.string(),
  }))).optional(),
  customSlots: z.array(z.object({
    day: z.date(),
    startTime: z.string(),
    endTime: z.string(),
  })).optional(),

}).refine((data) => {
  const hasWeeklySlots = !!data.weeklySlots;
  const hasCustomSlots = !!data.customSlots;
  return !(hasWeeklySlots && hasCustomSlots) && (hasWeeklySlots || hasCustomSlots);
}, {
  message: "You can have only one of weeklySlots or customSlots but not both",
  path: ['weeklySlots', 'customSlots'],
});

export type ConsultantProfile = z.infer<typeof consultantProfileSchema>;

export const consulteeProfileSchema = z.object({
  location: z.string().optional(),
});

export type ConsulteeProfile = z.infer<typeof consulteeProfileSchema>;

export const staffProfileSchema = z.object({
  department: z.string().min(1, "Department is required"),
  position: z.string().min(1, "Position is required"),
});

export type StaffProfile = z.infer<typeof staffProfileSchema>;
