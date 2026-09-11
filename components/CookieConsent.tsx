"use client";

/**
 * Granular cookie consent (#381 / #1230 wave-6a).
 *
 * Replaces the old accept/decline-only wrapper. Essential cookies are
 * always on; analytics, marketing, and functional are individually
 * toggleable. Preferences persist to the CookiePreference table via
 * /api/cookie-preferences (which was read-but-never-written since MVP).
 */

import { useEffect, useState } from "react";
import CookieConsent from "react-cookie-consent";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface Prefs {
  analytics: boolean;
  marketing: boolean;
  functional: boolean;
}

const DEFAULTS: Prefs = {
  analytics: false,
  marketing: false,
  functional: false,
};

export default function CookieConsentBanner() {
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/cookie-preferences")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.analytics === "boolean") setPrefs(d);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const [saveError, setSaveError] = useState(false);

  const save = async (p: Prefs): Promise<boolean> => {
    try {
      const res = await fetch("/api/cookie-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  return (
    <CookieConsent
      location="bottom"
      buttonText="Accept all"
      declineButtonText="Essential only"
      enableDeclineButton
      cookieName="cookie_consent"
      style={{ background: "#18181b", fontSize: "13px" }}
      buttonStyle={{ background: "#7c3aed", color: "#fff", fontSize: "13px" }}
      declineButtonStyle={{ background: "#3f3f46", color: "#d4d4d8" }}
      expires={365}
      onAccept={() => void save({ analytics: true, marketing: true, functional: true })}
      onDecline={() => void save(DEFAULTS)}
      overlay={false}
    >
      <div className="space-y-2">
        <p>
          We use cookies to improve your experience. Essential cookies are
          always on.
        </p>
        {loaded && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              className="text-zinc-400 underline text-xs h-auto p-0"
              onClick={(e) => {
                e.preventDefault();
                setShowPrefs((v) => !v);
              }}
            >
              {showPrefs ? "Hide preferences" : "Customize preferences"}
            </Button>
            {showPrefs && (
              <div className="mt-2 space-y-2 text-left">
                {(
                  [
                    ["analytics", "Analytics", "Usage tracking (GA4, Hotjar)"],
                    ["marketing", "Marketing", "Ad pixels, retargeting"],
                    ["functional", "Functional", "Chat widgets, video embeds"],
                  ] as Array<[keyof Prefs, string, string]>
                ).map(([key, label, desc]) => (
                  <div key={key} className="flex items-center gap-2">
                    <Switch
                      id={`cc-${key}`}
                      checked={prefs[key]}
                      onCheckedChange={(v) =>
                        setPrefs((prev) => ({ ...prev, [key]: v }))
                      }
                    />
                    <Label htmlFor={`cc-${key}`} className="text-xs">
                      <span className="font-medium">{label}</span> — {desc}
                    </Label>
                  </div>
                ))}
                <Button
                  size="sm"
                  onClick={async () => {
                    const ok = await save(prefs);
                    if (ok) {
                      document.cookie = `cookie_consent=true; max-age=${365 * 24 * 3600}; path=/`;
                      window.location.reload();
                    } else {
                      setSaveError(true);
                    }
                  }}
                >
                  Save preferences
                </Button>
                {saveError && (
                  <p className="text-xs text-red-600">
                    Could not save — please try again.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </CookieConsent>
  );
}
