"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, LayoutGrid, List, X } from "lucide-react";
import SegmentedControl from "@/app/explore/components/SegmentedControl";
import { TopicWithCount, ProgramFilters } from "@/lib/explore/programs";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { PlanLevel } from "@prisma/client";
import { memo, useEffect, useRef, useState } from "react";

interface AdvancedFiltersProps {
  filters: ProgramFilters;
  onFiltersChange: (filters: Partial<ProgramFilters>) => void;
  localSearch: string;
  onLocalSearchChange: (value: string) => void;
  selectedLevel: string;
  onLevelChange: (level: string) => void;
  uniqueLevels: PlanLevel[];
  viewMode: "grid" | "list";
  onViewModeChange: (mode: "grid" | "list") => void;
  topics: TopicWithCount[];
}

const PRICE_RANGES = [
  { label: "All Prices", value: "all" },
  { label: "Free", value: "0-0" },
  { label: "Under 500", value: "0-500" },
  { label: "500 - 2000", value: "500-2000" },
  { label: "2000 - 5000", value: "2000-5000" },
  { label: "5000+", value: "5000-" },
];

const VIEW_MODE_OPTIONS = [
  { value: "grid", label: "Grid", icon: LayoutGrid },
  { value: "list", label: "List", icon: List },
];

const SORT_OPTIONS = [
  { label: "Most Popular", value: "trending" },
  { label: "Newest", value: "newest" },
  { label: "Price: Low to High", value: "price-asc" },
  { label: "Price: High to Low", value: "price-desc" },
  { label: "Title: A to Z", value: "title-asc" },
  { label: "Title: Z to A", value: "title-desc" },
];

