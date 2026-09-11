"use client";

import { useState } from "react";
import {
  Control,
  FieldPath,
  FieldValues,
  useController,
} from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { Plus, Trash2, GripVertical } from "lucide-react";
import { cn } from "@/utils/tailwind";

/**
 * Add/remove editor for a plain `string[]` form field.
 *
 * Generalised out of `LearningOutcomesField`, which was already this component
 * with the copy hardcoded. The plan forms now author three such lists —
 * learning outcomes, target audience, and what's included — and the curriculum
 * editors author a fourth (per-session outcomes), so the noun is a prop.
 */
interface StringListFieldProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  name: string;
  label: string;
  placeholder?: string;
  description?: string;
  /** Plural noun used in the counter, duplicate/limit errors and empty state. */
  itemNoun?: string;
  maxItems?: number;
  className?: string;
}

export function StringListField<T extends FieldValues = FieldValues>({
  control,
  name,
  label,
  placeholder,
  description,
  itemNoun = "items",
  maxItems = 10,
  className,
}: Readonly<StringListFieldProps<T>>) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const {
    field,
    fieldState: { error: fieldError },
  } = useController({
    name: name as FieldPath<T>,
    control,
    defaultValue: [] as T[string],
  });

  const items = (field.value as string[]) || [];

  const addItem = () => {
    const value = draft.trim();
    if (!value) return;

    const isDuplicate = items.some(
      (item) => item.trim().toLowerCase() === value.toLowerCase(),
    );
    if (isDuplicate) {
      setError(`That entry is already in ${label.toLowerCase()}`);
      return;
    }

    if (items.length >= maxItems) {
      setError(`Maximum ${maxItems} ${itemNoun} allowed`);
      return;
    }

    setError(null);
    field.onChange([...items, value]);
    setDraft("");
  };

  const removeItem = (index: number) => {
    field.onChange(items.filter((_, i) => i !== index));
    setError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addItem();
    }
  };

  return (
    <FormItem className={className}>
      <FormLabel>{label}</FormLabel>
      {description && <FormDescription>{description}</FormDescription>}

      <div className="flex gap-2">
        <Input
          placeholder={placeholder}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          className="flex-1"
        />
        <Button
          type="button"
          onClick={addItem}
          variant="secondary"
          size="icon"
          className="shrink-0"
          aria-label={`Add to ${label.toLowerCase()}`}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {error && <p className="text-sm text-destructive mt-1">{error}</p>}

      {items.length > 0 && (
        <div className="space-y-2 mt-3">
          {items.map((item, index) => (
            <div
              key={`${name}-${index}-${item.slice(0, 10)}`}
              className={cn(
                "flex items-center gap-2 p-3 rounded-md",
                "bg-background border border-border/60",
                "hover:border-border hover:bg-muted/30 transition-colors",
                "group",
              )}
            >
              <GripVertical className="h-4 w-4 text-muted-foreground/50 shrink-0" />
              <span className="flex-1 text-sm">{item}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                onClick={() => removeItem(index)}
                aria-label={`Remove ${item}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {items.length === 0 && (
        <div className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md mt-2">
          No {itemNoun} added yet
        </div>
      )}

      <div className="flex justify-between items-center mt-2">
        <span className="text-xs text-muted-foreground">
          {items.length} / {maxItems} {itemNoun}
        </span>
      </div>

      {fieldError && <FormMessage>{fieldError.message}</FormMessage>}
    </FormItem>
  );
}
