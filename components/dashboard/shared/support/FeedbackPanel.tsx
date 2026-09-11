"use client";

import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";


import {
  FeedbackStatus,
  SupportTicketStatus,
} from "@prisma/client";
import { useFeedbackSupport } from "./useFeedbackSupport";
import {
  MessageSquare,
  Star,
  Send,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";



export interface FeedbackPanelProps {
  /** Profile id of the viewer, used for appointment-context lookups. */
  profileId: string;
}

export function FeedbackPanel({ profileId }: FeedbackPanelProps) {
  // Query-key namespace only — every fetch behind this hook is session-keyed
  // (/api/user/feedbacks, /api/user/support-tickets). It is no longer always
  // a consultee: enterprise operators reach this same surface from
  // org-workspace, and they hold no consultee profile at all.
  const scopeId = profileId;
  const { isLoading, feedbacks, feedbackForm, setFeedbackForm, handleFeedbackSubmit } =
    useFeedbackSupport(scopeId);

  // Semantic status colors kept (amber=in progress, green=resolved); the
  // off-brand blue OPEN/PENDING accent collapses to neutral monochrome.
  const getStatusColor = (status: FeedbackStatus | SupportTicketStatus) => {
    switch (status) {
      case "PENDING":
      case "OPEN":
        return "bg-muted text-foreground border-border";
      case "IN_PROGRESS":
        return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800";
      case "RESOLVED":
        return "bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800";
      case "CLOSED":
        return "bg-muted text-muted-foreground border-border";
      default:
        return "bg-muted text-muted-foreground border-border";
    }
  };

  const getStatusIcon = (status: FeedbackStatus | SupportTicketStatus) => {
    switch (status) {
      case "PENDING":
      case "OPEN":
        return <AlertCircle className="h-3.5 w-3.5" />;
      case "IN_PROGRESS":
        return <Clock className="h-3.5 w-3.5" />;
      case "RESOLVED":
      case "CLOSED":
        return <CheckCircle2 className="h-3.5 w-3.5" />;
      default:
        return <AlertCircle className="h-3.5 w-3.5" />;
    }
  };

  return (
    <div className="space-y-8">
      {/* #705 — the `requests` half of this surface was DELETED. It was a
          second, fully-built ticket form with an inline reply box, mounted
          only by SupportRequestsPage, which nothing ever imported: the nav
          item labelled "Support requests" points at SupportHub instead. Two
          live intake forms for the same queue is one more than anyone can
          keep correct, and this was the one nobody could reach. */}
        <div className="grid gap-8 lg:grid-cols-5">
          {/* Feedback Form */}
          <Card className="lg:col-span-2 border-0 shadow-sm bg-card dark:bg-zinc-900">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-6">
                <div className="p-1.5 rounded-md bg-muted">
                  <Star className="h-4 w-4 text-muted-foreground" />
                </div>
                <h3 className="font-semibold text-foreground dark:text-white">
                  Submit Feedback
                </h3>
              </div>

              <div className="space-y-5">
                <div className="space-y-2">
                  <Label
                    htmlFor="feedback-title"
                    className="text-sm font-medium text-muted-foreground dark:text-zinc-300"
                  >
                    Title <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="feedback-title"
                    value={feedbackForm.title}
                    onChange={(e) =>
                      setFeedbackForm((prev) => ({
                        ...prev,
                        title: e.target.value,
                      }))
                    }
                    placeholder="Brief summary of your feedback"
                    className="h-11 border-border dark:border-zinc-700"
                  />
                </div>

                <div className="space-y-2">
                  <Label
                    htmlFor="feedback-description"
                    className="text-sm font-medium text-muted-foreground dark:text-zinc-300"
                  >
                    Description <span className="text-red-500">*</span>
                  </Label>
                  <Textarea
                    id="feedback-description"
                    value={feedbackForm.description}
                    onChange={(e) =>
                      setFeedbackForm((prev) => ({
                        ...prev,
                        description: e.target.value,
                      }))
                    }
                    placeholder="Tell us more about your experience..."
                    className="min-h-[120px] border-border dark:border-zinc-700 resize-none"
                  />
                </div>

                <div className="space-y-2">
                  <Label
                    htmlFor="feedback-rating"
                    className="text-sm font-medium text-muted-foreground dark:text-zinc-300"
                  >
                    Rating (Optional)
                  </Label>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map((rating) => (
                      <button
                        key={rating}
                        type="button"
                        onClick={() =>
                          setFeedbackForm((prev) => ({ ...prev, rating }))
                        }
                        aria-label={`Rate ${rating} out of 5 stars`}
                        aria-pressed={feedbackForm.rating === rating}
                        className={`p-2 rounded-lg transition-all cursor-pointer ${
                          feedbackForm.rating && feedbackForm.rating >= rating
                            ? "text-amber-500"
                            : "text-muted-foreground/70 dark:text-zinc-600 hover:text-amber-400"
                        }`}
                      >
                        <Star
                          className={`h-6 w-6 ${feedbackForm.rating && feedbackForm.rating >= rating ? "fill-current" : ""}`}
                        />
                      </button>
                    ))}
                  </div>
                </div>

                <Button
                  onClick={handleFeedbackSubmit}
                  disabled={
                    isLoading ||
                    !feedbackForm.title ||
                    !feedbackForm.description
                  }
                  className="w-full h-11"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4 mr-2" />
                      Submit Feedback
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Feedback History */}
          <Card className="lg:col-span-3 border-0 shadow-sm bg-card dark:bg-zinc-900">
            <CardContent className="p-6">
              <h3 className="font-semibold text-foreground dark:text-white mb-4">
                Your Feedback History
              </h3>

              <div className="space-y-3">
                {feedbacks.map((feedback) => (
                  <div
                    key={feedback.id}
                    className="p-4 rounded-xl bg-muted dark:bg-zinc-800/50 border border-border dark:border-zinc-800 transition-all hover:shadow-sm"
                  >
                    <div className="flex justify-between items-start gap-4 mb-2">
                      <h4 className="font-medium text-foreground dark:text-white">
                        {feedback.title}
                      </h4>
                      <Badge
                        variant="outline"
                        className={`${getStatusColor(feedback.status as FeedbackStatus)} flex items-center gap-1.5 shrink-0`}
                      >
                        {getStatusIcon(feedback.status as FeedbackStatus)}
                        {feedback.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground dark:text-zinc-400 line-clamp-2">
                      {feedback.description}
                    </p>
                    {feedback.rating && (
                      <div className="flex items-center gap-1 mt-2">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Star
                            key={i}
                            className={`h-3.5 w-3.5 ${i < feedback.rating! ? "text-amber-500 fill-amber-500" : "text-muted-foreground/70"}`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {feedbacks.length === 0 && (
                  <div className="text-center py-12">
                    <div className="mx-auto w-12 h-12 rounded-full bg-muted dark:bg-zinc-800 flex items-center justify-center mb-3">
                      <MessageSquare className="h-6 w-6 text-muted-foreground/70" />
                    </div>
                    <p className="text-muted-foreground dark:text-zinc-400">
                      No feedback submitted yet
                    </p>
                    <p className="text-sm text-muted-foreground/70 dark:text-zinc-500 mt-1">
                      Share your thoughts with us!
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
    </div>
  );
}
