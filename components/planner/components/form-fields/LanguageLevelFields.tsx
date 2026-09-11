"use client";

import {
  Control,
  FieldPath,
  FieldValues,
  useController,
} from "react-hook-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import iso6391 from "iso-639-1";
import { cn } from "@/utils/tailwind";
import { PlanLevel } from "@prisma/client";
import { PLAN_LEVEL_ORDER, planLevelLabel } from "@/lib/labels/plan-labels";

interface LanguageLevelFieldsProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  languageName?: string;
  levelName?: string;
  className?: string;
  gridCols?: 1 | 2;
}

export function LanguageLevelFields<T extends FieldValues = FieldValues>({
  control,
  languageName = "language",
  levelName = "level",
  className,
  gridCols = 2,
}: Readonly<LanguageLevelFieldsProps<T>>) {
  const {
    field: languageField,
    fieldState: { error: languageError },
  } = useController({
    name: languageName as FieldPath<T>,
    control,
    defaultValue: "English" as T[string],
  });

  const {
    field: levelField,
    fieldState: { error: levelError },
  } = useController({
    name: levelName as FieldPath<T>,
    control,
    defaultValue: PlanLevel.BEGINNER as T[string],
  });

  const languageNames = iso6391.getAllNames();

  return (
    <div
      className={cn(
        "grid gap-4",
        gridCols === 2 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1",
        className,
      )}
    >
      {/* Language Select */}
      <FormItem>
        <FormLabel>Language</FormLabel>
        <Select
          value={languageField.value}
          onValueChange={languageField.onChange}
        >
          <SelectTrigger className={cn(languageError && "border-destructive")}>
            <SelectValue placeholder="Select language" />
          </SelectTrigger>
          <SelectContent className="max-h-[200px]">
            {languageNames.map((langName) => (
              <SelectItem key={langName} value={langName}>
                {langName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {languageError && <FormMessage>{languageError.message}</FormMessage>}
      </FormItem>

      {/* Level Select */}
      <FormItem>
        <FormLabel>Level</FormLabel>
        <Select value={levelField.value} onValueChange={levelField.onChange}>
          <SelectTrigger className={cn(levelError && "border-destructive")}>
            <SelectValue placeholder="Select level" />
          </SelectTrigger>
          <SelectContent>
            {PLAN_LEVEL_ORDER.map((level) => (
              <SelectItem key={level} value={level}>
                {planLevelLabel(level)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {levelError && <FormMessage>{levelError.message}</FormMessage>}
      </FormItem>
    </div>
  );
}
