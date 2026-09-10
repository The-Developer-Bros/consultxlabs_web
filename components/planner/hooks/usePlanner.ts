"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ConsultationPlan, SubscriptionPlan } from "@/schemas/plans";

// Types for mutation inputs
type ConsultationPlanInput =
  | (Partial<ConsultationPlan> & {
      consultantProfileId?: string;
    })
  | undefined;

type ConsultationPlanUpdateInput = {
  id: string;
  [key: string]: unknown;
};

type SubscriptionPlanInput =
  | (Partial<SubscriptionPlan> & {
      consultantProfileId?: string;
    })
  | undefined;

type SubscriptionPlanUpdateInput = {
  id: string;
  [key: string]: unknown;
};

type ArchivePlanInput = { id: string; archived: boolean };

// Shared by every plan family's archive/restore toggle (#1494) so the four
// PATCH callers can't drift in error handling or content-type.
async function patchPlanArchived(
  basePath: string,
  { id, archived }: ArchivePlanInput,
  fallbackErrorMessage: string,
) {
  const response = await fetch(`${basePath}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (!response.ok) {
    // A 502 HTML page or an empty 401 has no JSON body to read; without this
    // the thrown SyntaxError replaces the message meant for the consultant.
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.error || fallbackErrorMessage);
  }
  return response.json();
}

// The planner READ lives in createConsultantQueries(...).planner
// (queryKey ["consultant-planner", consultantId, scopeKey]) — the mutation
// hooks below invalidate that key by prefix. A previous local usePlanner()
// hook with its own ["planner", ...] key was queried by nobody while every
// mutation invalidated it, so planner mutations never refreshed the page.

// Webinar mutation hooks
export function useWebinarMutations(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const deleteWebinar = useMutation({
    mutationFn: async (webinarId: string) => {
      // FIX #622: Use the guarded route that checks for active payments
      // and upcoming slots before allowing deletion.
      const response = await fetch(
        `/api/bookings/webinars/${webinarId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete webinar");
      }

      return response.json();
    },
    onSuccess: (result) => {
      // Invalidate and refetch planner data
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: "Success",
        description: result.message || "Webinar deleted successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete webinar.",
        variant: "destructive",
      });
    },
  });

  return { deleteWebinar };
}

