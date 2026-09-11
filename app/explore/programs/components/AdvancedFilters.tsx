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
import { Search, LayoutGrid, List, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <div className="bg-muted rounded-2xl p-6 border border-border">
      <div className="flex items-center gap-2 mb-6">
        <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
          <SlidersHorizontal className="w-5 h-5 text-primary-foreground" />
        </div>
        <div>
          <h3 className="font-semibold text-foreground">Filter Programs</h3>
          <p className="text-sm text-muted-foreground">
            Find the perfect program for you
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {/* Topics Multi-select */}
        <div className="relative" ref={topicRef}>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Topics
          </Label>
          <div>
            <input
              type="text"
              placeholder={
                selectedTopicNames.length > 0
                  ? `${selectedTopicNames.length} selected`
                  : "Search topics..."
              }
              value={topicSearch}
              onChange={(e) => {
                setTopicSearch(e.target.value);
                setTopicDropdownOpen(true);
              }}
              onFocus={() => setTopicDropdownOpen(true)}
              className="w-full h-11 px-3 bg-card border border-border text-foreground text-sm rounded-xl focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
            />
            {topicDropdownOpen && filteredTopics.length > 0 && (
              <div className="absolute z-30 w-full mt-1 bg-card border border-border rounded-xl shadow-xl max-h-48 overflow-auto">
                {filteredTopics.map((topic) => (
                  <button
                    key={topic.id}
                    className="w-full px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-muted first:rounded-t-xl last:rounded-b-xl transition-colors flex justify-between items-center"
                    onClick={() => handleTopicToggle(topic.id)}
                  >
                    <span>{topic.name}</span>
                    <span className="text-xs text-muted-foreground/70">
                      {topic.programCount}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Price Range */}
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Price
          </Label>
          <Select value={currentPriceRange} onValueChange={handlePriceChange}>
            <SelectTrigger className="h-11 bg-card border-border rounded-xl focus:ring-ring">
              <SelectValue placeholder="All Prices" />
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
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Language
          </Label>
          <Select
            value={filters.language || "all"}
            onValueChange={(v) =>
              onFiltersChange({ language: v === "all" ? undefined : v })
            }
          >
            <SelectTrigger className="h-11 bg-card border-border rounded-xl focus:ring-ring">
              <SelectValue placeholder="All Languages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Languages</SelectItem>
              <SelectItem value="English">English</SelectItem>
              <SelectItem value="Hindi">Hindi</SelectItem>
              <SelectItem value="Spanish">Spanish</SelectItem>
              <SelectItem value="French">French</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Level */}
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Level
          </Label>
          <Select value={selectedLevel} onValueChange={onLevelChange}>
            <SelectTrigger className="h-11 bg-card border-border rounded-xl focus:ring-ring">
              <SelectValue placeholder="All Levels" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
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
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Sort By
          </Label>
          <Select
            value={filters.sort || "none"}
            onValueChange={(v) =>
              onFiltersChange({ sort: v === "none" ? undefined : v })
            }
          >
            <SelectTrigger className="h-11 bg-card border-border rounded-xl focus:ring-ring">
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

        {/* Search + View Mode */}
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Search
          </Label>
          <div className="flex gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/70" />
              <Input
                type="text"
                placeholder="Search..."
                value={localSearch}
                onChange={(e) => onLocalSearchChange(e.target.value)}
                className="h-11 pl-10 bg-card border-border rounded-xl focus:ring-ring"
              />
            </div>
            <div className="flex gap-1">
              <Button
                variant={viewMode === "grid" ? "default" : "outline"}
                size="icon"
                className={`h-11 w-11 rounded-xl ${viewMode === "grid" ? "bg-primary hover:bg-primary/90" : "border-border"}`}
                onClick={() => onViewModeChange("grid")}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "list" ? "default" : "outline"}
                size="icon"
                className={`h-11 w-11 rounded-xl ${viewMode === "list" ? "bg-primary hover:bg-primary/90" : "border-border"}`}
                onClick={() => onViewModeChange("list")}
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Selected topic chips inline */}
      {selectedTopicNames.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-4">
          {(filters.topicIds || []).map((id) => {
            const topic = topics.find((t) => t.id === id);
            if (!topic) return null;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground text-xs font-medium rounded-full"
              >
                {topic.name}
                <button
                  className="hover:bg-primary-foreground/20 rounded-full p-0.5 transition-colors"
                  onClick={() => handleTopicToggle(id)}
                >
                  <span className="sr-only">Remove</span>×
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

const AdvancedFilters = memo(AdvancedFiltersImpl);
export default AdvancedFilters;
