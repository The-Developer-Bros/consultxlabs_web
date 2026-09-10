"use client";

/**
 * The offering editor shell.
 *
 * Replaces four hand-built modals (3,890 lines) whose height had already
 * outgrown a dialog — every one of them carried
 * `max-h-[90dvh] overflow-hidden flex flex-col`, which is a page admitting it
 * is a page. A route-based editor also gives an offering a stable URL to return
 * to, which is what makes saving a draft mean anything.
 *
 * Layout is not decided here per type: the manifest lists sections, this walks
 * them, and `OfferingField` renders every field into one shared 6-column grid.
 */

import * as React from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { cn } from "@/utils/tailwind";
import type { TPlanImageType } from "@/lib/supabase";
import { FormSection } from "@/components/planner/components/form-fields/FormSection";
import { OfferingField } from "./OfferingFields";
import type { OfferingManifest } from "./manifest";

export interface OfferingEditorProps<T extends FieldValues = FieldValues> {
  manifest: OfferingManifest;
  form: UseFormReturn<T>;
  /**
   * Sections the manifest marks with a `slot` — the FAQ editor, the curriculum
   * builder, the sessions calendar. Anything genuinely bespoke lives here
   * rather than being forced into a field kind.
   */
  slots?: Record<string, React.ReactNode>;
  /** Absent while creating: there is no offering to attach an image to yet. */
  planId?: string;
  planImageType?: TPlanImageType;
  /** Null while creating. DRAFT offerings are not buyable and not discoverable. */
  status?: "DRAFT" | "PUBLISHED" | null;
  /**
   * Which action is in flight. Per-action rather than one `isSaving`, so the
   * button the user pressed is the only one that reacts — a spinner on Publish
   * after pressing Save draft is a lie about what is happening.
   */
  savingAction?: "draft" | "publish" | null;
  /**
   * Why publishing is blocked, if it is — e.g. a webinar with no session. The
   * reason is shown next to the disabled button, because a disabled control
   * with no explanation is the thing people file bugs about.
   */
  publishBlockedReason?: string | null;
  /**
   * Fields only publishing requires. The draft path ignores validation errors
   * confined to these: an offering that cannot be saved until it is publishable
   * is not a draft.
   */
  publishOnlyFields?: readonly string[];
  onSaveDraft: (values: T) => void | Promise<void>;
  onPublish: (values: T) => void | Promise<void>;
  onCancel?: () => void;
}

