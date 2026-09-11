import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, X, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LONG_FORM_TEXT_MAX, PersonalInfoAndRole } from "@/schemas/user";
import { Domain, SubDomain, Tag } from "@/schemas/plans";
import {
  ConsultantProfileFormSchema,
  OnboardingFormData,
} from "@/utils/onboarding";
import { validateTagName } from "@/utils/contentValidation";
import type { Resolver } from "react-hook-form";
import { z } from "zod";

interface Props {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  initialData: Partial<OnboardingFormData>;
  personalInfo: PersonalInfoAndRole;
}

type FormData = z.infer<typeof ConsultantProfileFormSchema>;

const ConsultantProfileForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
  personalInfo: _personalInfo,
}) => {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [subDomains, setSubDomains] = useState<SubDomain[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customTagInput, setCustomTagInput] = useState("");
  const [customTagError, setCustomTagError] = useState<string | null>(null);
  const [isAddingTag, setIsAddingTag] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormData>({
    // zodResolver infers slightly different optionality for .default() fields
    // (e.g., languages: string[] vs string[] | undefined). This targeted assertion
    // bridges the gap without opting out of type checking entirely.
    resolver: zodResolver(ConsultantProfileFormSchema) as Resolver<FormData>,
    mode: "onChange",
    defaultValues: {
      description: "",
      headline: "",
      experience: 0,
      scheduleType: "WEEKLY",
      domain: { id: "", name: "" },
      subDomains: [],
      tags: [],
      weeklySlots: [],
      customSlots: [],
      ...initialData,
    },
  });

  const selectedDomain = watch("domain");

  // Filter subdomains and tags based on selected domain
  const filteredSubDomains = useMemo(() => {
    return subDomains.filter((sub) => sub.domainId === selectedDomain?.id);
  }, [subDomains, selectedDomain]);

  const filteredTags = useMemo(() => {
    return tags.filter((tag) => tag.domainId === selectedDomain?.id);
  }, [tags, selectedDomain]);

  // Sync form values when initialData changes (for back navigation)
  useEffect(() => {
    if (initialData && Object.keys(initialData).length > 0) {
      reset({
        description: "",
        headline: "",
        experience: 0,
        scheduleType: "WEEKLY",
        domain: { id: "", name: "" },
        subDomains: [],
        tags: [],
        weeklySlots: [],
        customSlots: [],
        ...initialData,
      });
    }
  }, [initialData, reset]);

  const fetchMetadata = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/user/consultants/meta");
      if (!response.ok) {
        throw new Error("Failed to fetch metadata");
      }
      const { data } = await response.json();
      setDomains(data.domains);
      setSubDomains(data.subdomains);
      setTags(data.tags);
    } catch (error) {
      console.error("Error fetching metadata:", error);
      setError("Failed to load form data. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetadata();
  }, [fetchMetadata]);

  const onSubmit = (data: FormData) => {
    onNext(data);
  };

  const addCustomTag = useCallback(
    async (
      name: string,
      tagsField: { value?: Tag[]; onChange: (v: Tag[]) => void },
    ) => {
      const trimmed = name.trim();
      if (!trimmed || !selectedDomain?.id) return;

      // Validate on the client side first
      const validation = validateTagName(trimmed);
      if (!validation.valid) {
        setCustomTagError(validation.error ?? "Invalid skill name");
        return;
      }
      setCustomTagError(null);

      // Check if already in the available tags or selected
      const existing = tags.find(
        (t) =>
          t.name.toLowerCase() === trimmed.toLowerCase() &&
          t.domainId === selectedDomain.id,
      );
      if (existing) {
        if (!tagsField.value?.some((t) => t.id === existing.id)) {
          tagsField.onChange([...(tagsField.value || []), existing]);
        }
        setCustomTagInput("");
        return;
      }

      setIsAddingTag(true);
      try {
        const res = await fetch("/api/user/content/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed, domainId: selectedDomain.id }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setCustomTagError(data?.error ?? "Failed to add skill");
          return;
        }
        const { tag } = await res.json();
        setTags((prev) => [...prev, tag]);
        tagsField.onChange([...(tagsField.value || []), tag]);
        setCustomTagInput("");
        setCustomTagError(null);
      } catch (err) {
        console.error("Failed to create custom tag:", err);
        setCustomTagError("Failed to add skill. Please try again.");
      } finally {
        setIsAddingTag(false);
      }
    },
    [selectedDomain?.id, tags],
  );

  if (isLoading) {
    return (
      <div
        className="space-y-4 p-2 sm:p-4"
        aria-busy="true"
        aria-label="Loading form data"
      >
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-2">
            <div className="h-4 w-28 animate-pulse rounded bg-muted" />
            <div className="h-11 w-full animate-pulse rounded-lg bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center space-y-4 p-8">
        <p className="text-destructive text-lg">{error}</p>
        <Button onClick={fetchMetadata}>Retry</Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Professional Summary */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Professional Summary
        </h3>

        <div className="space-y-2">
          <Label htmlFor="description">
            About Your Expertise <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="description"
            {...register("description")}
            placeholder="Tell us about your expertise and what you can offer to consultees"
            rows={4}
            maxLength={LONG_FORM_TEXT_MAX}
          />
          {errors.description && (
            <p className="text-sm text-destructive">
              {errors.description.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="headline">Professional Headline</Label>
          <Input
            id="headline"
            {...register("headline")}
            placeholder="e.g., Senior Software Engineer | Career Coach | 10+ Years Experience"
          />
          {errors.headline && (
            <p className="text-sm text-destructive">
              {errors.headline.message}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            A brief tagline that appears on your profile
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="experience">
            Years of Experience <span className="text-destructive">*</span>
          </Label>
          <Input
            id="experience"
            type="number"
            min="0"
            max="100"
            step="0.5"
            {...register("experience", { valueAsNumber: true })}
            placeholder="0"
          />
          {errors.experience && (
            <p className="text-sm text-destructive">
              {errors.experience.message}
            </p>
          )}
        </div>
      </div>

      {/* Domain & Expertise */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Domain & Expertise
        </h3>

        <div className="space-y-2">
          <Label>
            Primary Domain <span className="text-destructive">*</span>
          </Label>
          <Controller
            name="domain"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value?.id || ""}
                onValueChange={(value) => {
                  const domain = domains.find((d) => d.id === value);
                  field.onChange(domain || { id: "", name: "" });
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a domain" />
                </SelectTrigger>
                <SelectContent>
                  {domains.map((domain) => (
                    <SelectItem key={domain.id} value={domain.id || ""}>
                      {domain.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {errors.domain && (
            <p className="text-sm text-destructive">{errors.domain.message}</p>
          )}
        </div>

        {selectedDomain?.id && (
          <>
            <div className="space-y-2">
              <Label>Sub-domains</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-40 overflow-y-auto p-3 rounded-lg bg-muted/50 border">
                <Controller
                  name="subDomains"
                  control={control}
                  render={({ field }) => (
                    <>
                      {filteredSubDomains.map((subDomain) => (
                        <div
                          key={subDomain.id}
                          className="flex items-center space-x-2"
                        >
                          <Checkbox
                            id={`subdomain-${subDomain.id}`}
                            checked={
                              field.value?.some((s) => s.id === subDomain.id) ||
                              false
                            }
                            onCheckedChange={(checked) => {
                              if (checked) {
                                field.onChange([
                                  ...(field.value || []),
                                  subDomain,
                                ]);
                              } else {
                                field.onChange(
                                  field.value?.filter(
                                    (s) => s.id !== subDomain.id,
                                  ) || [],
                                );
                              }
                            }}
                          />
                          <Label
                            htmlFor={`subdomain-${subDomain.id}`}
                            className="text-sm cursor-pointer"
                          >
                            {subDomain.name}
                          </Label>
                        </div>
                      ))}
                    </>
                  )}
                />
              </div>
              {errors.subDomains && (
                <p className="text-sm text-destructive">
                  {errors.subDomains.message}
                </p>
              )}
            </div>

            <Controller
              name="tags"
              control={control}
              render={({ field: tagsField }) => (
                <div className="space-y-2">
                  <Label>Tags / Skills</Label>

                  {/* Selected tags as removable pills */}
                  {tagsField.value && tagsField.value.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {tagsField.value.map((tag) => (
                        <span
                          key={tag.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-sm"
                        >
                          {tag.name}
                          <button
                            type="button"
                            onClick={() =>
                              tagsField.onChange(
                                tagsField.value?.filter(
                                  (t) => t.id !== tag.id,
                                ) || [],
                              )
                            }
                            className="hover:text-destructive"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Checkbox grid for seeded tags */}
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-40 overflow-y-auto p-3 rounded-lg bg-muted/50 border">
                    {filteredTags.map((tag) => (
                      <div key={tag.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`tag-${tag.id}`}
                          checked={
                            tagsField.value?.some((t) => t.id === tag.id) ||
                            false
                          }
                          onCheckedChange={(checked) => {
                            if (checked) {
                              tagsField.onChange([
                                ...(tagsField.value || []),
                                tag,
                              ]);
                            } else {
                              tagsField.onChange(
                                tagsField.value?.filter(
                                  (t) => t.id !== tag.id,
                                ) || [],
                              );
                            }
                          }}
                        />
                        <Label
                          htmlFor={`tag-${tag.id}`}
                          className="text-sm cursor-pointer"
                        >
                          {tag.name}
                        </Label>
                      </div>
                    ))}
                  </div>

                  {/* Custom tag input */}
                  <div className="flex gap-2">
                    <Input
                      placeholder="Add a custom skill..."
                      value={customTagInput}
                      onChange={(e) => {
                        setCustomTagInput(e.target.value);
                        if (customTagError) setCustomTagError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCustomTag(customTagInput, tagsField);
                        }
                      }}
                      disabled={isAddingTag}
                      className={`flex-1 ${customTagError ? "border-destructive" : ""}`}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => addCustomTag(customTagInput, tagsField)}
                      disabled={isAddingTag || !customTagInput.trim()}
                    >
                      {isAddingTag ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Plus className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  {customTagError ? (
                    <p className="text-xs text-destructive">{customTagError}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Don&apos;t see your skill? Type it above and press Enter
                    </p>
                  )}

                  {errors.tags && (
                    <p className="text-sm text-destructive">
                      {errors.tags.message}
                    </p>
                  )}
                </div>
              )}
            />
          </>
        )}
      </div>

      {/* Schedule Type */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Schedule Preference
        </h3>

        <Controller
          name="scheduleType"
          control={control}
          render={({ field }) => (
            <div className="flex gap-4 flex-wrap">
              <Button
                type="button"
                onClick={() => field.onChange("WEEKLY")}
                variant={field.value === "WEEKLY" ? "default" : "outline"}
                className="flex-1"
              >
                Weekly Schedule
              </Button>
              <Button
                type="button"
                onClick={() => field.onChange("CUSTOM")}
                variant={field.value === "CUSTOM" ? "default" : "outline"}
                className="flex-1"
              >
                Custom Schedule
              </Button>
            </div>
          )}
        />
        <p className="text-sm text-muted-foreground">
          {watch("scheduleType") === "WEEKLY"
            ? "Set recurring weekly availability (e.g., Mondays 9am-5pm)"
            : "Set specific dates and times for availability"}
        </p>
        {errors.scheduleType && (
          <p className="text-sm text-destructive">
            {errors.scheduleType.message}
          </p>
        )}
      </div>

      {/* Navigation */}
      <div className="flex gap-4 pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="flex-1"
        >
          Back
        </Button>
        <Button type="submit" className="flex-1">
          Continue
        </Button>
      </div>
    </form>
  );
};

export default ConsultantProfileForm;
