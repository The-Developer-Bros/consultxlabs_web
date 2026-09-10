import React, { useCallback, useEffect, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, Loader2 } from "lucide-react";
import { PersonalInfoAndRoleFormSchema } from "@/utils/onboarding";
import { useSession } from "@/lib/auth-client";
import { z } from "zod";
import { UserRole, Gender } from "@prisma/client";

type FormData = z.infer<typeof PersonalInfoAndRoleFormSchema>;
// #1132 — DateOfBirthSchema accepts a Date OR a `YYYY-MM-DD` string (the wizard
// round-trips values through JSON between steps) and always yields a Date, so
// the schema's input and output types differ. useForm needs both spelled out;
// inferring from the output alone makes the resolver unassignable.
type FormInput = z.input<typeof PersonalInfoAndRoleFormSchema>;

interface Props {
  onNext: (data: FormData) => void;
  initialData: Partial<FormData>;
}

// User-facing copy avoids internal role jargon (#onboarding-ux): "CONSULTEE"
// means nothing to a new visitor — the picker answers "what do you want to
// do?" instead. Enum VALUES are unchanged; only labels/descriptions differ.
const ROLE_INFO: Record<string, { title: string; description: string }> = {
  CONSULTANT: {
    title: "I want to offer my expertise",
    description:
      "Create a consultant profile, get verified, and start taking sessions",
  },
  CONSULTEE: {
    title: "I want expert guidance",
    description: "Find experienced professionals and book your first session",
  },
  ORG_WORKSPACE: {
    title: "For my organization",
    description: "Create and manage an organization for your school or company",
  },
};

const GENDER_OPTIONS = [
  { value: "MALE", label: "Male" },
  { value: "FEMALE", label: "Female" },
  { value: "NON_BINARY", label: "Non-binary" },
  { value: "PREFER_NOT_TO_SAY", label: "Prefer not to say" },
];

