"use client";

import {
  Control,
  FieldPath,
  FieldValues,
  useController,
} from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { Plus, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import type { PlanFaqInput } from "@/types/planner-events";

/**
 * Question/answer editor for a plan's buyer-facing FAQ.
 *
 * `order` is derived from array position on every mutation rather than being
 * an editable field, so the list a consultant sees is the list a buyer gets.
 */
interface FaqEditorProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  name: string;
  maxItems?: number;
}

export function FaqEditor<T extends FieldValues = FieldValues>({
  control,
  name,
  maxItems = 20,
}: Readonly<FaqEditorProps<T>>) {
  const {
    field,
    fieldState: { error: fieldError },
  } = useController({
    name: name as FieldPath<T>,
    control,
    defaultValue: [] as T[string],
  });

  const faqs = (field.value as PlanFaqInput[]) || [];

  const commit = (next: PlanFaqInput[]) =>
    field.onChange(next.map((faq, index) => ({ ...faq, order: index })));

  const addFaq = () => {
    if (faqs.length >= maxItems) return;
    commit([...faqs, { question: "", answer: "", order: faqs.length }]);
  };

  const updateFaq = (
    index: number,
    key: "question" | "answer",
    value: string,
  ) => {
    const next = [...faqs];
    next[index] = { ...next[index], [key]: value };
    commit(next);
  };

  const removeFaq = (index: number) =>
    commit(faqs.filter((_, i) => i !== index));

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= faqs.length) return;
    const next = [...faqs];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  return (
    <FormItem>
      <FormLabel>Frequently asked questions</FormLabel>
      <FormDescription>
        Answer what buyers ask before booking — refunds, prerequisites,
        recordings, what happens if they miss a session.
      </FormDescription>

      <div className="space-y-4 mt-2">
        {faqs.map((faq, index) => (
          <div
            key={faq.id || `faq-${index}`}
            className="p-4 border rounded-lg bg-background"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-muted-foreground">
                Question {index + 1}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label="Move question up"
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground"
                  disabled={index === faqs.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label="Move question down"
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => removeFaq(index)}
                  aria-label="Remove question"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <Input
              placeholder="e.g., What happens if I miss a session?"
              value={faq.question}
              onChange={(e) => updateFaq(index, "question", e.target.value)}
            />
            <Textarea
              placeholder="Answer in a sentence or two."
              value={faq.answer}
              onChange={(e) => updateFaq(index, "answer", e.target.value)}
              className="mt-2 min-h-[70px] resize-none"
            />
          </div>
        ))}

        {faqs.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-md">
            No questions added yet
          </div>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addFaq}
          disabled={faqs.length >= maxItems}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add question
        </Button>
      </div>

      {fieldError && <FormMessage>{fieldError.message}</FormMessage>}
    </FormItem>
  );
}
