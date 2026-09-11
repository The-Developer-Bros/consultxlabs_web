// Data fetching functions using relative URLs
// These work in both client and server components
import { TConsultantProfile } from "@/types/consultant";
import { TConsulteeProfile } from "@/types/consultee";
import { TStaffProfile } from "@/types/staff";
import { TUserWithProfessionalBackground } from "@/types/user";
import type { TConsultantReview } from "@/types/review";

export const fetchUserDetails = async (
  userId: string,
): Promise<TUserWithProfessionalBackground> => {
  const response = await fetch(`/api/user/${userId}`);
  if (!response.ok) {
    const err: Error & { status?: number } = new Error(
      `Failed to fetch user details: ${response.statusText}`,
    );
    err.status = response.status;
    throw err;
  }
  const userData: { data: TUserWithProfessionalBackground } =
    await response.json();
  return userData.data;
};

export const fetchConsultantDetails = async (
  consultantId: string,
): Promise<TConsultantProfile> => {
  const response = await fetch(`/api/user/consultants/${consultantId}`);
  if (!response.ok)
    throw new Error(
      `Failed to fetch consultant details: ${response.statusText}`,
    );
  const consultantData: { data: TConsultantProfile } = await response.json();
  return consultantData.data;
};

export const fetchConsulteeDetails = async (
  consulteeId: string,
): Promise<TConsulteeProfile> => {
  const response = await fetch(`/api/user/consultees/${consulteeId}`);
  if (!response.ok)
    throw new Error(
      `Failed to fetch consultee details: ${response.statusText}`,
    );
  const consulteeData: { data: TConsulteeProfile } = await response.json();
  return consulteeData.data;
};

export const fetchStaffDetails = async (
  staffId: string,
): Promise<TStaffProfile> => {
  const response = await fetch(`/api/user/staff/${staffId}`);
  if (!response.ok)
    throw new Error(`Failed to fetch staff details: ${response.statusText}`);
  const staffData: { data: TStaffProfile } = await response.json();
  return staffData.data;
};

export const fetchReviews = async (
  consultantId: string,
): Promise<TConsultantReview[]> => {
  const response = await fetch(
    `/api/user/reviews?consultantId=${consultantId}`,
  );
  if (!response.ok)
    throw new Error(`Failed to fetch reviews: ${response.statusText}`);
  const reviewsData: { data: TConsultantReview[] } = await response.json();
  return reviewsData.data;
};

/**
 * Maps application user roles to Stream Chat roles.
 *
 * Least privilege (#899): only platform staff get Stream's global `admin`.
 * Everyone else — consultants included — is a plain `user`; channel creation
 * is server-side, and hosts get channel-scoped `channel_moderator` on their
 * own channels at creation time instead of a global grant.
 *
 * @param role The application user role
 * @returns The corresponding Stream Chat role
 */
export function mapRoleToStream(role: string | null | undefined): string {
  switch (role?.toUpperCase()) {
    case "ADMIN":
    case "STAFF":
      return "admin";
    default:
      return "user";
  }
}
