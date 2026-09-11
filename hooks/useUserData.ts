"use client";

import { useState, useEffect } from "react";
import { reportSentryError } from "@/lib/observability/report";
import { useToast } from "@/components/ui/use-toast";
import { User } from "@prisma/client";
import { fetchUserDetails } from "@/lib/user";

/**
 * The signed-in user's core record, for the Stream connect.
 *
 * Deliberately narrow. This hook gates the chat socket — `StreamProviderImpl`
 * will not connect until `isLoading` clears — so every fetch added here is
 * time the Messages tab spends on a skeleton. It fetches one thing.
 *
 * `fetchConsultantDetails`, `fetchConsulteeDetails`, `fetchStaffDetails` and
 * `fetchReviews` all still live in `@/lib/user` for callers that genuinely
 * need them; they simply have no business on this path.
 */
export const useUserData = (userId: string) => {
  const [userDetails, setUserDetails] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    // Cancelled-flag teardown: userId can flip (e.g. dev-only test-user
    // fallback resolving to the real session id) and the component can
    // unmount mid-flight — neither may set state afterwards.
    let cancelled = false;

    const fetchUserInfo = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const userData = await fetchUserDetails(userId);
        if (cancelled) return;
        setUserDetails(userData);

        // The per-role profile fetches that used to follow are gone.
        //
        // This hook has exactly one consumer — `providers/StreamProviderImpl`
        // — and it destructures `{ userDetails, isLoading }` only. The
        // `profileDetails` and `reviews` it also returned were read by nobody,
        // yet a CONSULTANT paid for them SERIALLY (consultant details, then
        // reviews) before `isLoading` cleared, and the Stream connect is hard-
        // gated on `isLoading`. Two round-trips to a cold serverless function
        // and a remote database, on the critical path to the chat socket, for
        // data that was discarded on arrival — which is most of why the
        // Messages tab sat on a skeleton.
        //
        // The connect reads `id`, `name`, `image` and `role`, all of which come
        // from `fetchUserDetails` above. If a future caller needs the profile,
        // fetch it where it is used rather than reinstating it here: this hook
        // gates a socket, so anything added to it delays chat for everyone.
      } catch (err: unknown) {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        // 401 is expected after sign-out (session cleared before component unmounts)
        if (
          err !== null &&
          err !== undefined &&
          typeof err === "object" &&
          "status" in err &&
          (err as { status: number }).status === 401
        )
          return;
        reportSentryError(error, { subsystem: "client" });
        console.error("Error fetching user details:", err);
        toast({
          title: "Error fetching user details",
          description: error.message,
          variant: "destructive",
        });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    if (userId) {
      fetchUserInfo();
    }

    return () => {
      cancelled = true;
    };
  }, [userId, toast]);

  return { userDetails, isLoading, error };
};
