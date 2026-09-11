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
import {
  X,
  Layers,
  Tag as TagIcon,
  Clock,
  DollarSign,
  Star,
  Building2,
  Globe,
} from "lucide-react";
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
    <div>
      <div className="grid gap-4 grid-cols-1">
        {/* Domain & Subdomain */}
        <div className="pb-4 border-b border-border last:border-b-0">
          <div className="flex items-center gap-2 mb-4">
            <Layers className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Category</span>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Domain
              </label>
              <Select
                value={selectedDomain || "all"}
                onValueChange={handleDomainChange}
              >
                <SelectTrigger className="w-full h-11 bg-muted border-border rounded-lg focus:ring-ring">
                  <SelectValue placeholder="All Domains" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Domains</SelectItem>
                  {metadata?.domains.map((domain) => (
                    <SelectItem key={domain.id} value={domain.id}>
                      {domain.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Subdomain
              </label>
              <Select
                disabled={!selectedDomain}
                value={selectedSubdomain || "all"}
                onValueChange={handleSubdomainChange}
              >
                <SelectTrigger className="w-full h-11 bg-muted border-border rounded-lg focus:ring-ring disabled:opacity-50">
                  <SelectValue
                    placeholder={
                      selectedDomain ? "All Subdomains" : "Select domain first"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Subdomains</SelectItem>
                  {metadata?.subdomains
                    .filter(
                      (subdomain) => subdomain.domainId === selectedDomain,
                    )
                    .map((subdomain) => (
                      <SelectItem key={subdomain.id} value={subdomain.id}>
                        {subdomain.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Tags */}
        <div className="pb-4 border-b border-border last:border-b-0">
          <div className="flex items-center gap-2 mb-4">
            <TagIcon className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">
              Skills & Tags
            </span>
          </div>
          <div>
            <label className="block mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Search Tags
            </label>
            <div className="relative" ref={tagDropdownRef}>
              <input
                className="w-full h-11 px-4 bg-muted border border-border text-foreground text-sm rounded-lg focus:ring-2 focus:ring-ring focus:border-transparent transition-all disabled:opacity-50"
                placeholder={
                  selectedDomain ? "Search skills..." : "Select domain first"
                }
                type="text"
                value={searchTerm}
                onChange={handleInputChange}
                onFocus={() => setIsDropdownOpen(true)}
                disabled={!selectedDomain}
              />
              {isDropdownOpen && filteredTags.length > 0 && (
                <div className="absolute z-20 w-full mt-2 bg-popover border border-border rounded-xl shadow-xl max-h-48 overflow-auto">
                  {filteredTags.map((tag) => (
                    <button
                      key={tag.id}
                      className="w-full px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted first:rounded-t-xl last:rounded-b-xl transition-colors"
                      onClick={() => handleTagSelect(tag.name)}
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selectedTags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {selectedTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground text-xs font-medium rounded-full"
                  >
                    {tag}
                    <button
                      className="hover:bg-white/20 rounded-full p-0.5 transition-colors"
                      onClick={() => handleTagRemove(tag)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Experience & Rating (combined) */}
        <div className="pb-4 border-b border-border last:border-b-0">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">
              Experience & Rating
            </span>
          </div>
          <div className="space-y-4">
            {/* Experience slider */}
            <div>
              <label className="block mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Minimum Years
              </label>
              <input
                type="range"
                min="0"
                max="30"
                value={localExperience}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setLocalExperience(val);
                  if (expDebounceRef.current)
                    clearTimeout(expDebounceRef.current);
                  expDebounceRef.current = setTimeout(() => {
                    updateFilters({ experience: val });
                  }, 300);
                }}
                className="w-full h-2 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
              />
              <div className="flex justify-between mt-1 text-xs text-muted-foreground">
                <span>0 yrs</span>
                <span className="font-semibold text-foreground">
                  {localExperience === 30 ? "30+" : localExperience} yrs
                </span>
                <span>30+</span>
              </div>
            </div>
            {/* Rating buttons */}
            <div>
              <label className="block mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Minimum Rating
              </label>
              <div className="flex flex-wrap gap-1.5">
                {RATING_OPTIONS.map((rating) => (
                  <button
                    key={rating}
                    onClick={() =>
                      updateFilters({
                        minRating: minRating === rating ? undefined : rating,
                      })
                    }
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      minRating === rating
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted border border-border text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    <Star className="w-3 h-3 fill-current" />
                    {rating}+
                  </button>
                ))}
                <button
                  onClick={() => updateFilters({ minRating: undefined })}
                  className={`inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    minRating === undefined
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted border border-border text-muted-foreground hover:bg-muted/80"
                  }`}
                >
                  Any
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Price Range — dual-thumb slider */}
        <div className="pb-4 border-b border-border last:border-b-0">
          <div className="flex items-center gap-2 mb-4">
            <DollarSign className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">
              Price Range
            </span>
          </div>
          <div>
            <div className="flex justify-between mb-3 text-sm font-medium text-muted-foreground">
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
              className="my-2"
            />
            <div className="flex justify-between mt-2 text-xs text-muted-foreground/70">
              <span>{formatPrice(0)}</span>
              <span>{formatPrice(MAX_PRICE_PAISE)}+</span>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground/70 leading-tight">
              Prices shown in {currency}. Final price may vary based on your
              region and payment method.
            </p>
          </div>
        </div>

        {/* Companies */}
        <div className="pb-4 border-b border-border last:border-b-0">
          <div className="flex items-center gap-2 mb-4">
            <Building2 className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Company</span>
          </div>
          <div>
            <label className="block mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Search Companies
            </label>
            <div className="relative" ref={companyDropdownRef}>
              <input
                className="w-full h-11 px-4 bg-muted border border-border text-foreground text-sm rounded-lg focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
                placeholder="e.g. Google, Deloitte..."
                type="text"
                value={companySearchTerm}
                onChange={handleCompanyInputChange}
                onFocus={() => setIsCompanyDropdownOpen(true)}
              />
              {isCompanyDropdownOpen && filteredCompanies.length > 0 && (
                <div className="absolute z-20 w-full mt-2 bg-popover border border-border rounded-xl shadow-xl max-h-48 overflow-auto">
                  {filteredCompanies.map((company) => (
                    <button
                      key={company}
                      className="w-full px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted first:rounded-t-xl last:rounded-b-xl transition-colors"
                      onClick={() => handleCompanySelect(company)}
                    >
                      {company}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selectedCompanies.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {selectedCompanies.map((company) => (
                  <span
                    key={company}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground text-xs font-medium rounded-full"
                  >
                    {company}
                    <button
                      className="hover:bg-white/20 rounded-full p-0.5 transition-colors"
                      onClick={() => handleCompanyRemove(company)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Language */}
        <div className="pb-4 border-b border-border last:border-b-0">
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Language</span>
          </div>
          <div>
            <label className="block mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Expert Language
            </label>
            <Select
              value={language || "all"}
              onValueChange={handleLanguageChange}
            >
              <SelectTrigger className="w-full h-11 bg-muted border-border rounded-lg focus:ring-ring">
                <SelectValue placeholder="Any Language" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any Language</SelectItem>
                {metadata?.availableLanguages?.map((lang) => (
                  <SelectItem key={lang} value={lang}>
                    {lang}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}

export const FilterPanel = memo(FilterPanelImpl);
