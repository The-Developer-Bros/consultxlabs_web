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
import { useToast } from "@/hooks/use-toast";
import { NotificationPreferencesPanel } from "@/components/notifications";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Settings as SettingsIcon } from "lucide-react";
import React, { useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import { CareerStage, BudgetPreference } from "@prisma/client";
import { EducationSection } from "@/app/form/onboarding/components/experience/EducationSection";
import type { Education as EducationForm } from "@/app/form/onboarding/components/experience/EducationSection";
import { WorkExperienceSection } from "@/app/form/onboarding/components/experience/WorkExperienceSection";
import type { WorkExperience as WorkExperienceForm } from "@/app/form/onboarding/components/experience/WorkExperienceSection";

interface SettingsTabProps {
  consulteeId: string;
}

interface ProfileFormData {
  aboutMe: string | null;
  preferredLanguage: string | null;
  careerStage: CareerStage | null;
  skillsToDevelop: string[];
  budgetPreference: BudgetPreference | null;
  goals: string | null;
}


export default function SettingsTab({ consulteeId }: SettingsTabProps) {
  const { toast } = useToast();
  const [isSaving, setIsSaving] = React.useState(false);

  const settingsQuery = createConsulteeQueries(consulteeId).settings;
  const {
    data: consulteeData,
    isLoading,
    error,
    refetch,
  } = useQuery(settingsQuery);

  const [profileSettings, setProfileSettings] = React.useState<ProfileFormData>(
    {
      aboutMe: null,
      preferredLanguage: null,
      goals: null,
      careerStage: null,
      skillsToDevelop: [],
      budgetPreference: null,
    },
  );

  const [educationList, setEducationList] = React.useState<EducationForm[]>([]);
  const [workExperienceList, setWorkExperienceList] = React.useState<
    WorkExperienceForm[]
  >([]);

  const handleProfileChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
  ) => {
    const { name, value } = e.target;
    setProfileSettings((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  useEffect(() => {
    if (consulteeData) {
      setProfileSettings({
        aboutMe: consulteeData.aboutMe,
        preferredLanguage: consulteeData.preferredLanguage,
        goals: consulteeData.goals,
        careerStage: consulteeData.careerStage ?? null,
        skillsToDevelop: consulteeData.skillsToDevelop ?? [],
        budgetPreference: consulteeData.budgetPreference ?? null,
      });

      // Load user-level education and work experiences
      // The settings query now uses TConsulteeProfileWithBackground,
      // so user.education and user.workExperiences are properly typed.
      const { user } = consulteeData;
      if (user?.education) {
        setEducationList(
          user.education.map((edu) => ({
            id: edu.id,
            institution: edu.institution,
            institutionDomain: edu.institutionDomain ?? undefined,
            degree: edu.degree,
            fieldOfStudy: edu.fieldOfStudy ?? undefined,
            startYear: edu.startYear ?? undefined,
            endYear: edu.endYear ?? undefined,
            grade: edu.grade ?? undefined,
            activities: edu.activities ?? undefined,
            description: edu.description ?? undefined,
          })),
        );
      }
      if (user?.workExperiences) {
        setWorkExperienceList(
          user.workExperiences.map((we) => ({
            id: we.id,
            company: we.company,
            companyDomain: we.companyDomain ?? undefined,
            title: we.title,
            location: we.location ?? undefined,
            startDate: new Date(we.startDate),
            endDate: we.endDate ? new Date(we.endDate) : undefined,
            isCurrent: we.isCurrent,
            description: we.description ?? undefined,
          })),
        );
      }
    }
  }, [consulteeData]);

  useEffect(() => {
    if (error) {
      toast({
        title: "Error",
        description: "Failed to load profile settings.",
        variant: "destructive",
      });
    }
  }, [error, toast]);

  const handleEducationUpdate = useCallback(
    (updated: EducationForm[]) => {
      setEducationList(updated);
    },
    [],
  );

  const handleWorkExperienceUpdate = useCallback(
    (updated: WorkExperienceForm[]) => {
      setWorkExperienceList(updated);
    },
    [],
  );

  const handleSave = async () => {
    try {
      setIsSaving(true);

      // Save profile settings
      const profileResponse = await fetch(
        `/api/user/consultees/${consulteeId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(profileSettings),
        },
      );
      if (!profileResponse.ok) throw new Error("Failed to update profile");

      // Save education and work experience via the user's onboarding endpoint
      // Get userId from consultee data
      const userId = consulteeData?.user?.id;
      if (userId) {
        const bgResponse = await fetch(`/api/user/${userId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            educationHistory: educationList.map((edu) => ({
              institution: edu.institution,
              institutionDomain: edu.institutionDomain,
              degree: edu.degree,
              fieldOfStudy: edu.fieldOfStudy,
              startYear: edu.startYear,
              endYear: edu.endYear,
              grade: edu.grade,
              activities: edu.activities,
              description: edu.description,
            })),
            workExperiences: workExperienceList.map((we) => ({
              company: we.company,
              companyDomain: we.companyDomain,
              title: we.title,
              location: we.location,
              startDate: we.startDate,
              endDate: we.endDate,
              isCurrent: we.isCurrent,
              description: we.description,
            })),
          }),
        });
        if (!bgResponse.ok) {
          // Profile saved but background details didn't — say so instead of
          // reporting blanket success; the form stays dirty for a retry.
          toast({
            title: "Partially saved",
            description:
              "Your profile was saved, but education/work experience failed to update. Please try saving again.",
            variant: "destructive",
          });
          return;
        }
      }

      toast({
        title: "Settings saved",
        description: "Your settings have been updated successfully.",
      });

      refetch();
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
        <div className="bg-card rounded-xl p-6 shadow-sm border border-border mb-6 sm:p-8">
          <h2 className="text-fluid-3xl font-bold tracking-tight text-foreground">
            Settings
          </h2>
          <p className="mt-2 text-muted-foreground">
            Manage your account settings and preferences
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Profile Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="animate-pulse space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="h-16 bg-muted rounded"></div>
                <div className="h-16 bg-muted rounded"></div>
              </div>
              <div className="h-32 bg-muted rounded"></div>
              <div className="h-16 bg-muted rounded"></div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // In-page error state — the old toast-only path left a form rendering
  // nulls after a failed load, which read like empty settings.
  if (error && !consulteeData) {
    return (
      <EmptyState
        icon={SettingsIcon}
        title="Couldn't load your settings"
        description="Something went wrong while fetching your profile."
        action={
          <Button variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-card rounded-xl p-6 shadow-sm border border-border mb-6 sm:p-8">
        <h2 className="text-fluid-3xl font-bold tracking-tight text-foreground">
          Settings
        </h2>
        <p className="mt-2 text-muted-foreground">
          Manage your account settings and preferences
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="preferredLanguage">Preferred Language</Label>
              <Input
                id="preferredLanguage"
                name="preferredLanguage"
                value={profileSettings.preferredLanguage ?? ""}
                onChange={handleProfileChange}
                placeholder="Your preferred language"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="careerStage">Career Stage</Label>
              <Select
                value={profileSettings.careerStage ?? ""}
                onValueChange={(value) =>
                  setProfileSettings((prev) => ({
                    ...prev,
                    careerStage: value as CareerStage,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select your career stage" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CareerStage.STUDENT}>Student</SelectItem>
                  <SelectItem value={CareerStage.EARLY_CAREER}>
                    Early Career (0-3 years)
                  </SelectItem>
                  <SelectItem value={CareerStage.MID_CAREER}>
                    Mid Career (3-10 years)
                  </SelectItem>
                  <SelectItem value={CareerStage.SENIOR}>
                    Senior (10+ years)
                  </SelectItem>
                  <SelectItem value={CareerStage.EXECUTIVE}>
                    Executive
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="aboutMe">About Me</Label>
            <Textarea
              id="aboutMe"
              name="aboutMe"
              value={profileSettings.aboutMe ?? ""}
              onChange={handleProfileChange}
              placeholder="Tell us about yourself"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="goals">Goals</Label>
            <Textarea
              id="goals"
              name="goals"
              value={profileSettings.goals ?? ""}
              onChange={handleProfileChange}
              placeholder="What you hope to achieve"
            />
          </div>
        </CardContent>
      </Card>

      {/* Work Experience Section */}
      <Card>
        <CardHeader>
          <CardTitle>Work Experience</CardTitle>
        </CardHeader>
        <CardContent>
          <WorkExperienceSection
            experiences={workExperienceList}
            onUpdate={handleWorkExperienceUpdate}
          />
        </CardContent>
      </Card>

      {/* Education Section */}
      <Card>
        <CardHeader>
          <CardTitle>Education</CardTitle>
        </CardHeader>
        <CardContent>
          <EducationSection
            education={educationList}
            onUpdate={handleEducationUpdate}
          />
        </CardContent>
      </Card>

      {/* Career & Professional Section */}
      <Card>
        <CardHeader>
          <CardTitle>Career Preferences</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="budgetPreference">Budget Preference</Label>
              <Select
                value={profileSettings.budgetPreference ?? ""}
                onValueChange={(value) =>
                  setProfileSettings((prev) => ({
                    ...prev,
                    budgetPreference: value as BudgetPreference,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select budget preference" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BudgetPreference.BUDGET}>
                    Budget
                  </SelectItem>
                  <SelectItem value={BudgetPreference.MODERATE}>
                    Moderate
                  </SelectItem>
                  <SelectItem value={BudgetPreference.PREMIUM}>
                    Premium
                  </SelectItem>
                  <SelectItem value={BudgetPreference.FLEXIBLE}>
                    Flexible
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="skillsToDevelop">Skills to Develop</Label>
            <Input
              id="skillsToDevelop"
              value={(profileSettings.skillsToDevelop ?? []).join(", ")}
              onChange={(e) => {
                const skills = e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                setProfileSettings((prev) => ({
                  ...prev,
                  skillsToDevelop: skills,
                }));
              }}
              placeholder="React, Python, Leadership (comma-separated)"
            />
          </div>
        </CardContent>
      </Card>

      {/* Notification Preferences */}
      <NotificationPreferencesPanel />

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