const PersonalInfoAndRoleForm: React.FC<Props> = ({ onNext, initialData }) => {
  const { data: session } = useSession();
  const [optionalOpen, setOptionalOpen] = useState(false);
  // Reflects the parent's async role-flip (ORG_WORKSPACE path hits the
  // `setOnboardingRoleAction` server action before advancing). When the
  // action fails, the parent shows a toast and does NOT unmount us, so the
  // `finally` re-enables the button for retry.
  const [isSubmitting, setIsSubmitting] = useState(false);

  // #840 — invitees skip the role-picker entirely when they have a pending
  // org invitation; picking a B2C tile would create unwanted profiles.
  // CR #1245 r2 — tri-state: undefined = checking, null = none found,
  // object = invite exists. The role picker MUST NOT render while checking
  // or on failure, or a pending invitee could submit a B2C role.
  const [inviteCheckDone, setInviteCheckDone] = useState(false);
  const [inviteCheckError, setInviteCheckError] = useState(false);
  const [pendingInvite, setPendingInvite] = useState<{
    organizationName: string;
    role: string;
    organizationId: string;
  } | null>(null);
  const loadPendingInvites = useCallback(() => {
    setInviteCheckDone(false);
    setInviteCheckError(false);
    fetch("/api/user/pending-invites")
      .then((r) => (r.ok ? r.json() : Promise.reject("fetch failed")))
      .then((d) => {
        if (d?.invites?.length > 0) setPendingInvite(d.invites[0]);
        setInviteCheckDone(true);
      })
      .catch(() => {
        setInviteCheckError(true);
        setInviteCheckDone(true);
      });
  }, []);
  useEffect(() => {
    loadPendingInvites();
  }, [loadPendingInvites]);

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormInput, unknown, FormData>({
    resolver: zodResolver(PersonalInfoAndRoleFormSchema),
    mode: "onChange",
    defaultValues: {
      name: "",
      email: session?.user?.email || "",
      onlineStatus: false,
      onboardingCompleted: false,
      role: UserRole.CONSULTEE,
      gender: null,
      city: "",
      country: "",
      linkedinUrl: "",
      bio: "",
      ...initialData,
    },
  });

  // Sync form values when initialData changes (for back navigation)
  useEffect(() => {
    if (initialData && Object.keys(initialData).length > 0) {
      reset({
        name: "",
        email: session?.user?.email || "",
        onlineStatus: false,
        onboardingCompleted: false,
        role: UserRole.CONSULTEE,
        gender: null,
        city: "",
        country: "",
        linkedinUrl: "",
        bio: "",
        ...initialData,
      });
    }
  }, [initialData, reset, session?.user?.email]);

  // Sync email from session when it loads after form mount
  useEffect(() => {
    if (session?.user?.email) {
      reset((prev) => ({ ...prev, email: session.user.email }), {
        keepDirtyValues: true,
      });
    }
  }, [session?.user?.email, reset]);

  const selectedRole = watch("role");
  const bioLength = watch("bio")?.length || 0;

  const onSubmit = async (data: FormData) => {
    const submissionData = {
      ...data,
      email: session?.user?.email || "",
    };
    setIsSubmitting(true);
    try {
      await onNext(submissionData);
    } finally {
      setIsSubmitting(false);
    }
  };

  // #840 — invitees with a pending org invitation see this instead of the
  // role tiles, so they can't accidentally create a B2C profile.
  if (pendingInvite) {
    if (!inviteCheckDone) {
    return (
      <div className="mx-auto max-w-md py-8 text-center">
        <p className="text-sm text-zinc-500">Checking for pending invitations…</p>
      </div>
    );
  }
  if (inviteCheckError && !pendingInvite) {
    return (
      <div className="mx-auto max-w-md space-y-3 py-8 text-center">
        <p className="text-sm text-red-600">Could not check for pending invitations.</p>
        <Button size="sm" onClick={() => loadPendingInvites()}>Retry</Button>
      </div>
    );
  }

  return (
      <div className="mx-auto max-w-md space-y-4 py-8 text-center">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-6">
          <p className="text-lg font-semibold text-blue-900">
            You&apos;ve been invited to join{" "}
            <span className="underline">{pendingInvite.organizationName}</span>
          </p>
          <p className="mt-2 text-sm text-zinc-600">
            Check your email for the invitation link to accept and join
            the organisation. Your profile will be set up as part of that flow.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Essential Fields */}
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="name">
              Full Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              {...register("name")}
              placeholder="Enter your full name"
            />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={session?.user?.email || ""}
              disabled
              className="bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Email cannot be changed
            </p>
          </div>
        </div>
      </div>

      {/* #1132 — DPDP age gate. India's age of majority is 18 (s.2(f)), and
          below it processing needs verifiable parental consent (s.9); there was
          no age check anywhere in the product before this. Collecting the DOB
          solely to run the check is an exempt purpose (Fourth Schedule Part B
          item 6).

          Deliberately OUTSIDE the optional collapsible below: the field is
          required, so behind a closed disclosure labelled "optional" a submit
          failed with both the input and its error invisible. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="dateOfBirth">
            Date of birth <span className="text-destructive">*</span>
          </Label>
          <Controller
            name="dateOfBirth"
            control={control}
            render={({ field }) => (
              <Input
                id="dateOfBirth"
                type="date"
                max={new Date().toISOString().slice(0, 10)}
                // Handles both shapes the schema accepts: a Date from this
                // input, or a `YYYY-MM-DD` string restored from the wizard's
                // JSON round-trip on back-navigation.
                value={
                  field.value instanceof Date
                    ? isNaN(field.value.getTime())
                      ? ""
                      : field.value.toISOString().slice(0, 10)
                    : typeof field.value === "string"
                      ? field.value.slice(0, 10)
                      : ""
                }
                onChange={(e) =>
                  field.onChange(
                    e.target.value ? new Date(e.target.value) : undefined,
                  )
                }
                aria-invalid={!!errors.dateOfBirth}
              />
            )}
          />
          {errors.dateOfBirth ? (
            <p className="text-sm text-destructive">
              {errors.dateOfBirth.message}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              You must be at least 18 to use Familiarise.
            </p>
          )}
        </div>
      </div>

      {/* Optional Fields Collapsible */}
      <Collapsible open={optionalOpen} onOpenChange={setOptionalOpen}>
        <CollapsibleTrigger className="flex items-center justify-between w-full py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
          <span>Additional Details (optional)</span>
          <ChevronDown
            className={`w-4 h-4 transition-transform ${optionalOpen ? "rotate-180" : ""}`}
          />
        </CollapsibleTrigger>
        <p className="text-xs text-muted-foreground mb-2">
          You can always add these later from your profile settings
        </p>
        <CollapsibleContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number</Label>
              <Input
                id="phone"
                {...register("phone")}
                placeholder="+1 (555) 000-0000"
              />
              {errors.phone && (
                <p className="text-sm text-destructive">
                  {errors.phone.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="gender">Gender</Label>
              <Controller
                name="gender"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || undefined}
                    onValueChange={(value) => field.onChange(value as Gender)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select gender" />
                    </SelectTrigger>
                    <SelectContent>
                      {GENDER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                {...register("city")}
                placeholder="e.g., San Francisco"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="country">Country</Label>
              <Input
                id="country"
                {...register("country")}
                placeholder="e.g., United States"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">Full Address (Optional)</Label>
            <Input
              id="address"
              {...register("address")}
              placeholder="Street address, apt, city, state, zip"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="bio">
              Short Bio{" "}
              <span className="text-muted-foreground">(Optional)</span>
            </Label>
            <Textarea
              id="bio"
              {...register("bio")}
              placeholder="Tell us a bit about yourself in one or two sentences..."
              className="resize-none"
              rows={2}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>A brief tagline that appears on your profile</span>
              <span className={bioLength > 160 ? "text-destructive" : ""}>
                {bioLength}/160
              </span>
            </div>
            {errors.bio && (
              <p className="text-sm text-destructive">{errors.bio.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="linkedinUrl">
              LinkedIn Profile{" "}
              <span className="text-muted-foreground">(Optional)</span>
            </Label>
            <Input
              id="linkedinUrl"
              {...register("linkedinUrl")}
              placeholder="https://linkedin.com/in/yourprofile"
            />
            {errors.linkedinUrl && (
              <p className="text-sm text-destructive">
                {errors.linkedinUrl.message}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Role Selection */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          I want to join as a... <span className="text-destructive">*</span>
        </h3>

        <Controller
          name="role"
          control={control}
          render={({ field }) => (
            <div
              className={`grid gap-3 ${Object.keys(ROLE_INFO).length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}
            >
              {Object.entries(ROLE_INFO).map(([role, info]) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => field.onChange(role as UserRole)}
                  className={`p-4 rounded-lg border-2 text-left transition-all ${
                    field.value === role
                      ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                      : "border-border hover:border-primary/50 hover:bg-muted/50"
                  }`}
                >
                  <div className="font-medium">{info.title}</div>
                  <div className="text-sm text-muted-foreground mt-1">
                    {info.description}
                  </div>
                </button>
              ))}
            </div>
          )}
        />
        {errors.role && (
          <p className="text-sm text-destructive">{errors.role.message}</p>
        )}
      </div>

      {/* Role-specific info */}
      {selectedRole && (
        <div className="bg-muted/50 rounded-lg p-4 text-sm">
          <p className="text-muted-foreground">
            {selectedRole === "CONSULTANT" && (
              <>
                As a <strong>Consultant</strong>, you'll be able to create
                consultation plans, set your availability, and connect with
                consultees who need your expertise.
              </>
            )}
            {selectedRole === "CONSULTEE" && (
              <>
                As a <strong>Consultee</strong>, you'll be able to browse
                consultants, book sessions, and get personalized guidance from
                experts in your field.
              </>
            )}
            {selectedRole === "ORG_WORKSPACE" && (
              <>
                As an <strong>Organization Owner</strong>, you&apos;ll be able
                to create and manage an organization, invite team members,
                sponsor consultations, and access analytics for your school or
                company.
              </>
            )}
            {/* STAFF and ADMIN roles are invite-only via admin dashboard */}
          </p>
        </div>
      )}

      <Button
        type="submit"
        className="w-full"
        size="lg"
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Continuing...
          </>
        ) : (
          "Continue"
        )}
      </Button>
    </form>
  );
};

export default PersonalInfoAndRoleForm;
