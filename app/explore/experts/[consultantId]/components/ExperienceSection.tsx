"use client";

import { Award, Calendar, MapPin } from "lucide-react";
import { CompanyLogo } from "@/components/ui/company-logo";
import { InstitutionLogo } from "@/components/ui/institution-logo";
import { WorkExperience, Education, Certification } from "@prisma/client";

interface ExperienceSectionProps {
  workExperiences: WorkExperience[];
  education: Education[];
  certifications: Certification[];
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

function formatDateRange(
  startDate: Date | null | undefined,
  endDate: Date | null | undefined,
  isCurrent?: boolean,
): string {
  const start = formatDate(startDate);
  if (isCurrent) return `${start} – Present`;
  const end = formatDate(endDate);
  return end ? `${start} – ${end}` : start;
}

function formatYearRange(
  startYear: number | null,
  endYear: number | null,
): string {
  if (!startYear && !endYear) return "";
  if (!endYear) return `${startYear} – Present`;
  if (!startYear) return `${endYear}`;
  return `${startYear} – ${endYear}`;
}

function BlockHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-4 flex items-baseline gap-2">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <span className="text-sm tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

function WorkExperienceRow({ experience }: { experience: WorkExperience }) {
  return (
    <li className="flex gap-4 py-4 first:pt-0 last:pb-0">
      <CompanyLogo
        companyName={experience.company}
        companyDomain={experience.companyDomain ?? undefined}
        size={44}
        className="border-border"
      />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-foreground">{experience.title}</p>
        <p className="text-sm text-muted-foreground">{experience.company}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5" />
            {formatDateRange(
              experience.startDate,
              experience.endDate,
              experience.isCurrent,
            )}
          </span>
          {experience.location && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" />
              {experience.location}
            </span>
          )}
        </div>
        {experience.description && (
          <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
            {experience.description}
          </p>
        )}
      </div>
    </li>
  );
}

function EducationRow({ education }: { education: Education }) {
  return (
    <li className="flex gap-4 py-4 first:pt-0 last:pb-0">
      <InstitutionLogo
        institutionName={education.institution}
        institutionDomain={education.institutionDomain ?? undefined}
        size={44}
      />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-foreground">{education.degree}</p>
        <p className="text-sm text-muted-foreground">{education.institution}</p>
        {education.fieldOfStudy && (
          <p className="text-sm text-muted-foreground">
            {education.fieldOfStudy}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5" />
            {formatYearRange(education.startYear, education.endYear)}
          </span>
          {education.grade && <span>Grade: {education.grade}</span>}
        </div>
        {education.activities && (
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
            {education.activities}
          </p>
        )}
      </div>
    </li>
  );
}

function CertificationChip({
  certification,
}: {
  certification: Certification;
}) {
  return (
    <li className="inline-flex items-center gap-2.5 rounded-xl border border-border bg-muted/40 px-3 py-2">
      <Award className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">
          {certification.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {certification.issuingOrganization}
        </span>
      </span>
    </li>
  );
}

export function ExperienceSection({
  workExperiences,
  education,
  certifications,
}: ExperienceSectionProps) {
  // Don't render if all sections are empty
  if (
    workExperiences.length === 0 &&
    education.length === 0 &&
    certifications.length === 0
  ) {
    return null;
  }

  const sortedWork = workExperiences.slice().sort((a, b) => {
    // Sort by isCurrent first, then by startDate
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    return new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
  });
  const sortedEducation = education
    .slice()
    .sort((a, b) => (b.endYear || 9999) - (a.endYear || 9999));
  const sortedCertifications = certifications
    .slice()
    .sort(
      (a, b) =>
        new Date(b.issueDate).getTime() - new Date(a.issueDate).getTime(),
    );

  return (
    <section className="space-y-8 rounded-2xl border border-border bg-card p-6 md:p-8">
      {sortedWork.length > 0 && (
        <div>
          <BlockHeader title="Experience" count={sortedWork.length} />
          <ul className="divide-y divide-border">
            {sortedWork.map((exp) => (
              <WorkExperienceRow key={exp.id} experience={exp} />
            ))}
          </ul>
        </div>
      )}

      {sortedEducation.length > 0 && (
        <div>
          <BlockHeader title="Education" count={sortedEducation.length} />
          <ul className="divide-y divide-border">
            {sortedEducation.map((edu) => (
              <EducationRow key={edu.id} education={edu} />
            ))}
          </ul>
        </div>
      )}

      {sortedCertifications.length > 0 && (
        <div>
          <BlockHeader
            title="Certifications"
            count={sortedCertifications.length}
          />
          <ul className="flex flex-wrap gap-2">
            {sortedCertifications.map((cert) => (
              <CertificationChip key={cert.id} certification={cert} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