// Class mutation hooks
export function useClassMutations(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const deleteClass = useMutation({
    mutationFn: async (classId: string) => {
      // FIX #622: Use the guarded route that checks for active payments
      // and upcoming slots before allowing deletion.
      const response = await fetch(
        `/api/bookings/classes/${classId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete class");
      }

      return response.json();
    },
    onSuccess: (result) => {
      // Invalidate and refetch planner data
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: "Success",
        description: result.message || "Class deleted successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete class.",
        variant: "destructive",
      });
    },
  });

  return { deleteClass };
}

// Consultation plan hooks
export function useConsultationPlans(
  consultantId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["consultationPlans", consultantId],
    queryFn: async () => {
      const response = await fetch(
        `/api/plans/consultations?consultantId=${consultantId}`,
      );
      if (!response.ok) {
        throw new Error("Failed to fetch consultation plans");
      }
      const data = await response.json();
      return data.data;
    },
    enabled: options?.enabled ?? true,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 2,
  });
}

export function useConsultationPlanMutations(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createConsultationPlan = useMutation({
    mutationFn: async (planData: ConsultationPlanInput) => {
      const response = await fetch("/api/plans/consultations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...planData,
          consultantProfileId: consultantId,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to create consultation plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["consultationPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: "Success",
        description: "Consultation plan created successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateConsultationPlan = useMutation({
    mutationFn: async ({ id, ...planData }: ConsultationPlanUpdateInput) => {
      const response = await fetch(`/api/plans/consultations/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planData),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to update consultation plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["consultationPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: "Success",
        description: "Consultation plan updated successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteConsultationPlan = useMutation({
    mutationFn: async (planId: string) => {
      const response = await fetch(`/api/plans/consultations/${planId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to delete consultation plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["consultationPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: "Success",
        description: "Consultation plan deleted successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const archiveConsultationPlan = useMutation({
    mutationFn: (input: ArchivePlanInput) =>
      patchPlanArchived(
        "/api/plans/consultations",
        input,
        "Failed to update consultation plan",
      ),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["consultationPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: variables.archived ? "Offering archived" : "Offering restored",
        description:
          result.message ??
          (variables.archived
            ? "This plan stopped taking new bookings. Existing appointments are unaffected."
            : "This plan is back on sale."),
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return {
    createConsultationPlan,
    updateConsultationPlan,
    deleteConsultationPlan,
    archiveConsultationPlan,
  };
}

// Subscription plan hooks
export function useSubscriptionPlans(
  consultantId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["subscriptionPlans", consultantId],
    queryFn: async () => {
      const response = await fetch(
        `/api/plans/subscriptions?consultantId=${consultantId}`,
      );
      if (!response.ok) {
        throw new Error("Failed to fetch subscription plans");
      }
      const data = await response.json();
      return data.data;
    },
    enabled: options?.enabled ?? true,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 2,
  });
}

export function useSubscriptionPlanMutations(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createSubscriptionPlan = useMutation({
    mutationFn: async (planData: SubscriptionPlanInput) => {
      const response = await fetch("/api/plans/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...planData,
          consultantProfileId: consultantId,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to create subscription plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["subscriptionPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: "Success",
        description: "Subscription plan created successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateSubscriptionPlan = useMutation({
    mutationFn: async ({ id, ...planData }: SubscriptionPlanUpdateInput) => {
      const response = await fetch(`/api/plans/subscriptions/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planData),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to update subscription plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["subscriptionPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: "Success",
        description: "Subscription plan updated successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteSubscriptionPlan = useMutation({
    mutationFn: async (planId: string) => {
      const response = await fetch(`/api/plans/subscriptions/${planId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to delete subscription plan",
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["subscriptionPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: "Success",
        description: "Subscription plan deleted successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const archiveSubscriptionPlan = useMutation({
    mutationFn: (input: ArchivePlanInput) =>
      patchPlanArchived(
        "/api/plans/subscriptions",
        input,
        "Failed to update subscription plan",
      ),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["subscriptionPlans", consultantId],
      });
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: variables.archived ? "Offering archived" : "Offering restored",
        description:
          result.message ??
          (variables.archived
            ? "This plan stopped taking new bookings. Existing appointments are unaffected."
            : "This plan is back on sale."),
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return {
    createSubscriptionPlan,
    updateSubscriptionPlan,
    deleteSubscriptionPlan,
    archiveSubscriptionPlan,
  };
}

/**
 * Archive/restore for webinar and class PLANS (#1494) — distinct from
 * useWebinarMutations/useClassMutations above, which delete a live SESSION
 * instance. The plan is the sellable offering; a consultant retires it here
 * without touching crud-with-plan's create/reschedule transaction.
 */
export function useWebinarPlanMutations(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const archiveWebinarPlan = useMutation({
    mutationFn: (input: ArchivePlanInput) =>
      patchPlanArchived(
        "/api/plans/webinars",
        input,
        "Failed to update webinar plan",
      ),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: variables.archived ? "Offering archived" : "Offering restored",
        description:
          result.message ??
          (variables.archived
            ? "This webinar stopped taking new bookings. Existing appointments are unaffected."
            : "This webinar is back on sale."),
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return { archiveWebinarPlan };
}

export function useClassPlanMutations(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const archiveClassPlan = useMutation({
    mutationFn: (input: ArchivePlanInput) =>
      patchPlanArchived(
        "/api/plans/classes",
        input,
        "Failed to update class plan",
      ),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
      toast({
        title: variables.archived ? "Offering archived" : "Offering restored",
        description:
          result.message ??
          (variables.archived
            ? "This class stopped taking new bookings. Existing appointments are unaffected."
            : "This class is back on sale."),
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return { archiveClassPlan };
}

// Hook for refetching planner data (useful after saves)
export function usePlannerRefresh(consultantId: string) {
  const queryClient = useQueryClient();

  const refreshPlanner = () => {
    queryClient.invalidateQueries({ queryKey: ["consultant-planner", consultantId] });
    queryClient.invalidateQueries({
      queryKey: ["consultationPlans", consultantId],
    });
    queryClient.invalidateQueries({
      queryKey: ["subscriptionPlans", consultantId],
    });
  };

  return { refreshPlanner };
}
