"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Mail,
  Phone,
  MapPin,
  Calendar,
  CheckCircle,
  Clock,
  Shield,
  ExternalLink,
  AlertCircle,
  XCircle,
} from "lucide-react";
import Link from "next/link";

interface UserDetail {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  image: string | null;
  role: string;
  onboardingCompleted: boolean;
  createdAt: string;
  city: string | null;
  country: string | null;
  consultantProfile?: {
    id: string;
    description: string | null;
    headline: string | null;
    experience: number | null;
    isVerified: boolean;
    verificationStatus: string | null;
    domain?: { name: string } | null;
    subDomains?: { id: string; name: string }[];
  } | null;
  consulteeProfile?: {
    id: string;
    interests: string[];
  } | null;
  staffProfile?: {
    id: string;
    department: string | null;
    position: string | null;
  } | null;
}

interface UserDetailModalProps {
  userId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const getRoleColor = (role: string) => {
  switch (role) {
    case "CONSULTANT":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    case "CONSULTEE":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "ADMIN":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "STAFF":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

// Cases must be `ProfileVerificationStatus` values. This switch was written
// against VERIFIED / PENDING_VERIFICATION / UNDER_REVIEW, none of which are in
// that enum — only REJECTED happened to match — so an approved, pending or
// needs-info consultant all fell through to "Not Submitted", which is a
// different and materially wrong claim about their onboarding. A test pins the
// cases to the schema so a future rename cannot quietly restore this.
const getVerificationStatusBadge = (status: string | null) => {
  switch (status) {
    case "APPROVED":
      return (
        <Badge className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
          <CheckCircle className="h-3 w-3 mr-1" />
          Verified
        </Badge>
      );
    case "PENDING":
      return (
        <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
          <Clock className="h-3 w-3 mr-1" />
          Pending
        </Badge>
      );
    case "NEEDS_INFO":
      return (
        <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
          <AlertCircle className="h-3 w-3 mr-1" />
          Needs Info
        </Badge>
      );
    case "SUPERSEDED":
      return (
        <Badge variant="secondary">
          <Clock className="h-3 w-3 mr-1" />
          Superseded
        </Badge>
      );
    case "REJECTED":
      return (
        <Badge className="bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">
          <XCircle className="h-3 w-3 mr-1" />
          Rejected
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary">
          <Clock className="h-3 w-3 mr-1" />
          Not Submitted
        </Badge>
      );
  }
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

export function UserDetailModal({
  userId,
  open,
  onOpenChange,
}: UserDetailModalProps) {
  const [user, setUser] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !open) {
      setUser(null);
      setError(null);
      return;
    }

    const fetchUser = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/admin/users/${userId}`);
        if (!response.ok) {
          throw new Error("Failed to fetch user details");
        }
        const data = await response.json();
        setUser(data.user);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load user");
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, [userId, open]);

  const getProfileLink = () => {
    if (!user) return null;
    if (user.role === "CONSULTANT" && user.consultantProfile?.id) {
      return `/explore/experts/${user.consultantProfile.id}`;
    }
    return null;
  };

  const getDashboardLink = () => {
    if (!user) return null;
    switch (user.role) {
      case "CONSULTANT":
        return user.consultantProfile?.id
          ? `/dashboard/consultant/${user.consultantProfile.id}`
          : null;
      case "CONSULTEE":
        return user.consulteeProfile?.id
          ? `/dashboard/consultee/${user.consulteeProfile.id}`
          : null;
      case "STAFF":
        return user.staffProfile?.id
          ? `/dashboard/staff/${user.staffProfile.id}`
          : null;
      case "ADMIN":
        return "/dashboard/admin";
      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>User Details</DialogTitle>
          <DialogDescription>
            View detailed information about this user
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-4">
              <Skeleton className="h-16 w-16 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-32" />
              </div>
            </div>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : error ? (
          <div className="py-8 text-center">
            <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <p className="text-red-600">{error}</p>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="mt-4"
            >
              Close
            </Button>
          </div>
        ) : user ? (
          <div className="space-y-6">
            {/* Profile Header */}
            <div className="flex items-center gap-4 p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900">
              <Avatar className="h-16 w-16">
                <AvatarImage src={user.image || ""} />
                <AvatarFallback className="text-lg">
                  {(user.name || user.email || "?")
                    .split(" ")
                    .map((n) => n[0])
                    .join("")
                    .toUpperCase()
                    .slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  {user.name || "Unnamed"}
                  {user.onboardingCompleted && (
                    <CheckCircle className="h-4 w-4 text-blue-500" />
                  )}
                </h3>
                <div className="flex items-center gap-2 mt-1">
                  <Badge
                    className={getRoleColor(user.role)}
                    variant="secondary"
                  >
                    {user.role.toLowerCase()}
                  </Badge>
                  {user.onboardingCompleted ? (
                    <Badge className="bg-green-100 text-green-700">
                      Active
                    </Badge>
                  ) : (
                    <Badge className="bg-yellow-100 text-yellow-700">
                      Pending Onboarding
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {/* Contact Information */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-zinc-400" />
                <span className="text-sm">{user.email}</span>
              </div>
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-zinc-400" />
                <span className="text-sm">{user.phone || "Not provided"}</span>
              </div>
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-zinc-400" />
                <span className="text-sm">
                  {user.city && user.country
                    ? `${user.city}, ${user.country}`
                    : "Location not set"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-zinc-400" />
                <span className="text-sm">
                  Joined {formatDate(user.createdAt)}
                </span>
              </div>
            </div>

            <Separator />

            {/* Role-specific information */}
            {user.role === "CONSULTANT" && user.consultantProfile && (
              <div className="space-y-4">
                <h4 className="font-medium flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  Consultant Profile
                </h4>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-xs text-zinc-500">
                        Verification Status
                      </p>
                      <div className="mt-1">
                        {getVerificationStatusBadge(
                          user.consultantProfile.verificationStatus,
                        )}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-xs text-zinc-500">Domain</p>
                      <p className="font-medium mt-1">
                        {user.consultantProfile.domain?.name || "Not set"}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-xs text-zinc-500">Experience</p>
                      <p className="font-medium mt-1">
                        {user.consultantProfile.experience
                          ? `${user.consultantProfile.experience} years`
                          : "Not set"}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-xs text-zinc-500">Headline</p>
                      <p className="font-medium mt-1">
                        {user.consultantProfile.headline || "Not set"}
                      </p>
                    </CardContent>
                  </Card>
                </div>
                {user.consultantProfile.subDomains &&
                  user.consultantProfile.subDomains.length > 0 && (
                    <div>
                      <p className="text-xs text-zinc-500 mb-2">
                        Specializations
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {user.consultantProfile.subDomains.map((s) => (
                          <Badge key={s.id} variant="outline">
                            {s.name}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            )}

            {user.role === "CONSULTEE" && user.consulteeProfile && (
              <div className="space-y-4">
                <h4 className="font-medium">Consultee Profile</h4>
                {user.consulteeProfile.interests &&
                  user.consulteeProfile.interests.length > 0 && (
                    <div>
                      <p className="text-xs text-zinc-500 mb-2">Interests</p>
                      <div className="flex flex-wrap gap-2">
                        {user.consulteeProfile.interests.map((i, idx) => (
                          <Badge key={idx} variant="outline">
                            {i}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            )}

            {user.role === "STAFF" && user.staffProfile && (
              <div className="space-y-4">
                <h4 className="font-medium">Staff Profile</h4>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-xs text-zinc-500">Department</p>
                      <p className="font-medium mt-1">
                        {user.staffProfile.department || "Not set"}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-xs text-zinc-500">Position</p>
                      <p className="font-medium mt-1">
                        {user.staffProfile.position || "Not set"}
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {user && getProfileLink() && (
            <Button variant="outline" asChild>
              <Link href={getProfileLink()!} target="_blank">
                View Public Profile
                <ExternalLink className="h-4 w-4 ml-2" />
              </Link>
            </Button>
          )}
          {user && getDashboardLink() && (
            <Button asChild>
              <Link href={getDashboardLink()!} target="_blank">
                View Dashboard
                <ExternalLink className="h-4 w-4 ml-2" />
              </Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
