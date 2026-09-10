/**
 * Service for managing webinars
 */

import { toast } from "@/hooks/use-toast";
import { WebinarEvent } from "@/types/planner-events";
import {
  positioningPayload,
  priceToPaise,
} from "@/components/planner/services/shared/plan-payload";
import {
  CreateWebinarPayload,
  UpdateWebinarPayload,
  WebinarRequestBody,
} from "../types";

export class WebinarService {
  /**
   * Check if a webinar title already exists for a consultant
   */
  static async checkDuplicateTitle(
    title: string,
    consultantId: string,
    excludeId: string = "",
  ): Promise<boolean> {
    try {
      const params = new URLSearchParams({
        title,
        consultantProfileId: consultantId,
      });
      if (excludeId) {
        params.append("excludeId", excludeId);
      }

      const response = await fetch(
        `/api/bookings/webinars/check-duplicate-title?${params}`,
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to check for duplicate webinar titles",
        );
      }

      const { isDuplicate } = await response.json();
      return isDuplicate;
    } catch (error) {
      console.error("[WebinarService.checkDuplicateTitle] Error:", error);
      return false;
    }
  }

  /**
   * Fetch webinars for a consultant
   * API returns topics as string[] - no transformation needed
   */
  static async fetchWebinars(
    consultantId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<WebinarEvent[]> {
    try {
      const params = new URLSearchParams({
        consultantProfileId: consultantId,
      });

      if (startDate && endDate) {
        params.append("startDate", startDate.toISOString());
        params.append("endDate", endDate.toISOString());
      }

      const response = await fetch(`/api/bookings/webinars?${params}`);
      if (!response.ok) {
        throw new Error("Failed to fetch webinars");
      }

      const { data } = await response.json();
      // API returns topics as strings and scheduledAt computed, just add type discriminant
      return data.map((webinar: WebinarEvent) => ({
        ...webinar,
        type: "webinar" as const,
        // Compute scheduledAt from appointment slots
        scheduledAt: webinar.appointment?.slotsOfAppointment?.[0]?.startsAt
          ? new Date(webinar.appointment.slotsOfAppointment[0].startsAt)
          : undefined,
      }));
    } catch (error) {
      console.error("[WebinarService.fetchWebinars] Error:", error);
      throw error;
    }
  }

  /**
   * Save webinar data
   * API handles topic creation/lookup - just send topic names
   */
  static async saveWebinar(
    webinarData: Partial<WebinarEvent>,
    scheduledAt: string | Date | null | undefined,
    consultantId: string,
  ): Promise<WebinarEvent> {
    try {
      const title = webinarData.webinarPlan?.title;
      const planId = webinarData.webinarPlan?.id ?? "";
      const isUpdate = !!planId;
      const webinarId = webinarData.id ?? "";

      // Check for duplicate title
      if (title) {
        const isDuplicate = await this.checkDuplicateTitle(
          title,
          consultantId,
          planId,
        );
        if (isDuplicate) {
          throw new Error(
            `A webinar with title "${title}" already exists. Please use a different title.`,
          );
        }
      }

      const endpoint = "/api/bookings/webinars/crud-with-plan";
      const method = isUpdate ? "PATCH" : "POST";

      const scheduledAtDate = this.parseScheduledDate(scheduledAt);
      const topicNames = webinarData.webinarPlan?.topics ?? [];
      const requestBody = this.buildRequestBody(
        webinarData,
        consultantId,
        topicNames,
        scheduledAtDate,
        isUpdate,
        planId,
        webinarId,
      );

      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            `Failed to ${isUpdate ? "update" : "create"} webinar`,
        );
      }

      const { data: webinar } = await response.json();
      return { ...webinar, type: "webinar" as const };
    } catch (error) {
      console.error("[WebinarService.saveWebinar] Error:", error);
      throw error;
    }
  }

  /**
   * Delete a webinar
   */
  static async deleteWebinar(webinarId: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/bookings/webinars/${webinarId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete webinar");
      }

      return true;
    } catch (error) {
      console.error("[WebinarService.deleteWebinar] Error:", error);
      throw error;
    }
  }

  // Private helper methods

  private static parseScheduledDate(
    scheduledAt: string | Date | null | undefined,
  ): Date | null {
    if (!scheduledAt) return null;

    if (typeof scheduledAt === "string") {
      return new Date(scheduledAt);
    } else if (scheduledAt instanceof Date) {
      return scheduledAt;
    }
    return null;
  }

  /**
   * Build request body for API
   * API accepts topic names directly - no ID conversion needed
   */
  private static buildRequestBody(
    webinarData: Partial<WebinarEvent>,
    consultantId: string,
    topicNames: string[],
    scheduledAtDate: Date | null,
    isUpdate: boolean,
    planId: string,
    webinarId: string,
  ): WebinarRequestBody {
    const plan = webinarData.webinarPlan;

    // Build base payload with required fields
    const basePayload: CreateWebinarPayload = {
      title: plan?.title ?? "",
      description: plan?.description ?? undefined,
      // The form edits rupees; the DB stores paise (#780 money model).
      price: priceToPaise(plan?.price),
      priceCurrency: plan?.priceCurrency,
      durationInHours: plan?.durationInHours ?? 1,
      maxParticipants: plan?.maxParticipants ?? 1,
      certificateProvided: plan?.certificateProvided,
      recordingEnabled: plan?.recordingEnabled,
      language: plan?.language ?? undefined,
      level: plan?.level ?? undefined,
      prerequisites: plan?.prerequisites ?? undefined,
      materialProvided: plan?.materialProvided ?? undefined,
      learningOutcomes: plan?.learningOutcomes,
      ...positioningPayload(plan ?? {}),
      topics: topicNames,
      consultantProfileId: consultantId,
      scheduledAt: scheduledAtDate,
    };

    if (isUpdate) {
      const updatePayload: UpdateWebinarPayload = {
        ...basePayload,
        id: planId,
        webinarId: webinarId || undefined,
      };
      return updatePayload;
    }

    return basePayload;
  }

  /**
   * Show success toast for webinar operations
   */
  static showSuccessToast(title: string, isUpdate: boolean): void {
    const action = isUpdate ? "Updated" : "Created";
    toast({
      title: "Success",
      description: `${action} webinar "${title}" successfully`,
    });
  }
}
