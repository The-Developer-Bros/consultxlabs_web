"use client";

import {
  Feedback,
  SupportPriority,
  SupportIssueType,
  SupportTicket,
  SupportResponse as PrismaSupportResponse,
  UserRole,
} from "@prisma/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { describeSupportError } from "@/lib/support/error-copy";
import React from "react";
import { createConsulteeQueries } from "@/lib/dashboard-queries";

interface FeedbackFormData {
  title: string;
  description: string;
  rating?: number;
  category?: string;
}

interface SupportTicketFormData {
  title: string;
  description: string;
  priority: SupportPriority;
  issueType?: SupportIssueType;
  category?: string;
}

interface SupportResponseFormData {
  message: string;
}

interface EnrichedSupportTicketResponse extends PrismaSupportResponse {
  user: {
    name: string | null;
    role: UserRole | null;
  } | null;
}

export interface SupportTicketWithResponses extends SupportTicket {
  responses: EnrichedSupportTicketResponse[];
}

export function useFeedbackSupport(scopeId: string) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = React.useState(false);
  const [selectedTicket, setSelectedTicket] = React.useState<string | null>(
    null,
  );

  // Same query configs the feedback page prefetches — the page's fetch IS
  // this hook's data (previously the hook re-fetched both endpoints via
  // useEffect, doubling every page load's network calls).
  const consulteeQueries = createConsulteeQueries(scopeId);
  const { data: feedbacksData } = useQuery(consulteeQueries.feedback);
  const { data: ticketsData } = useQuery(consulteeQueries.supportTickets);
  const feedbacks = (feedbacksData ?? []) as unknown as Feedback[];
  const tickets = (ticketsData ?? []) as unknown as SupportTicketWithResponses[];

  const invalidateFeedbacks = () =>
    queryClient.invalidateQueries({
      queryKey: consulteeQueries.feedback.queryKey,
    });
  const invalidateTickets = () =>
    queryClient.invalidateQueries({
      queryKey: consulteeQueries.supportTickets.queryKey,
    });

  const [feedbackForm, setFeedbackForm] = React.useState<FeedbackFormData>({
    title: "",
    description: "",
  });

  const [ticketForm, setTicketForm] = React.useState<SupportTicketFormData>({
    title: "",
    description: "",
    priority: SupportPriority.LOW,
  });

  const [responseForm, setResponseForm] =
    React.useState<SupportResponseFormData>({
      message: "",
    });

  const handleFeedbackSubmit = async () => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/user/feedbacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedbackForm),
      });

      if (!response.ok) {
        // Envelope-aware: prefer the coded copy, fall back to the server's
        // user-safe `error` (the old `errorData.message` field never existed).
        const payload = await response.json().catch(() => ({}));
        throw new Error(describeSupportError(payload, "Failed to submit your feedback"));
      }

      toast({
        title: "Feedback submitted",
        description:
          "Thank you for your feedback! Our team will review it shortly.",
      });

      setFeedbackForm({ title: "", description: "" });
      void invalidateFeedbacks();
    } catch (error: unknown) {
      console.error("Failed to submit feedback:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Unable to submit your feedback. Please check your input and try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTicketSubmit = async () => {
    try {
      setIsLoading(true);

      const response = await fetch("/api/user/support-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ticketForm),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          describeSupportError(payload, "Failed to create your support ticket"),
        );
      }

      toast({
        title: "Ticket created",
        description:
          "Your support ticket has been submitted. We'll get back to you as soon as possible.",
      });

      setTicketForm({
        title: "",
        description: "",
        priority: SupportPriority.LOW,
        issueType: undefined,
      });

      void invalidateTickets();
    } catch (error: unknown) {
      console.error("Failed to create support ticket:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Unable to create your support ticket. Please check your input and try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResponseSubmit = async (ticketId: string) => {
    try {
      setIsLoading(true);
      const response = await fetch(
        `/api/user/support-tickets/${ticketId}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(responseForm),
        },
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(describeSupportError(payload, "Failed to submit your response"));
      }

      toast({
        title: "Success",
        description: "Response submitted successfully.",
      });

      setResponseForm({ message: "" });
      void invalidateTickets(); // Refresh tickets to show the new response
    } catch (error: unknown) {
      console.error("Failed to submit response:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Unable to submit your response. Please check your message and try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLoading,
    feedbacks,
    tickets,
    selectedTicket,
    setSelectedTicket,
    feedbackForm,
    setFeedbackForm,
    ticketForm,
    setTicketForm,
    responseForm,
    setResponseForm,
    handleFeedbackSubmit,
    handleTicketSubmit,
    handleResponseSubmit,
  };
}
