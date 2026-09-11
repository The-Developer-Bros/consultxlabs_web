"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

interface NotificationPreferences {
  allNotifications: boolean;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  pushEnabled: boolean;
  appointmentReminders: boolean;
  paymentNotifications: boolean;
  supportUpdates: boolean;
  feedbackAlerts: boolean;
  trialNotifications: boolean;
  subscriptionAlerts: boolean;
  marketingEmails: boolean;
  orgBillingAlerts: boolean;
  orgMembershipAlerts: boolean;
  orgProgramAlerts: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string | null;
}

/** Keys that map to boolean values — used for Switch toggle fields. */
type BooleanPreferenceKey = {
  [K in keyof NotificationPreferences]: NotificationPreferences[K] extends boolean
    ? K
    : never;
}[keyof NotificationPreferences];

interface ToggleField {
  key: BooleanPreferenceKey;
  label: string;
  description: string;
}

const CHANNEL_FIELDS: ToggleField[] = [
  {
    key: "inAppEnabled",
    label: "In-App Notifications",
    description: "Show notifications in the dashboard inbox",
  },
  {
    key: "emailEnabled",
    label: "Email Notifications",
    description: "Receive notification emails",
  },
  {
    key: "pushEnabled",
    label: "Push Notifications",
    description: "Receive browser push notifications",
  },
];

const CATEGORY_FIELDS: ToggleField[] = [
  {
    key: "appointmentReminders",
    label: "Appointment Reminders",
    description: "Booking confirmations, cancellations, and reminders",
  },
  {
    key: "paymentNotifications",
    label: "Payment Updates",
    description: "Payment confirmations, failures, and refunds",
  },
  {
    key: "supportUpdates",
    label: "Support Tickets",
    description: "Updates on your support tickets",
  },
  {
    key: "feedbackAlerts",
    label: "Feedback & Reviews",
    description: "New feedback and review notifications",
  },
  {
    key: "trialNotifications",
    label: "Trial Sessions",
    description: "Trial session requests and updates",
  },
  {
    key: "subscriptionAlerts",
    label: "Subscription Updates",
    description: "Subscription renewals and changes",
  },
  {
    key: "marketingEmails",
    label: "Marketing & Promotions",
    description: "Platform updates, tips, and promotions",
  },
];

/**
 * ADR 23 — the seven categories above are all B2C-shaped, so every ORG_*
 * workflow was unmutable. Rendered only for someone who actually belongs to an
 * organization; a purely B2C user has nothing behind these switches.
 */
const ORG_CATEGORY_FIELDS: ToggleField[] = [
  {
    key: "orgBillingAlerts",
    label: "Billing & Payouts",
    description: "Invoices, dunning, wallet balance, payouts, and overages",
  },
  {
    key: "orgMembershipAlerts",
    label: "Membership",
    description: "Invitations, roster changes, and role updates",
  },
  {
    key: "orgProgramAlerts",
    label: "Programs",
    description: "Cap warnings, exhausted programs, and renewals",
  },
];

export function NotificationPreferencesPanel() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Same predicate the Inbox tabs use, so the two surfaces agree on whether
  // this user has an org context at all.
  const hasOrgMembership = Array.isArray(
    (session?.user as Record<string, unknown> | undefined)
      ?.organizationMemberships,
  )
    ? ((session?.user as Record<string, unknown>)
        .organizationMemberships as unknown[]).length > 0
    : false;

  const {
    data: preferences,
    isLoading,
    error,
  } = useQuery<NotificationPreferences>({
    queryKey: ["notification-preferences", session?.user?.id],
    queryFn: async () => {
      const res = await fetch("/api/novu/preferences");
      if (!res.ok) throw new Error("Failed to load preferences");
      return res.json();
    },
    enabled: !!session?.user?.id,
    staleTime: 5 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: async (updates: Partial<NotificationPreferences>) => {
      const res = await fetch("/api/novu/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update preferences");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(
        ["notification-preferences", session?.user?.id],
        data,
      );
      toast({
        title: "Preferences updated",
        description: "Your notification preferences have been saved.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update preferences. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleToggle = (key: keyof NotificationPreferences, value: boolean) => {
    mutation.mutate({ [key]: value });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-zinc-500">
          Failed to load notification preferences. Please try again.
        </CardContent>
      </Card>
    );
  }

  // Use defaults if preferences haven't been created yet
  const prefs: NotificationPreferences = preferences ?? {
    allNotifications: true,
    inAppEnabled: true,
    emailEnabled: true,
    pushEnabled: false,
    appointmentReminders: true,
    paymentNotifications: true,
    supportUpdates: true,
    feedbackAlerts: true,
    trialNotifications: true,
    subscriptionAlerts: true,
    marketingEmails: false,
    orgBillingAlerts: true,
    orgMembershipAlerts: true,
    orgProgramAlerts: true,
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    quietHoursTimezone: null,
  };

  return (
    <div className="space-y-6">
      {/* Master Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">All Notifications</Label>
              <p className="text-xs text-zinc-500">
                Master toggle for all notification types
              </p>
            </div>
            <Switch
              checked={prefs.allNotifications}
              onCheckedChange={(checked) =>
                handleToggle("allNotifications", checked)
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Channel Preferences */}
      {prefs.allNotifications && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Channels</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {CHANNEL_FIELDS.map((field, index) => (
              <div key={field.key}>
                {index > 0 && <Separator className="mb-4" />}
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">{field.label}</Label>
                    <p className="text-xs text-zinc-500">{field.description}</p>
                  </div>
                  <Switch
                    checked={prefs[field.key]}
                    onCheckedChange={(checked) =>
                      handleToggle(field.key, checked)
                    }
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Category Preferences */}
      {prefs.allNotifications && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Categories</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {CATEGORY_FIELDS.map((field, index) => (
              <div key={field.key}>
                {index > 0 && <Separator className="mb-4" />}
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">{field.label}</Label>
                    <p className="text-xs text-zinc-500">{field.description}</p>
                  </div>
                  <Switch
                    checked={prefs[field.key]}
                    onCheckedChange={(checked) =>
                      handleToggle(field.key, checked)
                    }
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Organization categories — hidden for users with no membership */}
      {prefs.allNotifications && hasOrgMembership && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Organization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {ORG_CATEGORY_FIELDS.map((field, index) => (
              <div key={field.key}>
                {index > 0 && <Separator className="mb-4" />}
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">{field.label}</Label>
                    <p className="text-xs text-zinc-500">{field.description}</p>
                  </div>
                  <Switch
                    checked={prefs[field.key]}
                    onCheckedChange={(checked) =>
                      handleToggle(field.key, checked)
                    }
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Quiet Hours */}
      {prefs.allNotifications && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Quiet Hours</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">
                  Enable Quiet Hours
                </Label>
                <p className="text-xs text-zinc-500">
                  Pause non-urgent notifications during specific hours
                </p>
              </div>
              <Switch
                checked={prefs.quietHoursEnabled}
                onCheckedChange={(checked) =>
                  handleToggle("quietHoursEnabled", checked)
                }
              />
            </div>
            {prefs.quietHoursEnabled && (
              <>
                <Separator />
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm">Start Time</Label>
                    <Input
                      type="time"
                      value={prefs.quietHoursStart ?? "22:00"}
                      onChange={(e) =>
                        mutation.mutate({ quietHoursStart: e.target.value })
                      }
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-sm">End Time</Label>
                    <Input
                      type="time"
                      value={prefs.quietHoursEnd ?? "08:00"}
                      onChange={(e) =>
                        mutation.mutate({ quietHoursEnd: e.target.value })
                      }
                      className="mt-1"
                    />
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
