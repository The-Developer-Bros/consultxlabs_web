"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CompanyLogo, lookupCompanyDomain } from "@/components/ui/company-logo";
import { LONG_FORM_TEXT_MAX, WorkExperienceSchema } from "@/schemas/user";
import { WorkExperience } from "./WorkExperienceSection";

interface AddWorkExperienceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (experience: WorkExperience | Omit<WorkExperience, "id">) => void;
  experience?: WorkExperience | null;
}

export function AddWorkExperienceModal({
  isOpen,
  onClose,
  onSave,
  experience,
}: AddWorkExperienceModalProps) {
  const [formData, setFormData] = useState({
    company: "",
    companyDomain: "",
    title: "",
    location: "",
    startDate: "",
    endDate: "",
    isCurrent: false,
    description: "",
  });
  const [manualDomainMode, setManualDomainMode] = useState(false);

  const isEditing = !!experience;

  // Auto-detected domain from company name
  const autoDetectedDomain = useMemo(
    () => lookupCompanyDomain(formData.company),
    [formData.company],
  );

  // Effective domain: manual override > auto-detected
  const effectiveDomain = formData.companyDomain || autoDetectedDomain || "";

  useEffect(() => {
    if (experience) {
      setFormData({
        company: experience.company,
        companyDomain: experience.companyDomain || "",
        title: experience.title,
        location: experience.location || "",
        startDate: experience.startDate
          ? new Date(experience.startDate).toISOString().split("T")[0]
          : "",
        endDate: experience.endDate
          ? new Date(experience.endDate).toISOString().split("T")[0]
          : "",
        isCurrent: experience.isCurrent,
        description: experience.description || "",
      });
      // Show manual domain input if editing and has a custom domain
      setManualDomainMode(
        !!experience.companyDomain &&
          lookupCompanyDomain(experience.company) !== experience.companyDomain,
      );
    } else {
      setFormData({
        company: "",
        companyDomain: "",
        title: "",
        location: "",
        startDate: "",
        endDate: "",
        isCurrent: false,
        description: "",
      });
      setManualDomainMode(false);
    }
  }, [experience, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const data = {
      ...(experience?.id ? { id: experience.id } : {}),
      company: formData.company,
      companyDomain: effectiveDomain || undefined,
      title: formData.title,
      location: formData.location || undefined,
      startDate: new Date(formData.startDate),
      endDate: formData.isCurrent
        ? undefined
        : formData.endDate
          ? new Date(formData.endDate)
          : undefined,
      isCurrent: formData.isCurrent,
      description: formData.description || undefined,
    };

    const validated = WorkExperienceSchema.parse(data);
    onSave(validated);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Work Experience" : "Add Work Experience"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update your work experience details"
              : "Add details about your work experience"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-2">
              <Label htmlFor="title">Job Title *</Label>
              <Input
                id="title"
                value={formData.title}
                onChange={(e) =>
                  setFormData({ ...formData, title: e.target.value })
                }
                placeholder="e.g., Senior Software Engineer"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company">Company *</Label>
              <div className="flex items-center gap-2">
                {effectiveDomain && (
                  <CompanyLogo
                    companyDomain={effectiveDomain}
                    companyName={formData.company}
                    size={36}
                  />
                )}
                <Input
                  id="company"
                  value={formData.company}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      company: e.target.value,
                      // Clear manual domain when company name changes (let auto-detect work)
                      companyDomain: manualDomainMode
                        ? formData.companyDomain
                        : "",
                    })
                  }
                  placeholder="e.g., Google"
                  required
                  className="flex-1"
                />
              </div>
              {autoDetectedDomain && !manualDomainMode && (
                <p className="text-xs text-muted-foreground">
                  Logo detected automatically
                </p>
              )}
              {!autoDetectedDomain &&
                !manualDomainMode &&
                formData.company.length > 0 && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setManualDomainMode(true)}
                  >
                    Add company website to show logo
                  </button>
                )}
            </div>

            {manualDomainMode && (
              <div className="space-y-2">
                <Label htmlFor="companyDomain">Company Website Domain</Label>
                <Input
                  id="companyDomain"
                  value={formData.companyDomain}
                  onChange={(e) =>
                    setFormData({ ...formData, companyDomain: e.target.value })
                  }
                  placeholder="e.g., google.com"
                />
                <p className="text-xs text-muted-foreground">
                  Enter the company&apos;s website domain to display their logo
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="location">Location</Label>
              <Input
                id="location"
                value={formData.location}
                onChange={(e) =>
                  setFormData({ ...formData, location: e.target.value })
                }
                placeholder="e.g., San Francisco, CA"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date *</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={formData.startDate}
                  onChange={(e) =>
                    setFormData({ ...formData, startDate: e.target.value })
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={formData.endDate}
                  onChange={(e) =>
                    setFormData({ ...formData, endDate: e.target.value })
                  }
                  disabled={formData.isCurrent}
                />
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="isCurrent"
                checked={formData.isCurrent}
                onCheckedChange={(checked) =>
                  setFormData({
                    ...formData,
                    isCurrent: checked === true,
                    endDate: checked ? "" : formData.endDate,
                  })
                }
              />
              <Label htmlFor="isCurrent" className="font-normal">
                I currently work here
              </Label>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="Describe your responsibilities and achievements..."
                rows={4}
                maxLength={LONG_FORM_TEXT_MAX}
              />
              <p className="text-xs text-muted-foreground text-right">
                {formData.description?.length || 0}/{LONG_FORM_TEXT_MAX}{" "}
                characters
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">{isEditing ? "Save Changes" : "Add"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
