"use client";

/**
 * The single field renderer.
 *
 * One grid definition serves all four offering types. The four dialogs this
 * replaces each declared their own — `md:grid-cols-2` three times and
 * `md:grid-cols-3` once — which is why the same section looked different
 * depending on which offering you were editing.
 */

import type {
  Control,
  ControllerRenderProps,
  FieldValues,
} from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PriceField } from "@/components/planner/components/form-fields/PriceField";
import { LanguageLevelFields } from "@/components/planner/components/form-fields/LanguageLevelFields";
import { LearningOutcomesField } from "@/components/planner/components/form-fields/LearningOutcomesField";
import { StringListField } from "@/components/planner/components/form-fields/StringListField";
import { PlanImageUploader } from "@/components/plans/PlanImageUploader";
import type { TPlanImageType } from "@/lib/supabase";
import type { FieldSpec } from "./manifest";

/** Sections are a 6-column grid so halves and thirds both land cleanly. */
const SPAN_CLASS: Record<NonNullable<FieldSpec["span"]>, string> = {
  2: "md:col-span-2",
  3: "md:col-span-3",
  6: "md:col-span-6",
};

/**
 * The control for one field kind.
 *
 * Lives outside the component because it was a ninety-line switch inlined in
 * JSX, which both the analyser and a reader mistake for a nested component.
 */
/** `YYYY-MM-DDTHH:mm` in the VIEWER's timezone, which is what the control reads back. */
function toLocalDateTimeValue(value: unknown): string {
  if (!value) return "";
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function renderControl<T extends FieldValues = FieldValues>(
  spec: FieldSpec,
  field: ControllerRenderProps<T, never>,
  planId: string | undefined,
  planImageType: TPlanImageType | undefined,
) {
  switch (spec.kind) {
    case "textarea":
      return (
        <Textarea
          placeholder={spec.placeholder}
          className="min-h-24"
          {...field}
          value={field.value ?? ""}
        />
      );
    case "number":
      return (
        <Input
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          placeholder={spec.placeholder}
          {...field}
          value={field.value ?? ""}
          onChange={(e) =>
            field.onChange(
              e.target.value === ""
                ? undefined
                : Number.parseFloat(e.target.value),
            )
          }
        />
      );
    case "date":
      return (
        <Input
          type="datetime-local"
          {...field}
          // datetime-local speaks LOCAL time in and out, so the value must be
          // formatted from local components. toISOString() renders UTC into a
          // local-time control: an IST author saw 04:30 for a 10:00 session
          // and, because onChange reads that same box back as local, merely
          // opening the form and saving shifted the stored instant by the
          // offset — every time, with no edit (#1060).
          value={toLocalDateTimeValue(field.value)}
          onChange={(e) =>
            field.onChange(e.target.value ? new Date(e.target.value) : null)
          }
        />
      );
    case "select":
      return (
        <Select onValueChange={field.onChange} value={field.value ?? undefined}>
          <SelectTrigger>
            <SelectValue placeholder={spec.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {spec.options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "switch":
      return (
        <Switch checked={!!field.value} onCheckedChange={field.onChange} />
      );
    case "image":
      return planId && planImageType ? (
        <PlanImageUploader
          planType={planImageType}
          planId={planId}
          currentImageUrl={field.value ?? null}
          onImageChange={field.onChange}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Save this offering as a draft first, then add a cover image.
        </p>
      );
    default:
      return (
        <Input
          placeholder={spec.placeholder}
          {...field}
          value={field.value ?? ""}
        />
      );
  }
}

interface OfferingFieldProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  spec: FieldSpec;
  /**
   * The saved offering, when there is one. The image uploader posts against an
   * existing plan id, so on a brand-new offering there is nothing to attach a
   * file to yet — the field says so rather than rendering a control that
   * cannot work.
   */
  planId?: string;
  planImageType?: TPlanImageType;
}

export function OfferingField<T extends FieldValues = FieldValues>({
  control,
  spec,
  planId,
  planImageType,
}: Readonly<OfferingFieldProps<T>>) {
  const span = SPAN_CLASS[spec.span ?? 6];

  // Composite fields own their own internal layout; they just need the cell.
  if (spec.kind === "languageLevel") {
    return (
      <div className={span}>
        <LanguageLevelFields control={control} gridCols={2} />
      </div>
    );
  }

  if (spec.kind === "price") {
    return (
      <div className={span}>
        <PriceField
          control={control}
          priceName={spec.name}
          currencyName={spec.currencyName ?? "priceCurrency"}
          label={spec.label}
          description={spec.description}
        />
      </div>
    );
  }

  if (spec.kind === "learningOutcomes") {
    return (
      <div className={span}>
        <LearningOutcomesField
          control={control}
          name={spec.name}
          label={spec.label}
          description={spec.description}
          maxItems={spec.maxItems}
        />
      </div>
    );
  }

  if (spec.kind === "stringList") {
    return (
      <div className={span}>
        <StringListField
          control={control}
          name={spec.name}
          label={spec.label}
          description={spec.description}
          itemNoun={spec.itemNoun}
          maxItems={spec.maxItems}
        />
      </div>
    );
  }

  return (
    <FormField
      control={control}
      name={spec.name as never}
      render={({ field }) => (
        <FormItem className={span}>
          {spec.label && <FormLabel>{spec.label}</FormLabel>}
          <FormControl>
            {renderControl(spec, field, planId, planImageType)}
          </FormControl>
          {spec.description && (
            <FormDescription>{spec.description}</FormDescription>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
