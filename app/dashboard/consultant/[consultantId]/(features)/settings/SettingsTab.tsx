"use client";

import { ScheduleType } from "@prisma/client";
import { Button } from "components/ui/button";
import { Card, CardContent } from "components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "components/ui/tabs";
import { useToast } from "components/ui/use-toast";
import { Loader2, SettingsIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import React, { useCallback, useEffect, useState } from "react";
import { TConsultantProfile } from "types/consultant";
import { EmptyState } from "@/components/dashboard/DataCard";
import { SettingsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import {
  getInitialCustomSlots,
  getInitialFormData,
  getInitialWeeklySlots,
  type Domain,
  type FormData,
  type SubDomain,
  type Tag,
} from "./settings";
import { useTimezone } from "@/app/explore/experts/[consultantId]/hooks/useTimezone";
import {
  validateTimeSlot,
  validateAllSlotsDetailed,
} from "@/utils/timeSlotValidation";
import { formatSlotsForApi } from "@/utils/schedule/formatting";
import { reportSentryError } from "@/lib/observability/report";
import type { SlotsType } from "@/utils/schedule/types";
import { ProfileSection, type Option } from "./sections/ProfileSection";
import { AvailabilitySection } from "./sections/AvailabilitySection";
import { VerificationSection } from "./sections/VerificationSection";
import { NotificationsSection } from "./sections/NotificationsSection";

interface SettingsTabProps {
  consultant: TConsultantProfile;
}

const SETTINGS_TABS = [
  { key: "profile", label: "Profile" },
  { key: "availability", label: "Availability" },
  { key: "verification", label: "Verification" },
  { key: "notifications", label: "Notifications" },
] as const;

type SettingsTabKey = (typeof SETTINGS_TABS)[number]["key"];

const isSettingsTabKey = (v: string | null): v is SettingsTabKey =>
  !!v && SETTINGS_TABS.some((t) => t.key === v);

/**
 * Consultant settings — orchestrator for the four section tabs.
 *
 * Deep-linkable via ?tab=<key> (the dashboard layout's verification banner
 * links to ?tab=verification).
 *
 * IMPORTANT payload invariant: profile + availability are ONE combined
 * form — a single PUT to /api/user/consultants/[id] whose body carries the
 * full formData + the active schedule's slots, exactly as before the
 * monolith was decomposed. That's why all form state lives here and the
 * section components are presentational: splitting state per-tab would
 * change what gets saved. Verification + notifications run their own save
 * flows and don't participate in this form's payload.
 */
export function SettingsTab({ consultant }: Readonly<SettingsTabProps>) {
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { timezone, isLoading: timezoneLoading } = useTimezone();
  const [isLoading, setIsLoading] = useState(false);
  const [isContentLoading, setIsContentLoading] = useState(true);
  const [contentError, setContentError] = useState(false);
  const [weeklySlots, setWeeklySlots] = useState<SlotsType>({});
  const [customSlots, setCustomSlots] = useState<SlotsType>({});
  const [currentDate, setCurrentDate] = useState(new Date());
  const [scheduleType, setScheduleType] = useState<ScheduleType>(
    consultant.scheduleType,
  );
  const [formData, setFormData] = useState<FormData>(
    getInitialFormData(consultant),
  );
  const [domains, setDomains] = useState<Domain[]>([]);
  const [subDomains, setSubDomains] = useState<SubDomain[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);

  // Schedule type switching restriction state
  const [canSwitchSchedule, setCanSwitchSchedule] = useState(true);
  const [scheduleSwitchBlockedReason, setScheduleSwitchBlockedReason] =
    useState<string | null>(null);

  // Active tab from the URL (default: profile; invalid values fall back)
  const tabParam = searchParams.get("tab");
  const activeTab: SettingsTabKey = isSettingsTabKey(tabParam)
    ? tabParam
    : "profile";
  const handleTabChange = (value: string) => {
    const next = isSettingsTabKey(value) ? value : "profile";
    router.replace(`${pathname}?tab=${next}`, { scroll: false });
  };

  // Initialize slots data when timezone is available
  useEffect(() => {
    if (!timezoneLoading && timezone) {
      setWeeklySlots(getInitialWeeklySlots(consultant, timezone));
      setCustomSlots(getInitialCustomSlots(consultant, timezone));
    }
  }, [consultant, timezone, timezoneLoading]);

  // Check if schedule type switching is allowed
  useEffect(() => {
    async function checkScheduleSwitchEligibility() {
      try {
        const res = await fetch(
          `/api/user/consultants/${consultant.id}/can-switch-schedule`,
        );
        const data = await res.json();
        setCanSwitchSchedule(data.canSwitch);
        if (!data.canSwitch) {
          setScheduleSwitchBlockedReason(data.details || data.reason);
        } else {
          setScheduleSwitchBlockedReason(null);
        }
      } catch (error) {
        console.error("Error checking schedule switch eligibility:", error);
        // On error, allow switching (backend will validate anyway)
        setCanSwitchSchedule(true);
      }
    }
    checkScheduleSwitchEligibility();
  }, [consultant.id]);

  // Convert subdomains and tags to options format with safety checks
  const subDomainOptions = React.useMemo<Option[]>(() => {
    if (!subDomains || !Array.isArray(subDomains) || !formData.domainId) {
      return [];
    }
    return subDomains
      .filter((sd) => sd && sd.domainId === formData.domainId)
      .map((sd) => ({
        value: sd.id,
        label: sd.name,
      }));
  }, [subDomains, formData.domainId]);

  const tagOptions = React.useMemo<Option[]>(() => {
    if (!tags || !Array.isArray(tags) || !formData.domainId) {
      return [];
    }
    return tags
      .filter((tag) => tag && tag.domainId === formData.domainId)
      .map((tag) => ({
        value: tag.id,
        label: tag.name,
      }));
  }, [tags, formData.domainId]);

  // Fetch domains, subdomains, and tags
  const fetchContentData = useCallback(async () => {
    try {
      setIsContentLoading(true);
      setContentError(false);
      const [domainsRes, subDomainsRes, tagsRes] = await Promise.all([
        fetch("/api/user/content/domains"),
        fetch("/api/user/content/subdomains"),
        fetch("/api/user/content/tags"),
      ]);

      if (domainsRes.ok && subDomainsRes.ok && tagsRes.ok) {
        const [domainsData, subDomainsData, tagsData] = await Promise.all([
          domainsRes.json(),
          subDomainsRes.json(),
          tagsRes.json(),
        ]);

        setDomains(domainsData || []);
        setSubDomains(subDomainsData || []);
        setTags(tagsData || []);
      } else {
        setContentError(true);
      }
    } catch (error) {
      console.error("Error fetching data:", error);
      setContentError(true);
    } finally {
      setIsContentLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchContentData();
  }, [fetchContentData]);

  // Update subdomains and tags when domain changes
  useEffect(() => {
    const fetchDomainContent = async () => {
      if (!formData.domainId) return;

      try {
        setIsContentLoading(true);
        const [subDomainsRes, tagsRes] = await Promise.all([
          fetch(`/api/user/content/subdomains?domainId=${formData.domainId}`),
          fetch(`/api/user/content/tags?domainId=${formData.domainId}`),
        ]);

        if (subDomainsRes.ok && tagsRes.ok) {
          const [subDomainsData, tagsData] = await Promise.all([
            subDomainsRes.json(),
            tagsRes.json(),
          ]);

          setSubDomains(subDomainsData || []);
          setTags(tagsData || []);
        }
      } catch (error) {
        console.error("Error fetching domain content:", error);
        toast({
          title: "Error",
          description: "Failed to load domain content. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsContentLoading(false);
      }
    };

    fetchDomainContent();
  }, [formData.domainId, toast]);

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleDomainChange = useCallback((value: string, e?: Event) => {
    e?.preventDefault();
    requestAnimationFrame(() => {
      setFormData((prev) => ({
        ...prev,
        domainId: value || "",
        subDomainIds: [], // Reset subdomains when domain changes
        tagIds: [], // Reset tags when domain changes
      }));
    });
  }, []);

  const handleSubDomainChange = useCallback((values: string[]) => {
    setFormData((prev) => ({
      ...prev,
      subDomainIds: values || [],
    }));
  }, []);

  const handleTagChange = useCallback((values: string[]) => {
    setFormData((prev) => ({
      ...prev,
      tagIds: values || [],
    }));
  }, []);

  // Update schedule type and clear irrelevant slots
  const handleScheduleTypeChange = useCallback(
    (value: string) => {
      const scheduleTypeValue = value as ScheduleType;

      // Check if trying to switch schedule type when blocked
      if (!canSwitchSchedule && scheduleTypeValue !== scheduleType) {
        toast({
          title: "Cannot Switch Schedule Type",
          description:
            scheduleSwitchBlockedReason ||
            "You have active appointments. Please complete or cancel them first.",
          variant: "destructive",
        });
        return;
      }

      React.startTransition(() => {
        setScheduleType(scheduleTypeValue);
        setFormData((prev) => ({
          ...prev,
          scheduleType: scheduleTypeValue,
        }));

        // Clear slots for the inactive schedule type to prevent corruption
        if (scheduleTypeValue === ScheduleType.WEEKLY) {
          setCustomSlots({});
        } else {
          setWeeklySlots({});
        }
      });
    },
    [canSwitchSchedule, scheduleType, scheduleSwitchBlockedReason, toast],
  );

  const handleAddSlot = useCallback(
    (day: string) => {
      React.startTransition(() => {
        const updateSlots = (prev: SlotsType) => ({
          ...prev,
          [day]: [
            ...(prev[day] || []),
            { startTime: "", endTime: "", isValid: false },
          ],
        });

        if (scheduleType === ScheduleType.WEEKLY) {
          setWeeklySlots(updateSlots);
        } else {
          setCustomSlots(updateSlots);
        }
      });
    },
    [scheduleType],
  );

  const handleUpdateSlot = useCallback(
    (
      day: string,
      index: number,
      field: "startTime" | "endTime",
      value: string,
    ) => {
      React.startTransition(() => {
        const currentSlots =
          scheduleType === ScheduleType.WEEKLY ? weeklySlots : customSlots;
        const setSlots =
          scheduleType === ScheduleType.WEEKLY
            ? setWeeklySlots
            : setCustomSlots;

        // Create updated slot
        const updatedSlot = {
          ...currentSlots[day][index],
          [field]: value,
        };

        // Validate the updated slot in isolation
        const validationResult = validateTimeSlot(
          updatedSlot,
          currentSlots[day]?.filter((_, i) => i !== index) || [],
        );

        setSlots((prev) => ({
          ...prev,
          [day]: [
            ...(prev[day] || []).slice(0, index),
            validationResult,
            ...(prev[day] || []).slice(index + 1),
          ],
        }));
      });
    },
    [scheduleType, weeklySlots, customSlots],
  );

  const handleDeleteSlot = useCallback(
    (day: string, index: number) => {
      React.startTransition(() => {
        const deleteSlot = (prev: SlotsType) => {
          const updatedSlots = {
            ...prev,
            [day]: prev[day].filter((_, i) => i !== index),
          };
          if (updatedSlots[day].length === 0) {
            delete updatedSlots[day];
          }
          return updatedSlots;
        };

        if (scheduleType === ScheduleType.WEEKLY) {
          setWeeklySlots(deleteSlot);
        } else {
          setCustomSlots(deleteSlot);
        }
      });
    },
    [scheduleType],
  );

  const handlePrevMonth = useCallback(() => {
    setCurrentDate(
      (prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1),
    );
  }, []);

  const handleNextMonth = useCallback(() => {
    setCurrentDate(
      (prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1),
    );
  }, []);

  const handleToggleCustomDate = useCallback(
    (dateString: string, isSelected: boolean) => {
      React.startTransition(() => {
        setCustomSlots((prev) => {
          const newCustomSlots = { ...prev };
          if (isSelected) {
            delete newCustomSlots[dateString];
          } else {
            newCustomSlots[dateString] = [
              { startTime: "", endTime: "", isValid: false },
            ];
          }
          return newCustomSlots;
        });
      });
    },
    [],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consultant?.id) return;

    const currentSlots =
      scheduleType === ScheduleType.WEEKLY ? weeklySlots : customSlots;

    // Use improved validation with detailed feedback
    const validation = validateAllSlotsDetailed(currentSlots);
    if (!validation.isValid) {
      const errorMessage =
        validation.errors.length > 0
          ? `Please fix the following issues:\n${validation.errors.slice(0, 3).join("\n")}${validation.errors.length > 3 ? "\n...and more" : ""}`
          : "Please ensure all time slots are valid before saving.";

      toast({
        title: "Validation Error",
        description: errorMessage,
        variant: "destructive",
      });
      return;
    }

    if (!formData.domainId) {
      toast({
        title: "Validation Error",
        description: "Please select a domain before saving.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      // Only send slots for the current schedule type
      const updatedData = {
        ...formData,
        scheduleType,
        slotsOfAvailabilityWeekly:
          scheduleType === ScheduleType.WEEKLY
            ? formatSlotsForApi(weeklySlots, true, timezone || "UTC")
            : [],
        slotsOfAvailabilityCustom:
          scheduleType === ScheduleType.CUSTOM
            ? formatSlotsForApi(customSlots, false, timezone || "UTC")
            : [],
        // Include new fields
        headline: formData.headline || null,
        websiteUrl: formData.websiteUrl || null,
        twitterUrl: formData.twitterUrl || null,
        githubUrl: formData.githubUrl || null,
        linkedinUrl: formData.linkedinUrl || null, // Saved to User model
        videoIntroUrl: formData.videoIntroUrl || null,
        languages: formData.languages || [],
        toolsAndTechnologies: formData.toolsAndTechnologies || [],
        mentoringStyle: formData.mentoringStyle || null,
        sessionTypes: formData.sessionTypes || [],
      };

      const response = await fetch(`/api/user/consultants/${consultant.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updatedData),
      });

      if (!response.ok) {
        throw new Error("Failed to update settings");
      }

      // Refetch the consultant data to show what was actually saved
      const updatedResponse = await fetch(
        `/api/user/consultants/${consultant.id}`,
      );
      if (updatedResponse.ok) {
        const { data: updatedConsultant } = await updatedResponse.json();

        // Update local state to match what was saved to database
        setWeeklySlots(
          getInitialWeeklySlots(updatedConsultant, timezone || "UTC"),
        );
        setCustomSlots(
          getInitialCustomSlots(updatedConsultant, timezone || "UTC"),
        );
        setFormData(getInitialFormData(updatedConsultant));
        setScheduleType(updatedConsultant.scheduleType);
      }

      toast({
        title: "Settings updated",
        description: "Your profile settings have been successfully updated.",
      });
    } catch (error) {
      // formatSlotsForApi now throws rather than degrading, so a slot-formatting
      // regression lands here instead of silently shipping a short or empty
      // availability payload. Worth capturing: the consultant sees a retry toast
      // and would otherwise be the only one who ever knew. (#1125)
      reportSentryError(error, {
        subsystem: "consultants",
        op: "SettingsTab.save",
        extra: { consultantId: consultant.id, scheduleType },
      });
      console.error("Error updating settings:", error);
      toast({
        title: "Error",
        description: "Failed to update settings. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isContentLoading || timezoneLoading) {
    return <SettingsSkeleton />;
  }

  if (contentError && domains.length === 0) {
    return (
      <Card>
        <CardContent className="py-6">
          <EmptyState
            icon={SettingsIcon}
            title="Couldn't load settings data"
            description="The domain and expertise options failed to load. Please retry."
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => void fetchContentData()}
              >
                Retry
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6"
      role="form"
      aria-label="Settings form"
    >
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          {SETTINGS_TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-6 space-y-8">
          {activeTab === "profile" && (
            <ProfileSection
              formData={formData}
              setFormData={setFormData}
              domains={domains}
              subDomainOptions={subDomainOptions}
              tagOptions={tagOptions}
              onInputChange={handleInputChange}
              onDomainChange={handleDomainChange}
              onSubDomainChange={handleSubDomainChange}
              onTagChange={handleTagChange}
            />
          )}

          {activeTab === "availability" && (
            <AvailabilitySection
              scheduleType={scheduleType}
              canSwitchSchedule={canSwitchSchedule}
              scheduleSwitchBlockedReason={scheduleSwitchBlockedReason}
              onScheduleTypeChange={handleScheduleTypeChange}
              weeklySlots={weeklySlots}
              customSlots={customSlots}
              currentDate={currentDate}
              onPrevMonth={handlePrevMonth}
              onNextMonth={handleNextMonth}
              onToggleCustomDate={handleToggleCustomDate}
              onAddSlot={handleAddSlot}
              onUpdateSlot={handleUpdateSlot}
              onDeleteSlot={handleDeleteSlot}
            />
          )}

          {activeTab === "verification" && (
            <VerificationSection consultant={consultant} />
          )}

          {activeTab === "notifications" && <NotificationsSection />}
        </CardContent>
      </Card>

      {/* Action Buttons — the combined profile+availability save. Rendered
          on every tab (verification/notifications have their own flows but
          the form save remains reachable, matching the old single-page UX). */}
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end sm:space-x-4">
        <Button
          type="button"
          variant="outline"
          className="w-full sm:w-auto"
          onClick={() => {
            React.startTransition(() => {
              setFormData(getInitialFormData(consultant));
              setScheduleType(consultant.scheduleType);
              setWeeklySlots(
                getInitialWeeklySlots(consultant, timezone || "UTC"),
              );
              setCustomSlots(
                getInitialCustomSlots(consultant, timezone || "UTC"),
              );
            });
          }}
          disabled={isLoading}
        >
          Reset
        </Button>
        <Button
          type="submit"
          className="w-full bg-primary hover:bg-primary/90 text-primary-foreground sm:w-auto sm:min-w-[200px]"
          disabled={isLoading}
        >
          {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Save Changes
        </Button>
      </div>
    </form>
  );
}
