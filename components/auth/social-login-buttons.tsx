"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { signIn } from "@/lib/auth-client";
import { AUTH_PROVIDERS } from "@/lib/auth-providers";
import { PROVIDER_ICONS } from "@/components/auth/auth-icons";
import { Building2 } from "lucide-react";

interface SocialLoginButtonsProps {
  callbackURL: string;
  newUserCallbackURL?: string;
  isLoading: boolean;
  ssoEnforced?: boolean;
  onSSOClick?: () => void;
  ssoChecking?: boolean;
}

/**
 * One neutral outline treatment for every third-party button.
 *
 * Previously each provider carried its own full-bleed fill (black GitHub,
 * red Google, blue Facebook). On the dark auth pages that made GitHub
 * near-invisible (black on neutral-950) while Google/Facebook outshouted the
 * primary email action — and the red fill violated Google's Sign-In branding
 * guidelines. Provider recognition now comes from the icon, so all buttons
 * share sizing, border, and hover. The `[&_svg]:size-5` override wins over the
 * base Button `[&_svg]:size-4` via tailwind-merge in `cn()`.
 */
const SOCIAL_BUTTON_CLASS =
  "h-11 w-full border border-white/15 bg-white/5 font-medium text-white hover:bg-white/10 hover:text-white [&_svg]:size-5";

export function SocialLoginButtons({
  callbackURL,
  newUserCallbackURL,
  isLoading,
  ssoEnforced,
  onSSOClick,
  ssoChecking,
}: SocialLoginButtonsProps) {
  const { toast } = useToast();

  if (ssoEnforced) return null;

  return (
    <div className="space-y-3">
      {AUTH_PROVIDERS.map((provider) => {
        const Icon = PROVIDER_ICONS[provider.id];
        return (
          <Button
            key={provider.id}
            type="button"
            aria-label={`Continue with ${provider.label}`}
            className={SOCIAL_BUTTON_CLASS}
            disabled={isLoading}
            onClick={() => {
              signIn.social({
                provider: provider.id,
                callbackURL,
                newUserCallbackURL: newUserCallbackURL || "/form/onboarding",
              });
              toast({
                title: `Signing in with ${provider.label}...`,
                description: "Please wait while we redirect you.",
              });
            }}
          >
            {/* Google's "G" carries its own official brand colors — never force
                text-white on it. GitHub/Facebook glyphs are monochrome strokes
                that inherit the button's white. */}
            {Icon && (
              <Icon
                aria-hidden
                className={
                  provider.id === "google" ? "shrink-0" : "shrink-0 text-white"
                }
              />
            )}
            Continue with {provider.label}
          </Button>
        );
      })}
      {onSSOClick && (
        <Button
          type="button"
          aria-label="Sign in with Corporate SSO"
          className={SOCIAL_BUTTON_CLASS}
          disabled={isLoading || ssoChecking}
          onClick={onSSOClick}
        >
          <Building2 aria-hidden className="shrink-0 text-white" />
          {ssoChecking ? "Checking…" : "Sign in with Corporate SSO"}
        </Button>
      )}
    </div>
  );
}
