"use client";

import { Control, FieldValues } from "react-hook-form";
import { Input } from "@/components/ui/input";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { HelpCircle, Target } from "lucide-react";
import { FormSection } from "./FormSection";
import { StringListField } from "./StringListField";
import { FaqEditor } from "./FaqEditor";

/**
 * The buyer-facing positioning block, identical on all four plan types.
 *
 * Lives in one component so the copy, limits and ordering cannot drift between
 * the consultation, subscription, webinar and class forms — which is what
 * happened to the level/language fields before `LanguageLevelFields`.
 */
interface PositioningSectionsProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  /** Shown in the placeholder so the example fits the type being authored. */
  offeringNoun: string;
}

export function PositioningSections<T extends FieldValues = FieldValues>({
  control,
  offeringNoun,
}: Readonly<PositioningSectionsProps<T>>) {
  return (
    <>
      <FormSection
        title="Positioning"
        description="How buyers decide this is for them"
        icon={Target}
      >
        <FormField
          control={control}
          name={"subtitle" as never}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Subtitle</FormLabel>
              <FormDescription>
                One line under the title. This is the sentence that appears on
                cards and search results.
              </FormDescription>
              <FormControl>
                <Input
                  placeholder={`e.g., A hands-on ${offeringNoun} for engineers moving into their first lead role`}
                  maxLength={160}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <StringListField
          control={control}
          name="targetAudience"
          label="Who this is for"
          placeholder="e.g., Backend engineers with 3-6 years of experience"
          description="Be specific. Naming who it is NOT for is what makes the right buyer confident."
          itemNoun="audiences"
          maxItems={12}
        />

        <StringListField
          control={control}
          name="whatsIncluded"
          label="What's included"
          placeholder="e.g., Written feedback on every submission"
          description="Everything the price buys, beyond the sessions themselves."
          itemNoun="inclusions"
          maxItems={12}
        />
      </FormSection>

      <FormSection
        title="FAQ"
        description="Pre-empt the questions that stall a booking"
        icon={HelpCircle}
      >
        <FaqEditor control={control} name="faqs" />
      </FormSection>
    </>
  );
}
