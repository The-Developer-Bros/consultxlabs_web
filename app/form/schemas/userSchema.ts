import { z } from "zod";

export const personalInfoSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
});

export type PersonalInfo = z.infer<typeof personalInfoSchema>;

export const roleSchema = z.object({
  role: z.enum(["CONSULTANT", "CONSULTEE", "STAFF"]),
});

export type RoleInfo = z.infer<typeof roleSchema>;

export const consultantProfileSchema = z.object({
  rating: z.number().min(0).max(5),
  specialization: z.string().optional(),
  experience: z.string().optional(),
  location: z.string().optional(),
});

export type ConsultantProfile = z.infer<typeof consultantProfileSchema>;

export const consulteeProfileSchema = z.object({
  location: z.string().optional(),
  onlineStatus: z.boolean(),
});

export type ConsulteeProfile = z.infer<typeof consulteeProfileSchema>;

export const staffProfileSchema = z.object({
  department: z.string().min(1, "Department is required"),
  position: z.string().min(1, "Position is required"),
});

export type StaffProfile = z.infer<typeof staffProfileSchema>;