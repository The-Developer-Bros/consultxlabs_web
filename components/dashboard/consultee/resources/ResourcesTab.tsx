"use client";

import * as Sentry from "@sentry/nextjs";
import { useState, useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { motion } from "framer-motion";
import { ArrowUpDown, FolderOpen, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import {
  EventResourceCard,
  type EventResource,
  type ResourceArtifact,
} from "./EventResourceCard";

interface ResourcesData {
  consultations: EventResource[];
  subscriptions: EventResource[];
  webinars: EventResource[];
  classes: EventResource[];
  trials?: EventResource[];
}

interface ResourcesTabProps {
  data: ResourcesData | undefined;
  onRefresh?: () => void;
  /**
   * Which artifact this view is for. Documents and Recordings are separate
   * destinations now; the event-type tabs stay as GROUPING, because "which
   * session was this from" is the question people actually ask of a file.
   */
  artifact?: ResourceArtifact;
  title?: string;
  subtitle?: string;
}

const EVENT_TYPES = [
  { key: "consultations", label: "Consultations" },
  { key: "subscriptions", label: "Subscriptions" },
  { key: "webinars", label: "Webinars" },
  { key: "classes", label: "Classes" },
  { key: "trials", label: "Trials" },
] as const;

/**
 * `with_recordings` / `with_materials` only make sense on the combined view —
 * on the Documents page every event shown already has materials. The pages pass
 * an `artifact` and the control hides the redundant options itself.
 */
type FilterOption = "all" | "with_recordings" | "with_materials" | "completed";

function filterEvents(
  events: EventResource[],
  filter: FilterOption,
): EventResource[] {
  if (filter === "all") return events;
  return events.filter((e) => {
    if (filter === "with_recordings") return e.recordings.length > 0;
    if (filter === "with_materials") return e.materials.length > 0;
    return e.status === "COMPLETED";
  });
}

function sortEvents(
  events: EventResource[],
  dir: "desc" | "asc",
): EventResource[] {
  return [...events].sort((a, b) => {
    const diff = new Date(a.date).getTime() - new Date(b.date).getTime();
    return dir === "desc" ? -diff : diff;
  });
}

export function ResourcesTab({
  data,
  onRefresh,
  artifact = "both",
  title,
  subtitle,
}: ResourcesTabProps) {
  const { toast } = useToast();
  const [isSyncing, setIsSyncing] = useState(false);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [resourceFilter, setResourceFilter] = useState<FilterOption>("all");

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch("/api/stream/recordings/sync", {
        method: "POST",
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to sync recordings");
      }

      if (result.synced > 0) {
        toast({
          title: "Synced",
          description: `${result.synced} recording(s) synced from Stream.`,
        });
        onRefresh?.();
      } else {
        toast({
          title: "Up to date",
          description: "No new recordings found.",
        });
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "client" } });
      console.error("Error syncing recordings:", err);
      toast({
        title: "Error",
        description:
          err instanceof Error ? err.message : "Failed to sync recordings",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  /**
   * Events that actually carry the artifact this page is for.
   *
   * Gating the card's CONTENTS was not enough: totals, tab labels, the default
   * tab and the empty state all counted every event, so Documents listed
   * recording-only sessions as empty cards and claimed a count that did not
   * match what was on screen. The artifact has to narrow the set first, and
   * everything downstream reads the narrowed one.
   */
  const artifactData = useMemo(() => {
    if (!data) return null;
    const keep = (events: EventResource[]) => {
      if (artifact === "both") return events;
      return events.filter((e) =>
        artifact === "materials"
          ? e.materials.length > 0
          : e.recordings.length > 0,
      );
    };
    return {
      consultations: keep(data.consultations),
      subscriptions: keep(data.subscriptions),
      webinars: keep(data.webinars),
      classes: keep(data.classes),
      trials: keep(data.trials ?? []),
    };
  }, [data, artifact]);

  const filteredData = useMemo(() => {
    if (!artifactData) return null;
    const data = artifactData;
    return {
      consultations: sortEvents(
        filterEvents(data.consultations, resourceFilter),
        sortDir,
      ),
      subscriptions: sortEvents(
        filterEvents(data.subscriptions, resourceFilter),
        sortDir,
      ),
      webinars: sortEvents(
        filterEvents(data.webinars, resourceFilter),
        sortDir,
      ),
      classes: sortEvents(filterEvents(data.classes, resourceFilter), sortDir),
      trials: sortEvents(
        filterEvents(data.trials ?? [], resourceFilter),
        sortDir,
      ),
    };
  }, [artifactData, resourceFilter, sortDir]);

  if (!data || !artifactData || !filteredData) return null;

  const totalResources =
    artifactData.consultations.length +
    artifactData.subscriptions.length +
    artifactData.webinars.length +
    artifactData.classes.length +
    artifactData.trials.length;

  if (totalResources === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center min-h-[400px] p-8 bg-card rounded-xl shadow-sm"
      >
        <div className="w-16 h-16 mb-4 text-muted-foreground/70 flex items-center justify-center">
          <FolderOpen className="w-12 h-12" />
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">
          {artifact === "materials"
            ? "No documents yet"
            : artifact === "recordings"
              ? "No recordings yet"
              : "No resources yet"}
        </h3>
        <p className="text-muted-foreground text-center max-w-md">
          {artifact === "recordings"
            ? "Recordings appear here once a session you attended has been recorded and processed."
            : artifact === "materials"
              ? "Handouts and materials shared for your sessions will appear here."
              : "Resources from your enrolled consultations, subscriptions, webinars, and classes will appear here."}
        </p>
      </motion.div>
    );
  }

  const artifactNoun =
    artifact === "materials"
      ? "documents"
      : artifact === "recordings"
        ? "recordings"
        : "resources";

  const isFiltered = resourceFilter !== "all";

  // Find the first tab that has events (based on unfiltered data)
  const defaultTab =
    EVENT_TYPES.find(
      (t) => (artifactData[t.key as keyof ResourcesData] ?? []).length > 0,
    )?.key || "consultations";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <DashboardHeader
        title={title ?? "Resources"}
        subtitle={
          subtitle ?? "Materials and recordings from your enrolled events"
        }
        actions={
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSync}
                  disabled={isSyncing}
                >
                  <RefreshCw
                    className={`h-4 w-4 mr-2 ${isSyncing ? "animate-spin" : ""}`}
                  />
                  {isSyncing ? "Syncing..." : "Sync from Stream"}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Re-fetch latest recording links from Stream. Use this if a recent
                recording doesn&apos;t appear.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        }
      />

      {/* Filter + Sort controls */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          value={resourceFilter}
          onValueChange={(v) => setResourceFilter(v as FilterOption)}
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Filter resources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All {artifactNoun}</SelectItem>
            {/* Redundant on an artifact-specific page: every event shown on
                Documents already has materials, so "With materials" would
                filter nothing and "With recordings" would contradict the
                page. */}
            {artifact === "both" && (
              <>
                <SelectItem value="with_recordings">With recordings</SelectItem>
                <SelectItem value="with_materials">With materials</SelectItem>
              </>
            )}
            <SelectItem value="completed">Completed only</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
        >
          <ArrowUpDown className="h-4 w-4 mr-2" />
          {sortDir === "desc" ? "Newest first" : "Oldest first"}
        </Button>
      </div>

      <Tabs defaultValue={defaultTab} className="space-y-6">
        <TabsList>
          {EVENT_TYPES.map(({ key, label }) => {
            const total = (artifactData[key as keyof ResourcesData] ?? []).length;
            const filtered = (filteredData[key as keyof ResourcesData] ?? []).length;
            return (
              <TabsTrigger key={key} value={key} disabled={total === 0}>
                {label}
                {total > 0 && (
                  <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">
                    {isFiltered ? `${filtered}/${total}` : total}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {EVENT_TYPES.map(({ key }) => {
          const total = (data[key as keyof ResourcesData] ?? []).length;
          const items = filteredData[key as keyof ResourcesData] ?? [];
          return (
            <TabsContent key={key} value={key}>
              <div className="space-y-4">
                {items.length === 0 && total > 0 ? (
                  <p className="text-sm text-muted-foreground/70 text-center py-8">
                    No resources match the selected filter.
                  </p>
                ) : (
                  items.map((event) => (
                    <EventResourceCard
                    key={event.id}
                    event={event}
                    artifact={artifact}
                  />
                  ))
                )}
              </div>
            </TabsContent>
          );
        })}
      </Tabs>
    </motion.div>
  );
}
