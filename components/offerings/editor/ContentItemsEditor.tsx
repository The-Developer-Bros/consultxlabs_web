"use client";

/**
 * The curriculum / roadmap builder.
 *
 * One component serves both, because `SubscriptionContentSchema` is literally
 * `ClassContentSchema` with the parent key swapped — yet the two dialogs built
 * separate editors, and the subscription one quietly lacked `outcomes` and a
 * resource URL. Sharing it is what stops that happening again.
 */

import * as React from "react";
import { useFieldArray, type Control, type FieldValues } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { StringListField } from "@/components/planner/components/form-fields/StringListField";
import { GripVertical, Plus, Trash2 } from "lucide-react";

interface ContentItemsEditorProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  /** `classContents` or `subscriptionContents`. */
  name: string;
  /** Shown in the empty state and the add button. */
  itemNoun: string;
}

export function ContentItemsEditor<T extends FieldValues = FieldValues>({
  control,
  name,
  itemNoun,
}: Readonly<ContentItemsEditorProps<T>>) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: name as never,
  });

  const addItem = () => {
    // Derived from the highest order in use, not the array length: `remove`
    // does not renumber the survivors, so after a removal the length collides
    // with an order already taken.
    const nextOrder =
      fields.reduce(
        (max, f) => Math.max(max, (f as { order?: number }).order ?? -1),
        -1,
      ) + 1;

    append({
      title: "",
      description: "",
      hoursAllotted: 1,
      outcomes: [],
      sectionLabel: "",
      contentType: "",
      contentUrl: "",
      // Persisted ordering, so reordering later is a data change rather than a
      // reliance on array position surviving a round-trip.
      order: nextOrder,
    } as never);
  };

  return (
    <div className="space-y-4">
      {fields.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No {itemNoun} yet. Add the first one to describe what each session
          covers.
        </p>
      )}

      {fields.map((field, index) => (
        <div key={field.id} className="rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <GripVertical className="h-4 w-4" />
              Session {index + 1}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove session ${index + 1}`}
              onClick={() => remove(index)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
            <FormField
              control={control}
              name={`${name}.${index}.title` as never}
              render={({ field: f }) => (
                <FormItem className="md:col-span-4">
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input {...f} value={f.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={control}
              name={`${name}.${index}.hoursAllotted` as never}
              render={({ field: f }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Hours</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min="0.5"
                      step="0.5"
                      {...f}
                      value={f.value ?? ""}
                      onChange={(e) =>
                        f.onChange(
                          e.target.value === ""
                            ? undefined
                            : Number.parseFloat(e.target.value),
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={control}
              name={`${name}.${index}.description` as never}
              render={({ field: f }) => (
                <FormItem className="md:col-span-6">
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea {...f} value={f.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={control}
              name={`${name}.${index}.sectionLabel` as never}
              render={({ field: f }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Section</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Module 1"
                      {...f}
                      value={f.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Both of these were missing from the subscription roadmap, so a
                subscription could not link a resource or state outcomes while
                an identical class session could. */}
            <FormField
              control={control}
              name={`${name}.${index}.contentType` as never}
              render={({ field: f }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Resource type</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Slides"
                      {...f}
                      value={f.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={control}
              name={`${name}.${index}.contentUrl` as never}
              render={({ field: f }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Resource URL</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="https://…"
                      {...f}
                      value={f.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="md:col-span-6">
              <StringListField
                control={control}
                name={`${name}.${index}.outcomes`}
                label="Session outcomes"
                itemNoun="outcomes"
                maxItems={6}
              />
            </div>
          </div>
        </div>
      ))}

      <Button type="button" variant="outline" onClick={addItem}>
        <Plus className="mr-2 h-4 w-4" />
        Add {itemNoun.replace(/s$/, "")}
      </Button>
    </div>
  );
}
