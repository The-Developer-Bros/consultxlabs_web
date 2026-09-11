"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { NotificationPreferencesPanel } from "@/components/notifications";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";

interface AdminData {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  address: string | null;
  timezone: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  city: string | null;
  country: string | null;
  linkedinUrl: string | null;
  bio: string | null;
  adminProfile?: {
    id: string;
    notes: string | null;
  } | null;
}

async function fetchAdminData(userId: string): Promise<AdminData> {
  const response = await fetch(`/api/user/${userId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch admin data");
  }
  const result = (await response.json()) as { data: AdminData };
  return result.data;
}

export default function AdminSettingsPage() {
  const { data: session } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);

  const userId = session?.user?.id;

  const { data: adminData, isLoading } = useQuery({
    queryKey: ["admin-settings", userId],
    queryFn: () => fetchAdminData(userId as string),
    enabled: !!userId,
  });

  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    timezone: "",
    dateOfBirth: "",
    gender: "",
    city: "",
    country: "",
    linkedinUrl: "",
    bio: "",
  });

  useEffect(() => {
    if (adminData) {
      setFormData({
        name: adminData.name || "",
        email: adminData.email || "",
        phone: adminData.phone || "",
        address: adminData.address || "",
        timezone: adminData.timezone || "",
        dateOfBirth: adminData.dateOfBirth
          ? new Date(adminData.dateOfBirth).toISOString().split("T")[0]
          : "",
        gender: adminData.gender || "",
        city: adminData.city || "",
        country: adminData.country || "",
        linkedinUrl: adminData.linkedinUrl || "",
        bio: adminData.bio || "",
      });
    }
  }, [adminData]);

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSave = async () => {
    if (!userId) return;

    setIsSaving(true);
    try {
      const response = await fetch(`/api/user/${userId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          dateOfBirth: formData.dateOfBirth || null,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save settings");
      }

      toast({
        title: "Settings saved",
        description: "Your profile has been updated successfully.",
      });

      queryClient.invalidateQueries({ queryKey: ["admin-settings", userId] });
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      toast({
        title: "Error",
        description: "Failed to save settings. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Settings</h1>
          <p className="text-muted-foreground mt-1">Manage your account settings</p>
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-[200px]" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Manage your account settings and preferences
        </p>
      </div>

      {/* Personal Information */}
      <Card>
        <CardHeader>
          <CardTitle>Personal Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full Name</Label>
              <Input
                id="name"
                name="name"
                value={formData.name}
                onChange={handleInputChange}
                placeholder="Your full name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                value={formData.email}
                onChange={handleInputChange}
                placeholder="your@email.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                name="phone"
                value={formData.phone}
                onChange={handleInputChange}
                placeholder="+1 (555) 123-4567"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dateOfBirth">Date of Birth</Label>
              <Input
                id="dateOfBirth"
                name="dateOfBirth"
                type="date"
                value={formData.dateOfBirth}
                onChange={handleInputChange}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gender">Gender</Label>
              <Select
                value={formData.gender}
                onValueChange={(value) =>
                  setFormData((prev) => ({ ...prev, gender: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select gender" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="male">Male</SelectItem>
                  <SelectItem value="female">Female</SelectItem>
                  <SelectItem value="non_binary">Non-binary</SelectItem>
                  <SelectItem value="prefer_not_to_say">
                    Prefer not to say
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="linkedinUrl">LinkedIn URL</Label>
              <Input
                id="linkedinUrl"
                name="linkedinUrl"
                type="url"
                value={formData.linkedinUrl}
                onChange={handleInputChange}
                placeholder="https://linkedin.com/in/username"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bio">Bio</Label>
            <Textarea
              id="bio"
              name="bio"
              value={formData.bio}
              onChange={handleInputChange}
              placeholder="A brief description about yourself"
              maxLength={160}
            />
            <p className="text-xs text-muted-foreground">
              {formData.bio?.length || 0}/160 characters
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Location */}
      <Card>
        <CardHeader>
          <CardTitle>Location</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                name="city"
                value={formData.city}
                onChange={handleInputChange}
                placeholder="San Francisco"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="country">Country</Label>
              <Input
                id="country"
                name="country"
                value={formData.country}
                onChange={handleInputChange}
                placeholder="United States"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                name="address"
                value={formData.address}
                onChange={handleInputChange}
                placeholder="123 Main St"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="timezone">Timezone</Label>
              <Select
                value={formData.timezone}
                onValueChange={(value) =>
                  setFormData((prev) => ({ ...prev, timezone: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="America/New_York">
                    Eastern Time (US & Canada)
                  </SelectItem>
                  <SelectItem value="America/Chicago">
                    Central Time (US & Canada)
                  </SelectItem>
                  <SelectItem value="America/Denver">
                    Mountain Time (US & Canada)
                  </SelectItem>
                  <SelectItem value="America/Los_Angeles">
                    Pacific Time (US & Canada)
                  </SelectItem>
                  <SelectItem value="Europe/London">London</SelectItem>
                  <SelectItem value="Europe/Paris">Paris</SelectItem>
                  <SelectItem value="Asia/Kolkata">
                    India Standard Time
                  </SelectItem>
                  <SelectItem value="Asia/Tokyo">Tokyo</SelectItem>
                  <SelectItem value="Australia/Sydney">Sydney</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Admin Profile Info (Read-only) */}
      {adminData?.adminProfile && (
        <Card>
          <CardHeader>
            <CardTitle>Admin Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {adminData.adminProfile.notes && (
              <div className="space-y-2">
                <Label>Notes</Label>
                <p className="text-sm text-muted-foreground bg-muted p-2 rounded">
                  {adminData.adminProfile.notes}
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Admin profile notes are managed by platform administrators.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Notification Preferences */}
      <NotificationPreferencesPanel />

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
