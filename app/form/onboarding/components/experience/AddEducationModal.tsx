"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EducationSchema,
  LONG_FORM_TEXT_MAX,
  SHORT_FORM_TEXT_MAX,
} from "@/schemas/user";
import { Education } from "./EducationSection";
import {
  InstitutionLogo,
  lookupInstitutionDomain,
} from "@/components/ui/institution-logo";

interface AddEducationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (education: Education | Omit<Education, "id">) => void;
  education?: Education | null;
}

const currentYear = new Date().getFullYear();
const years = Array.from({ length: 50 }, (_, i) => currentYear - i);

export function AddEducationModal({
  isOpen,
  onClose,
  onSave,
  education,
}: AddEducationModalProps) {
  const [formData, setFormData] = useState({
    institution: "",
    institutionDomain: "",
    degree: "",
    fieldOfStudy: "",
    startYear: "",
    endYear: "",
    grade: "",
    activities: "",
    description: "",
  });

  const isEditing = !!education;

  useEffect(() => {
    if (education) {
      setFormData({
        institution: education.institution,
        institutionDomain: education.institutionDomain || "",
        degree: education.degree,
        fieldOfStudy: education.fieldOfStudy || "",
        startYear: education.startYear?.toString() || "",
        endYear: education.endYear?.toString() || "",
        grade: education.grade || "",
        activities: education.activities || "",
        description: education.description || "",
      });
    } else {
      setFormData({
        institution: "",
        institutionDomain: "",
        degree: "",
        fieldOfStudy: "",
        startYear: "",
        endYear: "",
        grade: "",
        activities: "",
        description: "",
      });
    }
  }, [education, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const data = {
      ...(education?.id ? { id: education.id } : {}),
      institution: formData.institution,
      institutionDomain: formData.institutionDomain || undefined,
      degree: formData.degree,
      fieldOfStudy: formData.fieldOfStudy || undefined,
      startYear: formData.startYear ? parseInt(formData.startYear) : undefined,
      endYear: formData.endYear ? parseInt(formData.endYear) : undefined,
      grade: formData.grade || undefined,
      activities: formData.activities || undefined,
      description: formData.description || undefined,
    };

    const validated = EducationSchema.parse(data);
    onSave(validated);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Education" : "Add Education"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update your education details"
              : "Add details about your educational background"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-2">
              <Label htmlFor="institution">School/University *</Label>
              <div className="flex items-center gap-3">
                {formData.institution && (
                  <InstitutionLogo
                    institutionName={formData.institution}
                    institutionDomain={formData.institutionDomain || undefined}
                    size={36}
                  />
                )}
                <Input
                  id="institution"
                  value={formData.institution}
                  onChange={(e) => {
                    const name = e.target.value;
                    const domain = lookupInstitutionDomain(name);
                    setFormData({
                      ...formData,
                      institution: name,
                      institutionDomain: domain ?? "",
                    });
                  }}
                  placeholder="e.g., Stanford University"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="degree">Degree *</Label>
              <Input
                id="degree"
                value={formData.degree}
                onChange={(e) =>
                  setFormData({ ...formData, degree: e.target.value })
                }
                placeholder="e.g., Bachelor of Science"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="fieldOfStudy">Field of Study</Label>
              <Input
                id="fieldOfStudy"
                value={formData.fieldOfStudy}
                onChange={(e) =>
                  setFormData({ ...formData, fieldOfStudy: e.target.value })
                }
                placeholder="e.g., Computer Science"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startYear">Start Year</Label>
                <Select
                  value={formData.startYear}
                  onValueChange={(value) =>
                    setFormData({ ...formData, startYear: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select year" />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((year) => (
                      <SelectItem key={year} value={year.toString()}>
                        {year}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="endYear">End Year</Label>
                <Select
                  value={formData.endYear}
                  onValueChange={(value) =>
                    setFormData({ ...formData, endYear: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select year" />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((year) => (
                      <SelectItem key={year} value={year.toString()}>
                        {year}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="grade">Grade/GPA</Label>
              <Input
                id="grade"
                value={formData.grade}
                onChange={(e) =>
                  setFormData({ ...formData, grade: e.target.value })
                }
                placeholder="e.g., 3.8/4.0 or First Class"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="activities">Activities & Societies</Label>
              <Input
                id="activities"
                value={formData.activities}
                onChange={(e) =>
                  setFormData({ ...formData, activities: e.target.value })
                }
                placeholder="e.g., Student Council, Debate Club"
                maxLength={SHORT_FORM_TEXT_MAX}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="Additional details about your education..."
                rows={3}
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
