"use client";

import { SessionType } from "@prisma/client";
import { Checkbox } from "components/ui/checkbox";
import { Input } from "components/ui/input";
import { Label } from "components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "components/ui/select";
import { SHORT_FORM_TEXT_MAX } from "@/schemas/user";
import { Separator } from "components/ui/separator";
import { Textarea } from "components/ui/textarea";
import { useState, useEffect, type Dispatch, type SetStateAction } from "react";
import { MultiSelect } from "../../../components/MultiSelect";
import type { Domain, FormData } from "../settings";

export interface Option {
  value: string;
  label: string;
}

interface ProfileSectionProps {
  formData: FormData;
  setFormData: Dispatch<SetStateAction<FormData>>;
  domains: Domain[];
  subDomainOptions: Option[];
  tagOptions: Option[];
  onInputChange: (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  onDomainChange: (value: string, e?: Event) => void;
  onSubDomainChange: (values: string[]) => void;
  onTagChange: (values: string[]) => void;
}

/**
 * Profile tab of the consultant settings form — domain expertise,
 * professional background, enhanced profile (headline / socials / skills).
 * Presentational only: form state lives in SettingsTab so the combined
 * settings PUT payload is unchanged by the decomposition.
 */
export function ProfileSection({
  formData,
  setFormData,
  domains,
  subDomainOptions,
  tagOptions,
  onInputChange,
  onDomainChange,
  onSubDomainChange,
  onTagChange,
}: ProfileSectionProps) {
  // Local raw-text state for the comma-separated inputs: binding the joined
  // array directly made typing a comma impossible (split+filter on every
  // keystroke deleted it). Parent state commits on blur.
  const [languagesInput, setLanguagesInput] = useState(() =>
    (formData.languages || []).join(", "),
  );
  const [toolsInput, setToolsInput] = useState(() =>
    (formData.toolsAndTechnologies || []).join(", "),
  );
  useEffect(() => {
    setLanguagesInput((formData.languages || []).join(", "));
  }, [formData.languages]);
  useEffect(() => {
    setToolsInput((formData.toolsAndTechnologies || []).join(", "));
  }, [formData.toolsAndTechnologies]);

  return (
    <>
      {/* Professional Profile */}
      <div>
        <h2 className="text-2xl font-bold mb-3">Professional Profile</h2>
        <p className="text-sm text-zinc-600 mb-8">
          Showcase your expertise and professional background
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column - Core Info */}
          <div className="space-y-6">
            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Domain Expertise
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-zinc-600">
                    Primary Domain
                  </Label>
                  <Select
                    value={formData.domainId || ""}
                    onValueChange={onDomainChange}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select your primary domain" />
                    </SelectTrigger>
                    <SelectContent>
                      {(domains || [])
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((domain) => (
                          <SelectItem key={domain.id} value={domain.id}>
                            {domain.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">Sub Domains</Label>
                  <div className="mt-1">
                    <MultiSelect
                      options={subDomainOptions}
                      selected={formData.subDomainIds || []}
                      onChange={onSubDomainChange}
                      placeholder="Select relevant sub domains"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">
                    Expertise Tags
                  </Label>
                  <div className="mt-1">
                    <MultiSelect
                      options={tagOptions}
                      selected={formData.tagIds || []}
                      onChange={onTagChange}
                      placeholder="Add expertise tags"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Professional Background
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-zinc-600">
                    Years of Experience
                  </Label>
                  <Input
                    name="experience"
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={formData.experience}
                    onChange={onInputChange}
                    placeholder="Years of experience (e.g. 5.5)"
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Right Column - Description */}
          <div className="rounded-lg bg-zinc-50 p-6">
            <Label className="mb-4 block text-lg font-semibold">
              Professional Summary
            </Label>
            <p className="mb-3 text-sm text-zinc-600">
              Write a compelling description of your expertise and what makes
              you unique
            </p>
            <Textarea
              name="description"
              value={formData.description}
              onChange={onInputChange}
              placeholder="Share your professional journey, achievements, and what clients can expect when working with you..."
              className="min-h-[16rem] resize-none"
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* Enhanced Profile Section */}
      <div>
        <h2 className="text-2xl font-bold mb-3">Enhanced Profile</h2>
        <p className="text-sm text-zinc-600 mb-8">
          Add more details to help mentees find and connect with you
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column - Headlines and Bio */}
          <div className="space-y-6">
            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Profile Highlights
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-zinc-600">
                    Professional Headline
                  </Label>
                  <Input
                    name="headline"
                    value={formData.headline}
                    onChange={onInputChange}
                    placeholder="e.g., Senior Software Engineer | 10+ Years in AI/ML"
                    className="mt-1"
                    maxLength={120}
                  />
                  <p className="text-xs text-zinc-400 mt-1">
                    {formData.headline?.length || 0}/120 characters
                  </p>
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">
                    Mentoring Style
                  </Label>
                  <Textarea
                    name="mentoringStyle"
                    value={formData.mentoringStyle}
                    onChange={onInputChange}
                    placeholder="Describe how you approach mentoring sessions (e.g., hands-on, structured, conversational...)"
                    className="mt-1 resize-none h-24"
                    maxLength={SHORT_FORM_TEXT_MAX}
                  />
                  <p className="text-xs text-zinc-400 mt-1">
                    {formData.mentoringStyle?.length || 0}/{SHORT_FORM_TEXT_MAX}{" "}
                    characters
                  </p>
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">
                    Video Introduction URL
                  </Label>
                  <Input
                    name="videoIntroUrl"
                    value={formData.videoIntroUrl}
                    onChange={onInputChange}
                    placeholder="https://youtube.com/watch?v=..."
                    className="mt-1"
                    type="url"
                  />
                </div>
              </div>
            </div>

            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Session Types
              </Label>
              <p className="text-sm text-zinc-600 mb-4">
                Select the types of sessions you offer
              </p>
              <div className="space-y-3">
                {Object.values(SessionType).map((type) => (
                  <div key={type} className="flex items-center space-x-3">
                    <Checkbox
                      id={`session-${type}`}
                      checked={formData.sessionTypes?.includes(type)}
                      onCheckedChange={(checked) => {
                        setFormData((prev) => ({
                          ...prev,
                          sessionTypes: checked
                            ? [...(prev.sessionTypes || []), type]
                            : (prev.sessionTypes || []).filter(
                                (t) => t !== type,
                              ),
                        }));
                      }}
                    />
                    <Label
                      htmlFor={`session-${type}`}
                      className="text-sm cursor-pointer"
                    >
                      {type === "ONE_ON_ONE" && "1:1 Sessions"}
                      {type === "GROUP" && "Group Sessions"}
                      {type === "ASYNC_REVIEW" &&
                        "Async Review (Code/Document)"}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Column - Social Links and Skills */}
          <div className="space-y-6">
            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Social & Professional Links
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-zinc-600">Website</Label>
                  <Input
                    name="websiteUrl"
                    value={formData.websiteUrl}
                    onChange={onInputChange}
                    placeholder="https://your-portfolio.com"
                    className="mt-1"
                    type="url"
                  />
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">GitHub</Label>
                  <Input
                    name="githubUrl"
                    value={formData.githubUrl}
                    onChange={onInputChange}
                    placeholder="https://github.com/username"
                    className="mt-1"
                    type="url"
                  />
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">Twitter/X</Label>
                  <Input
                    name="twitterUrl"
                    value={formData.twitterUrl}
                    onChange={onInputChange}
                    placeholder="https://twitter.com/username"
                    className="mt-1"
                    type="url"
                  />
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">LinkedIn</Label>
                  <Input
                    name="linkedinUrl"
                    value={formData.linkedinUrl}
                    onChange={onInputChange}
                    placeholder="https://linkedin.com/in/username"
                    className="mt-1"
                    type="url"
                  />
                </div>
              </div>
            </div>

            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Skills & Languages
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-zinc-600">
                    Languages Spoken
                  </Label>
                  <Input
                    value={languagesInput}
                    onChange={(e) => setLanguagesInput(e.target.value)}
                    onBlur={() => {
                      const languages = languagesInput
                        .split(",")
                        .map((l) => l.trim())
                        .filter(Boolean);
                      setFormData((prev) => ({ ...prev, languages }));
                    }}
                    placeholder="English, Hindi, Spanish (comma-separated)"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">
                    Tools & Technologies
                  </Label>
                  <Input
                    value={toolsInput}
                    onChange={(e) => setToolsInput(e.target.value)}
                    onBlur={() => {
                      const toolsAndTechnologies = toolsInput
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean);
                      setFormData((prev) => ({
                        ...prev,
                        toolsAndTechnologies,
                      }));
                    }}
                    placeholder="React, Python, AWS (comma-separated)"
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