function AdvancedFiltersImpl({
  filters,
  onFiltersChange,
  localSearch,
  onLocalSearchChange,
  selectedLevel,
  onLevelChange,
  uniqueLevels,
  viewMode,
  onViewModeChange,
  topics,
}: AdvancedFiltersProps) {
  const [topicSearch, setTopicSearch] = useState("");
  const [topicDropdownOpen, setTopicDropdownOpen] = useState(false);
  const topicRef = useRef<HTMLDivElement>(null);

  // Close topic dropdown on outside click
  useEffect(() => {
    if (!topicDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (topicRef.current && !topicRef.current.contains(e.target as Node)) {
        setTopicDropdownOpen(false);
        setTopicSearch("");
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [topicDropdownOpen]);

  const currentPriceRange = (() => {
    if (filters.minPrice === undefined && filters.maxPrice === undefined)
      return "all";
    if (filters.minPrice === 0 && filters.maxPrice === 0) return "0-0";
    const min = filters.minPrice ?? 0;
    const max = filters.maxPrice;
    if (max === undefined) return `${min}-`;
    return `${min}-${max}`;
  })();

  const handlePriceChange = (value: string) => {
    if (value === "all") {
      onFiltersChange({ minPrice: undefined, maxPrice: undefined });
      return;
    }
    const [min, max] = value.split("-");
    onFiltersChange({
      minPrice: min ? parseInt(min) : undefined,
      maxPrice: max ? parseInt(max) : undefined,
    });
  };

  const handleTopicToggle = (topicId: string) => {
    const current = filters.topicIds || [];
    const updated = current.includes(topicId)
      ? current.filter((id) => id !== topicId)
      : [...current, topicId];
    onFiltersChange({ topicIds: updated.length > 0 ? updated : undefined });
    setTopicDropdownOpen(false);
    setTopicSearch("");
  };

  const filteredTopics = topics.filter(
    (t) =>
      t.name.toLowerCase().includes(topicSearch.toLowerCase()) &&
      !(filters.topicIds || []).includes(t.id),
  );

  const selectedTopicNames = (filters.topicIds || [])
    .map((id) => topics.find((t) => t.id === id)?.name)
    .filter(Boolean);

  return (
    <div className="rounded-2xl border border-border bg-card p-4 md:p-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {/* Topics multi-select */}
        <div className="relative" ref={topicRef}>
          <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Topics
          </Label>
          <div>
            <input
              type="text"
              placeholder={
                selectedTopicNames.length > 0
                  ? `${selectedTopicNames.length} selected`
                  : "Search topics…"
              }
              value={topicSearch}
              onChange={(e) => {
                setTopicSearch(e.target.value);
                setTopicDropdownOpen(true);
              }}
              onFocus={() => setTopicDropdownOpen(true)}
              className="h-10 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {topicDropdownOpen && filteredTopics.length > 0 && (
              <div className="absolute z-30 mt-1 max-h-48 w-full overflow-auto rounded-xl border border-border bg-popover shadow-elevation-2">
                {filteredTopics.map((topic) => (
                  <button
                    key={topic.id}
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-foreground transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted"
                    onClick={() => handleTopicToggle(topic.id)}
                  >
                    <span className="truncate">{topic.name}</span>
                    <span className="ml-2 shrink-0 text-xs tabular-nums text-muted-foreground">
                      {topic.programCount}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Price range */}
        <div>
          <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Price
          </Label>
          <Select value={currentPriceRange} onValueChange={handlePriceChange}>
            <SelectTrigger className="h-10 rounded-xl border-border bg-card">
              <SelectValue placeholder="All prices" />
            </SelectTrigger>
            <SelectContent>
              {PRICE_RANGES.map((range) => (
                <SelectItem key={range.value} value={range.value}>
                  {range.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Language */}
        <div>
          <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Language
          </Label>
          <Select
            value={filters.language || "all"}
            onValueChange={(v) =>
              onFiltersChange({ language: v === "all" ? undefined : v })
            }
          >
            <SelectTrigger className="h-10 rounded-xl border-border bg-card">
              <SelectValue placeholder="All languages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All languages</SelectItem>
              <SelectItem value="English">English</SelectItem>
              <SelectItem value="Hindi">Hindi</SelectItem>
              <SelectItem value="Spanish">Spanish</SelectItem>
              <SelectItem value="French">French</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Level */}
        <div>
          <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Level
          </Label>
          <Select value={selectedLevel} onValueChange={onLevelChange}>
            <SelectTrigger className="h-10 rounded-xl border-border bg-card">
              <SelectValue placeholder="All levels" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All levels</SelectItem>
              {uniqueLevels.map((level) => (
                <SelectItem key={level} value={level}>
                  {planLevelLabel(level)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Sort */}
        <div>
          <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Sort by
          </Label>
          <Select
            value={filters.sort || "none"}
            onValueChange={(v) =>
              onFiltersChange({ sort: v === "none" ? undefined : v })
            }
          >
            <SelectTrigger className="h-10 rounded-xl border-border bg-card">
              <SelectValue placeholder="Select sorting" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Default</SelectItem>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Search */}
        <div>
          <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Search
          </Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search programs…"
              value={localSearch}
              onChange={(e) => onLocalSearchChange(e.target.value)}
              className="h-10 rounded-xl border-border bg-card pl-9 text-sm"
            />
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {/* Selected topic chips */}
        <div className="flex flex-wrap gap-2">
          {(filters.topicIds || []).map((id) => {
            const topic = topics.find((t) => t.id === id);
            if (!topic) return null;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground"
              >
                <span className="text-foreground">{topic.name}</span>
                <button
                  type="button"
                  className="rounded-full p-0.5 transition-colors hover:text-foreground"
                  aria-label={`Remove ${topic.name} topic`}
                  onClick={() => handleTopicToggle(id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>

        <SegmentedControl
          value={viewMode}
          onChange={(value) => onViewModeChange(value as "grid" | "list")}
          options={VIEW_MODE_OPTIONS}
          ariaLabel="Results layout"
        />
      </div>
    </div>
  );
}

const AdvancedFilters = memo(AdvancedFiltersImpl);
export default AdvancedFilters;
