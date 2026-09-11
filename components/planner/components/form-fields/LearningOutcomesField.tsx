"use client";

import { Control, FieldValues } from "react-hook-form";
import { StringListField } from "./StringListField";

/**
 * Learning-outcomes preset over {@link StringListField}.
 *
 * Kept as its own export so the existing call sites in all four planners keep
 * working unchanged; the implementation moved wholesale into StringListField
 * when the plan forms grew two more string-array fields.
 */
interface LearningOutcomesFieldProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  name: string;
  label?: string;
  placeholder?: string;
  description?: string;
  maxItems?: number;
  className?: string;
}

export function LearningOutcomesField<T extends FieldValues = FieldValues>({
  control,
  name,
  label = "Learning Outcomes",
  placeholder = "e.g., Understand React hooks lifecycle",
  description = "What participants will be able to do after completion",
  maxItems = 10,
  className,
}: Readonly<LearningOutcomesFieldProps<T>>) {
  return (
    <StringListField
      control={control}
      name={name}
      label={label}
      placeholder={placeholder}
      description={description}
      itemNoun="outcomes"
      maxItems={maxItems}
      className={className}
    />
  );
}
