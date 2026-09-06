"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { memo, useState, useCallback, useRef, useEffect } from "react";
import { X, Star } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import type { IExpertFilters, IExpertsMetaData } from "../utils";

// Slider operates in paise (smallest currency unit) end-to-end so it
// matches both the API filter contract and `useCurrency().formatPrice`,
// which divides by 100 internally. Previous value `10_000` actually meant
// ₹100, which made the slider unable to filter to any realistic plan
// price (real plans are ₹2k–₹30k+). 5,000,000 paise = ₹50,000 covers the
// seed plan range with headroom; step is ₹500 so dragging feels snappy.
const MAX_PRICE_PAISE = 5_000_000;
const PRICE_STEP_PAISE = 50_000;

interface FilterPanelProps {
  metadata: IExpertsMetaData | null;
  filters: IExpertFilters;
  updateFilters: (partial: Partial<IExpertFilters>) => void;
}

/**
 * Renamed from FiltersSection. Accepts a single `filters` object plus
 * an `updateFilters(partial)` callback instead of 23 individual setters
 * with inconsistent naming. Internal local state for slider drag and
 * autocomplete dropdowns is unchanged.
 */
function FilterPanelImpl({
  metadata,
  filters,
  updateFilters,
}: FilterPanelProps) {
  const {
    domain: selectedDomain,
    subdomain: selectedSubdomain,
    tags: selectedTags,
    experience: experienceYears,
    minPrice,
    maxPrice,
    minRating,
    companies: selectedCompanies,
    language,
  } = filters;

  // Tag autocomplete state
  const [searchTerm, setSearchTerm] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const tagDropdownRef = useRef<HTMLDivElement>(null);

  // Company autocomplete state
  const [companySearchTerm, setCompanySearchTerm] = useState("");
  const [isCompanyDropdownOpen, setIsCompanyDropdownOpen] = useState(false);
  const companyDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        tagDropdownRef.current &&
        !tagDropdownRef.current.contains(e.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
      if (
        companyDropdownRef.current &&
        !companyDropdownRef.current.contains(e.target as Node)
      ) {
        setIsCompanyDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const { formatPrice, currency } = useCurrency();

  // Local slider state for smooth dragging without triggering API calls on every tick
  const [localRange, setLocalRange] = useState<[number, number]>([
    minPrice ?? 0,
    maxPrice ?? MAX_PRICE_PAISE,
  ]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local experience state with debounce
  const [localExperience, setLocalExperience] = useState(experienceYears);
  const expDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state when external props change (e.g. filter chip removal)
  useEffect(() => {
    setLocalRange([minPrice ?? 0, maxPrice ?? MAX_PRICE_PAISE]);
  }, [minPrice, maxPrice]);

  useEffect(() => {
    setLocalExperience(experienceYears);
  }, [experienceYears]);

  const handleSliderChange = useCallback(
    (value: number[]) => {
      const [newMin, newMax] = value as [number, number];
      setLocalRange([newMin, newMax]);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const isDefault = newMin === 0 && newMax === MAX_PRICE_PAISE;
        updateFilters({
          minPrice: isDefault ? undefined : newMin,
          maxPrice: isDefault ? undefined : newMax,
        });
      }, 300);
    },
    [updateFilters],
  );

  const handleDomainChange = (value: string) => {
    updateFilters({
      domain: value === "all" ? null : value,
      subdomain: null,
      tags: [],
    });
    setSearchTerm("");
  };

  const handleSubdomainChange = (value: string) => {
    updateFilters({ subdomain: value === "all" ? null : value });
  };

  const handleTagSelect = (tag: string) => {
    if (!selectedTags.includes(tag)) {
      updateFilters({ tags: [...selectedTags, tag] });
    }
    setIsDropdownOpen(false);
    setSearchTerm("");
  };

  const handleTagRemove = (tag: string) => {
    updateFilters({ tags: selectedTags.filter((t) => t !== tag) });
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
    setIsDropdownOpen(true);
  };

  const handleCompanySelect = (company: string) => {
    if (!selectedCompanies.includes(company)) {
      updateFilters({ companies: [...selectedCompanies, company] });
    }
    setIsCompanyDropdownOpen(false);
    setCompanySearchTerm("");
  };

  const handleCompanyRemove = (company: string) => {
    updateFilters({
      companies: selectedCompanies.filter((c) => c !== company),
    });
  };

  const handleCompanyInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCompanySearchTerm(e.target.value);
    setIsCompanyDropdownOpen(true);
  };

  const RATING_OPTIONS = [4.5, 4.0, 3.5, 3.0] as const;

  const handleLanguageChange = (value: string) => {
    updateFilters({ language: value === "all" ? undefined : value });
  };

  const filteredTags =
    metadata?.tags.filter((tag) => {
      if (selectedDomain && tag.domainId !== selectedDomain) return false;
      if (!searchTerm) return true;
      if (selectedTags.includes(tag.name)) return false;
      return tag.name.toLowerCase().includes(searchTerm.toLowerCase());
    }) || [];

  const filteredCompanies =
    metadata?.availableCompanies?.filter((company) => {
      if (selectedCompanies.includes(company)) return false;
      if (!companySearchTerm) return true;
      return company.toLowerCase().includes(companySearchTerm.toLowerCase());
    }) || [];

  // Renders inside FacetRail (sticky column on desktop, Sheet on mobile), so
  // this no longer draws its own card or header — the rail owns both — and the
  // facets stack in one column instead of the old three-across grid.
  return (
    <div className="space-y-6">
      {/* Domain */}
      <div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Domain
        </label>
        <Select
          value={selectedDomain || "all"}
          onValueChange={handleDomainChange}
        >
          <SelectTrigger className="h-10 w-full rounded-xl border-border bg-card">
            <SelectValue placeholder="All domains" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All domains</SelectItem>
            {metadata?.domains.map((domain) => (
              <SelectItem key={domain.id} value={domain.id}>
                {domain.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Subdomain */}
      <div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Subdomain
        </label>
        <Select
          disabled={!selectedDomain}
          value={selectedSubdomain || "all"}
          onValueChange={handleSubdomainChange}
        >
          <SelectTrigger className="h-10 w-full rounded-xl border-border bg-card disabled:opacity-50">
            <SelectValue
              placeholder={
                selectedDomain ? "All subdomains" : "Select a domain first"
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All subdomains</SelectItem>
            {metadata?.subdomains
              .filter((subdomain) => subdomain.domainId === selectedDomain)
              .map((subdomain) => (
                <SelectItem key={subdomain.id} value={subdomain.id}>
                  {subdomain.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      {/* Skills */}
      <div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Skills
        </label>
        <div className="relative" ref={tagDropdownRef}>
          <input
            className="h-10 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            placeholder={
              selectedDomain ? "Search skills…" : "Select a domain first"
            }
            type="text"
            value={searchTerm}
            onChange={handleInputChange}
            onFocus={() => setIsDropdownOpen(true)}
            disabled={!selectedDomain}
          />
          {isDropdownOpen && filteredTags.length > 0 && (
            <div className="absolute z-20 mt-2 max-h-48 w-full overflow-auto rounded-xl border border-border bg-popover shadow-elevation-2">
              {filteredTags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm text-foreground transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted"
                  onClick={() => handleTagSelect(tag.name)}
                >
                  {tag.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {selectedTags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {selectedTags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground"
              >
                <span className="text-foreground">{tag}</span>
                <button
                  type="button"
                  className="rounded-full p-0.5 transition-colors hover:text-foreground"
                  aria-label={`Remove ${tag} skill`}
                  onClick={() => handleTagRemove(tag)}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Experience */}
      <div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Minimum experience
        </label>
        <input
          type="range"
          min="0"
          max="30"
          aria-label="Minimum years of experience"
          value={localExperience}
          onChange={(e) => {
            const val = Number(e.target.value);
            setLocalExperience(val);
            if (expDebounceRef.current) clearTimeout(expDebounceRef.current);
            expDebounceRef.current = setTimeout(() => {
              updateFilters({ experience: val });
            }, 300);
          }}
          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />
        <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
          <span>0 yrs</span>
          <span className="font-medium tabular-nums text-foreground">
            {localExperience === 30 ? "30+" : localExperience} yrs
          </span>
          <span>30+</span>
        </div>
      </div>

      {/* Rating */}
      <div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Minimum rating
        </label>
        <div className="flex flex-wrap gap-1.5">
          {RATING_OPTIONS.map((rating) => (
            <button
              key={rating}
              type="button"
              onClick={() =>
                updateFilters({
                  minRating: minRating === rating ? undefined : rating,
                })
              }
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                minRating === rating
                  ? "border-transparent bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              <Star className="h-3 w-3 fill-current" />
              {rating}+
            </button>
          ))}
          <button
            type="button"
            onClick={() => updateFilters({ minRating: undefined })}
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              minRating === undefined
                ? "border-transparent bg-foreground text-background"
                : "border-border bg-background text-muted-foreground hover:text-foreground"
            }`}
          >
            Any
          </button>
        </div>
      </div>

      {/* Price — dual-thumb slider */}
      <div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Price
        </label>
        <div className="flex justify-between text-sm font-medium tabular-nums text-foreground">
          <span>{formatPrice(localRange[0])}</span>
          <span>
            {localRange[1] === MAX_PRICE_PAISE
              ? `${formatPrice(MAX_PRICE_PAISE)}+`
              : formatPrice(localRange[1])}
          </span>
        </div>
        <Slider
          defaultValue={[0, MAX_PRICE_PAISE]}
          value={localRange}
          min={0}
          max={MAX_PRICE_PAISE}
          step={PRICE_STEP_PAISE}
          onValueChange={handleSliderChange}
          className="my-3"
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Prices shown in {currency}. The final price may vary with your region
          and payment method.
        </p>
      </div>

      {/* Companies */}
      <div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Company
        </label>
        <div className="relative" ref={companyDropdownRef}>
          <input
            className="h-10 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="e.g. Google, Deloitte…"
            type="text"
            value={companySearchTerm}
            onChange={handleCompanyInputChange}
            onFocus={() => setIsCompanyDropdownOpen(true)}
          />
          {isCompanyDropdownOpen && filteredCompanies.length > 0 && (
            <div className="absolute z-20 mt-2 max-h-48 w-full overflow-auto rounded-xl border border-border bg-popover shadow-elevation-2">
              {filteredCompanies.map((company) => (
                <button
                  key={company}
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm text-foreground transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted"
                  onClick={() => handleCompanySelect(company)}
                >
                  {company}
                </button>
              ))}
            </div>
          )}
        </div>
        {selectedCompanies.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {selectedCompanies.map((company) => (
              <span
                key={company}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground"
              >
                <span className="text-foreground">{company}</span>
                <button
                  type="button"
                  className="rounded-full p-0.5 transition-colors hover:text-foreground"
                  aria-label={`Remove ${company} filter`}
                  onClick={() => handleCompanyRemove(company)}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Language */}
      <div>
        <label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Language
        </label>
        <Select value={language || "all"} onValueChange={handleLanguageChange}>
          <SelectTrigger className="h-10 w-full rounded-xl border-border bg-card">
            <SelectValue placeholder="Any language" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any language</SelectItem>
            {metadata?.availableLanguages?.map((lang) => (
              <SelectItem key={lang} value={lang}>
                {lang}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export const FilterPanel = memo(FilterPanelImpl);
