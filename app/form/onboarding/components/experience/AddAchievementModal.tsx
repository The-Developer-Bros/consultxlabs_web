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
import { AchievementCreateInputSchema } from "@/utils/onboarding";
import { LONG_FORM_TEXT_MAX } from "@/schemas/user";
import { AchievementType } from "@prisma/client";
import type { Achievement } from "./AchievementsSection";

interface AddAchievementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (achievement: Achievement | Omit<Achievement, "id">) => void;
  achievement?: Achievement | null;
}

const ACHIEVEMENT_TYPES = [
  { value: "AWARD", label: "Award" },
  { value: "PUBLICATION", label: "Publication" },
  { value: "PROJECT", label: "Project" },
  { value: "TALK", label: "Talk / Conference" },
  { value: "OPEN_SOURCE", label: "Open Source" },
  { value: "OTHER", label: "Other" },
];

export function AddAchievementModal({
  isOpen,
  onClose,
  onSave,
  achievement,
}: AddAchievementModalProps) {
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    url: "",
    achievementType: AchievementType.OTHER as AchievementType,
  });

  const isEditing = !!achievement;

  useEffect(() => {
    if (achievement) {
      setFormData({
        title: achievement.title,
        description: achievement.description || "",
        url: achievement.url || "",
        achievementType: achievement.achievementType || AchievementType.OTHER,
      });
    } else {
      setFormData({
        title: "",
        description: "",
        url: "",
        achievementType: AchievementType.OTHER,
      });
    }
  }, [achievement, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const data = {
      ...(achievement?.id ? { id: achievement.id } : {}),
      title: formData.title,
      description: formData.description || undefined,
      url: formData.url || undefined,
      achievementType: formData.achievementType,
    };

    const validated = AchievementCreateInputSchema.parse(data);
    onSave(validated);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Achievement" : "Add Achievement"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update your achievement details"
              : "Showcase a key accomplishment, publication, or project"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-2">
              <Label htmlFor="achievementTitle">Title *</Label>
              <Input
                id="achievementTitle"
                value={formData.title}
                onChange={(e) =>
                  setFormData({ ...formData, title: e.target.value })
                }
                placeholder="e.g., Speaker at React Summit 2025"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="achievementType">Type</Label>
              <Select
                value={formData.achievementType}
                onValueChange={(value) =>
                  setFormData({
                    ...formData,
                    achievementType: value as AchievementType,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {ACHIEVEMENT_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="achievementDescription">Description</Label>
              <Textarea
                id="achievementDescription"
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="Brief description of this achievement..."
                rows={3}
                maxLength={LONG_FORM_TEXT_MAX}
              />
              <p className="text-xs text-muted-foreground text-right">
                {formData.description?.length || 0}/{LONG_FORM_TEXT_MAX}{" "}
                characters
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="achievementUrl">Link</Label>
              <Input
                id="achievementUrl"
                type="url"
                value={formData.url}
                onChange={(e) =>
                  setFormData({ ...formData, url: e.target.value })
                }
                placeholder="https://..."
              />
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
