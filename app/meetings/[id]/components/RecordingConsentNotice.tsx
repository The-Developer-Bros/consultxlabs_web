"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";

type Decision = "GRANTED" | "DECLINED";
type Regime = "OPT_OUT" | "ACKNOWLEDGE";

interface Notice {
  required: boolean;
  regime: Regime;
  noticeVersion: number;
  decision: Decision | null;
}

export interface ConsentGate {
  /** False while we are still asking, or while a decision is outstanding. */
  satisfied: boolean;
  /**
   * True only for the fetch. `satisfied` is false in this window too, so the
   * Join button is disabled while `node` is still null — the caller needs to
   * tell that apart from a real outstanding decision, or the button sits dead
   * with nothing on screen accounting for it.
   */
  loading: boolean;
  node: React.ReactNode;
}

/**
 * #1134 P1-7 — the pre-join recording notice.
 *
 * Before this, a consultee's first sign that a session was being recorded was a
 * small `REC hh:mm` pill that appeared once recording had already started. No
 * notice, no way to refuse, no record that anyone had been told — on a product
 * whose 1:1 sessions are career and health conversations.
 *
 * Two regimes, because one wording cannot be honest for both:
 *
 *   OPT_OUT     1:1. Declining is real and costs nothing: they still join, and
 *               the host's recording endpoint refuses. Both buttons are equally
 *               weighted, because a nudge here is a dark pattern.
 *   ACKNOWLEDGE Group. The recording IS the product — attendees buy the replay
 *               and it was disclosed at purchase — so the only action is to
 *               understand it. Refusing means cancelling for a refund, which the
 *               copy says plainly rather than hiding.
 */
export function useRecordingConsent(meetingId: string): ConsentGate {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/meetings/${encodeURIComponent(meetingId)}/recording-consent`,
        );
        if (cancelled) return;
        if (!res.ok) {
          // Never trap someone in the lobby because the notice failed to load.
          // Recording itself is separately gated server-side, so failing open
          // here cannot cause an unconsented recording.
          setNotice({
            required: false,
            regime: "OPT_OUT",
            noticeVersion: 0,
            decision: null,
          });
          return;
        }
        // Second await, second check. `res.json()` is a fresh suspension point,
        // so a meetingId change between the header arriving and the body
        // parsing would land the OLD meeting's notice in state — and this
        // component decides whether the Join button unlocks.
        const body = (await res.json()) as Notice;
        if (cancelled) return;
        setNotice(body);
      } catch {
        if (!cancelled) {
          setNotice({
            required: false,
            regime: "OPT_OUT",
            noticeVersion: 0,
            decision: null,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const decide = useCallback(
    async (decision: Decision) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/meetings/${encodeURIComponent(meetingId)}/recording-consent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision }),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(
            typeof body?.error === "string"
              ? body.error
              : "Could not save your choice. Please try again.",
          );
          return;
        }
        setNotice((prev) => (prev ? { ...prev, decision } : prev));
      } catch {
        setError("Could not save your choice. Please try again.");
      } finally {
        setSaving(false);
      }
    },
    [meetingId],
  );

  // Still loading, or nothing to disclose: do not block, do not render.
  if (!notice) return { satisfied: false, loading: true, node: null };
  if (!notice.required) return { satisfied: true, loading: false, node: null };

  const isOptOut = notice.regime === "OPT_OUT";
  const answered = notice.decision !== null;

  return {
    satisfied: answered,
    loading: false,
    node: (
      <div
        className={cn(
          "rounded-xl border p-4",
          answered
            ? "border-border bg-muted/40"
            : "border-amber-500/40 bg-amber-500/10",
        )}
      >
        <div className="flex items-start gap-3">
          <Video
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              {isOptOut
                ? "This session may be recorded"
                : "This session is recorded"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {isOptOut
                ? "Your consultant may record this session for their notes. You can decline and still join — the recording simply will not be available to them."
                : "A recording is part of what attendees receive, and it will be shared with everyone enrolled. If you would rather not be recorded, cancel your booking for a refund instead of joining."}
            </p>

            {error && (
              <p role="alert" className="mt-2 text-xs text-red-500">
                {error}
              </p>
            )}

            {answered ? (
              <p className="mt-2 text-xs font-medium text-muted-foreground">
                {notice.decision === "GRANTED"
                  ? isOptOut
                    ? "You allowed recording. You can change this before joining."
                    : "Acknowledged."
                  : "You declined. Your consultant will not be able to record."}
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {isOptOut && (
                  // Equal visual weight with Allow, deliberately. Making the
                  // refusal quieter than the acceptance is how a consent prompt
                  // becomes a dark pattern.
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() => decide("DECLINED")}
                  >
                    Decline
                  </Button>
                )}
                <Button
                  type="button"
                  variant={isOptOut ? "outline" : "default"}
                  size="sm"
                  disabled={saving}
                  onClick={() => decide("GRANTED")}
                >
                  {saving && (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  )}
                  {isOptOut ? "Allow" : "I understand"}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    ),
  };
}
