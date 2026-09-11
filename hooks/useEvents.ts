import { useState, useEffect } from "react";
import { reportSentryError } from "@/lib/observability/report";
import { useToast } from "@/components/ui/use-toast";
import {
  TConsultation,
  TSubscription,
  TWebinar,
  TClass,
  TAppointment,
} from "@/types/appointment";

export type TConsultationWithPlan = TConsultation & {
  appointment: TAppointment | null;
};

export type TSubscriptionWithPlan = TSubscription & {
  appointments: TAppointment[];
};

export type TWebinarWithPlan = TWebinar & {
  appointment: TAppointment | null;
};

export type TClassWithPlan = TClass & {
  appointment: TAppointment[];
};

// Trial session type for consultee dashboard
export type TTrialWithPlan = {
  id: string;
  status: string;
  notes: string | null;
  requestedAt: string;
  completedAt: string | null;
  /** Live while AWAITING_PAYMENT; drives the "Pay Now to Confirm" affordance. */
  pendingPaymentUrl: string | null;
  /** Deadline for that pay-link — 24h from acceptance, or the session start. */
  paymentDueAt: string | null;
  subscriptionPlan: {
    id: string;
    title: string;
    trialDurationMinutes: number;
    trialPriceInPaise: number;
    consultantProfile: {
      id: string;
      user: {
        id: string;
        name: string;
        image: string | null;
        email: string;
      };
    };
  };
  appointment: TAppointment | null;
};

// --- Internal types ---

type TEventQueryMode =
  | { type: "consultee"; profileId: string }
  | { type: "consultant"; profileId: string }
  | { type: "user"; userId: string };

interface IEventsResult {
  consultations: TConsultationWithPlan[];
  subscriptions: TSubscriptionWithPlan[];
  webinars: TWebinarWithPlan[];
  classes: TClassWithPlan[];
  isLoading: boolean;
  error: Error | null;
}

// --- Single internal implementation ---

function useEventsInternal(mode: TEventQueryMode): IEventsResult {
  const [consultations, setConsultations] = useState<TConsultationWithPlan[]>(
    [],
  );
  const [subscriptions, setSubscriptions] = useState<TSubscriptionWithPlan[]>(
    [],
  );
  const [webinars, setWebinars] = useState<TWebinarWithPlan[]>([]);
  const [classes, setClasses] = useState<TClassWithPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { toast } = useToast();

  // Extract stable primitives for the effect dependency array
  const modeType = mode.type;
  const identifier = mode.type === "user" ? mode.userId : mode.profileId;

  useEffect(() => {
    if (!identifier) return;

    // Cancelled-flag teardown: every setState below is guarded so a fast
    // unmount / scope flip can't set state on a dead component, and a
    // superseded run can't clobber a newer run's results (stale-response
    // race — responses are now tagged to their own effect invocation).
    let cancelled = false;

    const fetchEvents = async () => {
      setIsLoading(true);
      setError(null);

      try {
        let queryParam: string;

        if (modeType === "user") {
          // Fetch user details first to determine role
          const response = await fetch(`/api/user/${identifier}`);
          if (!response.ok) {
            throw new Error("Failed to fetch user details");
          }
          const userData = await response.json();
          const userDetails = userData.data;

          if (!userDetails) {
            throw new Error("User details not found");
          }

          if (
            userDetails.role === "CONSULTANT" &&
            userDetails.consultantProfile?.id
          ) {
            queryParam = `consultantProfileId=${userDetails.consultantProfile.id}`;
          } else if (
            userDetails.role === "CONSULTEE" &&
            userDetails.consulteeProfile?.id
          ) {
            queryParam = `consulteeProfileId=${userDetails.consulteeProfile.id}`;
          } else {
            // If role or profile is not found, use empty arrays
            if (cancelled) return;
            setConsultations([]);
            setSubscriptions([]);
            setWebinars([]);
            setClasses([]);
            setIsLoading(false);
            return;
          }
        } else if (modeType === "consultant") {
          queryParam = `consultantProfileId=${identifier}`;
        } else {
          queryParam = `consulteeProfileId=${identifier}`;
        }

        const [consultationsRes, subscriptionsRes, webinarsRes, classesRes] =
          await Promise.all([
            fetch(`/api/bookings/consultations?${queryParam}`),
            fetch(`/api/bookings/subscriptions?${queryParam}`),
            fetch(`/api/bookings/webinars?${queryParam}`),
            fetch(`/api/bookings/classes?${queryParam}`),
          ]);

        if (
          !consultationsRes.ok ||
          !subscriptionsRes.ok ||
          !webinarsRes.ok ||
          !classesRes.ok
        ) {
          throw new Error("Failed to fetch events");
        }

        const consultationsData = await consultationsRes.json();
        const subscriptionsData = await subscriptionsRes.json();
        const webinarsData = await webinarsRes.json();
        const classesData = await classesRes.json();

        if (cancelled) return;
        setConsultations(consultationsData.data);
        setSubscriptions(subscriptionsData.data);
        setWebinars(webinarsData.data);
        setClasses(classesData.data);
      } catch (err: unknown) {
        console.error("Error fetching events:", err);
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Unknown error";
        const normalizedErr = err instanceof Error ? err : new Error(message);
        setError(normalizedErr);
        // Falls through to an empty-list render otherwise — indistinguishable
        // from "this consultee genuinely has no bookings" without this.
        reportSentryError(normalizedErr, { subsystem: "client" });
        toast({
          title: "Error fetching events",
          description: message,
          variant: "destructive",
        });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchEvents();

    return () => {
      cancelled = true;
    };
  }, [modeType, identifier, toast]);

  return { consultations, subscriptions, webinars, classes, isLoading, error };
}

// --- Public API (signatures unchanged) ---

/** Fetch events for a consultee profile */
export const useEvents = (consulteeProfileId: string) =>
  useEventsInternal({ type: "consultee", profileId: consulteeProfileId });

/** Fetch events for a consultee profile */
export const useEventsByConsultee = (consulteeProfileId: string) =>
  useEventsInternal({ type: "consultee", profileId: consulteeProfileId });

/** Fetch events for a consultant profile */
export const useEventsByConsultant = (consultantProfileId: string) =>
  useEventsInternal({ type: "consultant", profileId: consultantProfileId });

/** Fetch events for a user (auto-detects role) */
export const useEventsByUser = (userId: string) =>
  useEventsInternal({ type: "user", userId });
