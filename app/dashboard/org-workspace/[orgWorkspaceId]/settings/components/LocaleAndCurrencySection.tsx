"use client";

/**
 * Section: locale + currency display preferences.
 *
 * Picklists for common values + free-text input for "other" so operators
 * with unusual locales (e.g. fr-CA, ar-AE) aren't blocked. Server
 * validates the BCP-47 / ISO-4217 shape.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { patchSettings } from "../utils/api";
import { CURRENCY_PRESETS, LOCALE_PRESETS } from "../utils/options";

const CUSTOM_VALUE = "__custom__";

interface LocaleAndCurrencySectionProps {
  orgWorkspaceId: string;
  currentLocale: string | null;
  currentCurrency: string | null;
}

// Resolve the dropdown selection from a stored value: if the stored
// value matches a preset, the dropdown shows it; otherwise the
// dropdown reads "Custom…" and the override input carries the value.
function pickPreset(
  value: string | null,
  presets: ReadonlyArray<{ value: string }>,
): { selected: string; custom: string } {
  if (!value) return { selected: "", custom: "" };
  if (presets.some((p) => p.value === value)) {
    return { selected: value, custom: "" };
  }
  return { selected: CUSTOM_VALUE, custom: value };
}

export function LocaleAndCurrencySection({
  orgWorkspaceId,
  currentLocale,
  currentCurrency,
}: LocaleAndCurrencySectionProps) {
  const queryClient = useQueryClient();

  const initialLocale = pickPreset(currentLocale, LOCALE_PRESETS);
  const initialCurrency = pickPreset(currentCurrency, CURRENCY_PRESETS);

  const [localeSelect, setLocaleSelect] = useState(initialLocale.selected);
  const [localeCustom, setLocaleCustom] = useState(initialLocale.custom);
  const [currencySelect, setCurrencySelect] = useState(
    initialCurrency.selected,
  );
  const [currencyCustom, setCurrencyCustom] = useState(initialCurrency.custom);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const resolvedLocale =
    localeSelect === CUSTOM_VALUE ? localeCustom.trim() || null
      : localeSelect || null;
  const resolvedCurrency =
    currencySelect === CUSTOM_VALUE ? currencyCustom.trim().toUpperCase() || null
      : currencySelect || null;

  const dirty =
    resolvedLocale !== currentLocale || resolvedCurrency !== currentCurrency;

  const saveMutation = useMutation({
    mutationFn: () =>
      patchSettings(orgWorkspaceId, {
        locale: resolvedLocale,
        currencyDisplayCode: resolvedCurrency,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["org-workspace-settings", orgWorkspaceId],
      });
      setError(null);
      setSavedAt(new Date());
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Locale &amp; currency display</CardTitle>
        <CardDescription>
          Applies to the cross-org workspace shell only. Per-organisation
          pages render in the org’s own billing currency and regional
          defaults.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="locale-select">Locale</Label>
            <Select value={localeSelect} onValueChange={setLocaleSelect}>
              <SelectTrigger id="locale-select">
                <SelectValue placeholder="(use browser default)" />
              </SelectTrigger>
              <SelectContent>
                {LOCALE_PRESETS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_VALUE}>Custom…</SelectItem>
              </SelectContent>
            </Select>
            {localeSelect === CUSTOM_VALUE && (
              <Input
                placeholder="e.g. fr-CA"
                value={localeCustom}
                onChange={(e) => setLocaleCustom(e.target.value)}
              />
            )}
            <p className="text-xs text-zinc-500">
              BCP-47 tag. Drives number + date formatting.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="currency-select">Currency display</Label>
            <Select value={currencySelect} onValueChange={setCurrencySelect}>
              <SelectTrigger id="currency-select">
                <SelectValue placeholder="(use browser default)" />
              </SelectTrigger>
              <SelectContent>
                {CURRENCY_PRESETS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_VALUE}>Custom…</SelectItem>
              </SelectContent>
            </Select>
            {currencySelect === CUSTOM_VALUE && (
              <Input
                placeholder="e.g. AED"
                value={currencyCustom}
                onChange={(e) => setCurrencyCustom(e.target.value)}
                maxLength={3}
              />
            )}
            <p className="text-xs text-zinc-500">
              ISO 4217 code (3 uppercase letters).
            </p>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {savedAt && !dirty && !error && (
          <p className="text-xs text-green-700">
            Saved at {savedAt.toLocaleTimeString()}.
          </p>
        )}

        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-1" /> Save
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