export function OfferingEditor<T extends FieldValues = FieldValues>({
  manifest,
  form,
  slots,
  planId,
  planImageType,
  status = null,
  savingAction = null,
  publishBlockedReason = null,
  publishOnlyFields,
  onSaveDraft,
  onPublish,
  onCancel,
}: Readonly<OfferingEditorProps<T>>) {
  const [activeSection, setActiveSection] = React.useState(
    manifest.sections[0]?.id,
  );

  const isSaving = savingAction !== null;

  const scrollTo = (id: string) => {
    setActiveSection(id);
    document
      .getElementById(`offering-section-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Keep the section tab in sync with whichever block is in view — otherwise
  // a wheel-scroll leaves the highlight on the tab the user last clicked.
  // Root is <main>: that is the dashboard scrollport (see PersonalDashboardShell).
  React.useEffect(() => {
    const nodes = manifest.sections
      .map((section) =>
        document.getElementById(`offering-section-${section.id}`),
      )
      .filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) return;

    const root = document.querySelector("main");
    const observer = new IntersectionObserver(
      (entries) => {
        // The topmost intersecting section wins; entries arrive unordered.
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.id.replace(/^offering-section-/, "");
        if (id) setActiveSection(id);
      },
      // Bias toward the band just under the sticky section nav.
      { root, rootMargin: "-20% 0px -55% 0px", threshold: 0 },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [manifest.sections]);

  // Publishing validates in full; a draft only has to clear the errors that are
  // not publish-only, so partial work can still be parked.
  const submitDraft = form.handleSubmit(
    (values) => onSaveDraft(values),
    (errors) => {
      const blocking = Object.keys(errors).filter(
        (name) => !publishOnlyFields?.includes(name),
      );
      if (blocking.length === 0) void onSaveDraft(form.getValues());
    },
  );

  return (
    <Form {...form}>
      {/*
        No bottom padding: the save bar below is mt-auto inside this flex
        column (see its comment), so trailing padding would only reopen dead
        run-out under it (DashboardContent's py-6 already leaves the small
        breathing gap).
      */}
      <form
        className="flex flex-1 flex-col"
        onSubmit={(e) => {
          // Both actions are explicit footer buttons; a stray Enter must not
          // publish an offering.
          e.preventDefault();
        }}
      >
        {/*
          Second navbar (Basics / Pricing / …): sticky to the top of <main>
          under the dashboard context bar. Solid background — translucent
          backdrop-blur let section content bleed through while scrolling.
        */}
        <div className="sticky top-0 z-20 mb-6 border-b bg-background pb-3 pt-1">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold capitalize">
              {planId ? "Edit" : "New"} {manifest.noun}
            </h1>
            {status === "DRAFT" && <Badge variant="outline">Draft</Badge>}
            {status === "PUBLISHED" && <Badge>Published</Badge>}
          </div>

          <nav aria-label="Offering sections" className="flex flex-wrap gap-2">
            {manifest.sections.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => scrollTo(section.id)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  activeSection === section.id
                    ? "bg-secondary font-medium text-secondary-foreground"
                    : "text-muted-foreground hover:bg-secondary/50",
                )}
              >
                {section.title}
              </button>
            ))}
          </nav>
        </div>

        {/* pb-8 keeps the standing gap above the save bar: the bar's mt-auto
            collapses to 0 once the form is taller than <main>, so the spacer
            lives here rather than on the bar. */}
        <div className="space-y-8 pb-8">
          {manifest.sections.map((section) => (
            <div
              key={section.id}
              id={`offering-section-${section.id}`}
              // Clear the sticky title+tabs band so scrollIntoView / deep links
              // don't land the heading under the chrome.
              className="scroll-mt-36"
            >
              <FormSection
                title={section.title}
                description={section.description}
                icon={section.icon}
              >
                {section.slot ? (
                  (slots?.[section.slot] ?? (
                    <p className="text-sm text-muted-foreground">
                      Nothing to configure here yet.
                    </p>
                  ))
                ) : (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
                    {section.fields.map((spec) => (
                      <OfferingField
                        key={spec.name}
                        control={form.control}
                        spec={spec}
                        planId={planId}
                        planImageType={planImageType}
                      />
                    ))}
                  </div>
                )}
              </FormSection>
            </div>
          ))}
        </div>

        {/*
          Sticky to <main> (the dashboard scrollport) rather than the viewport:
          a fixed bar drew itself under the sidebar (needing md:left-64) and
          forced a giant compensating pb-24 on the form, which is what let the
          page scroll into dead space past its content. As the form's last
          child it naturally clears the sidebar and every shell chrome.
          mt-auto is the other half: the form is a flex column stretched to
          <main>'s full height, so on a short form (tall monitor, edit page)
          the bar pins to the bottom edge instead of floating mid-air right
          after the last section; on a long form mt-auto collapses to 0 and
          plain sticky takes over.
          REQUIRES the page's <DashboardContent> to carry `content-flush-bottom`
          (see globals.css): without it, the stacked chrome paddings below this
          bar leave a ~40-56px float above the true bottom edge.
        */}
        <div className="sticky bottom-0 z-10 mt-auto border-t bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-end gap-3 px-4 py-3">
            {publishBlockedReason && (
              <p className="mr-auto text-sm text-muted-foreground">
                {publishBlockedReason}
              </p>
            )}
            {onCancel && (
              <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                disabled={isSaving}
              >
                Cancel
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={submitDraft}
            >
              {savingAction === "draft" && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save draft
            </Button>
            <Button
              type="button"
              disabled={isSaving || !!publishBlockedReason}
              onClick={form.handleSubmit(onPublish)}
            >
              {savingAction === "publish" && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {status === "PUBLISHED" ? "Save changes" : "Publish"}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}
