/**
 * PlannerService - Facade for event management services
 *
 * This service acts as a unified facade that delegates to specialized services:
 * - WebinarService: Manages webinar events
 * - ClassService: Manages class events
 * - ConsultationService: Manages consultation plans
 * - SubscriptionService: Manages subscription plans
 * - TopicService: Manages topic creation and lookup
 *
 * Note: This facade pattern maintains backward compatibility while allowing
 * direct usage of specialized services for more targeted operations.
 */

import { toast } from "@/hooks/use-toast";
import {
  ClassEvent,
  Event,
  FormData,
  WebinarEvent,
  ConsultationPlanEvent,
  SubscriptionPlanEvent,
  ClassContentInput,
  WebinarFormInput,
  ClassFormInput,
} from "@/types/planner-events";
import { WebinarService } from "./events/webinar-service";
import { ClassService } from "./events/class-service";
import { ConsultationService } from "./plans/consultation-service";
import { SubscriptionService } from "./plans/subscription-service";
import { TopicService } from "./topic-service";

export class PlannerService {
  // ============================================================================
  // DUPLICATE TITLE CHECKING
  // ============================================================================

  /**
   * Check if a title already exists for a consultant
   * Delegates to the appropriate specialized service based on event type.
   */
  static async checkDuplicateTitle(
    title: string,
    consultantId: string,
    eventType:
      | "webinar"
      | "class"
      | "consultation"
      | "subscription"
      | "both" = "both",
    excludeId: string = "",
  ): Promise<boolean> {
    // For 'both' option, check webinars first, then classes
    if (eventType === "both") {
      const isWebinarDuplicate = await WebinarService.checkDuplicateTitle(
        title,
        consultantId,
        excludeId,
      );
      if (isWebinarDuplicate) return true;

      return ClassService.checkDuplicateTitle(title, consultantId, excludeId);
    }

    switch (eventType) {
      case "webinar":
        return WebinarService.checkDuplicateTitle(
          title,
          consultantId,
          excludeId,
        );
      case "class":
        return ClassService.checkDuplicateTitle(title, consultantId, excludeId);
      case "consultation":
        return ConsultationService.checkDuplicateTitle(
          title,
          consultantId,
          excludeId,
        );
      case "subscription":
        return SubscriptionService.checkDuplicateTitle(
          title,
          consultantId,
          excludeId,
        );
      default:
        console.error(`Unsupported event type: ${eventType}`);
        return false;
    }
  }

  // ============================================================================
  // FETCH OPERATIONS
  // ============================================================================

  /**
   * Fetch webinars for a consultant
   */
  static async fetchWebinars(
    consultantId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<WebinarEvent[]> {
    return WebinarService.fetchWebinars(consultantId, startDate, endDate);
  }

  /**
   * Fetch classes for a consultant
   */
  static async fetchClasses(
    consultantId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<ClassEvent[]> {
    return ClassService.fetchClasses(consultantId, startDate, endDate);
  }

  /**
   * Fetch consultation plans for a consultant
   */
  static async fetchConsultationPlans(
    consultantId: string,
  ): Promise<ConsultationPlanEvent[]> {
    return ConsultationService.fetchConsultationPlans(consultantId);
  }

  /**
   * Fetch subscription plans for a consultant
   */
  static async fetchSubscriptionPlans(
    consultantId: string,
  ): Promise<SubscriptionPlanEvent[]> {
    return SubscriptionService.fetchSubscriptionPlans(consultantId);
  }

  // ============================================================================
  // SAVE OPERATIONS
  // ============================================================================

  /**
   * Save webinar data with transaction handling
   */
  static async saveWebinar(
    webinarData: Partial<WebinarEvent>,
    scheduledAt: string | Date | null | undefined,
    consultantId: string,
  ): Promise<WebinarEvent> {
    return WebinarService.saveWebinar(webinarData, scheduledAt, consultantId);
  }

  /**
   * Save class data with transaction handling
   */
  static async saveClass(
    classData: Partial<ClassEvent>,
    consultantId: string,
    startDate?: string | null,
  ): Promise<ClassEvent> {
    return ClassService.saveClass(classData, consultantId, startDate);
  }

  /**
   * Save consultation plan data
   */
  static async saveConsultationPlan(
    planData: Partial<ConsultationPlanEvent>,
    consultantId: string,
  ): Promise<ConsultationPlanEvent> {
    return ConsultationService.saveConsultationPlan(planData, consultantId);
  }

  /**
   * Save subscription plan data
   */
  static async saveSubscriptionPlan(
    planData: Partial<SubscriptionPlanEvent>,
    consultantId: string,
  ): Promise<SubscriptionPlanEvent> {
    return SubscriptionService.saveSubscriptionPlan(planData, consultantId);
  }

  /**
   * Generic save handler that routes to the appropriate service based on form data
   */
  static async saveEventFromFormData(
    formData: FormData,
    eventType: "webinar" | "class" | "consultation" | "subscription",
    consultantId: string,
    existingData?: Event,
  ): Promise<Event> {
    switch (eventType) {
      case "webinar": {
        const webinarData = this.buildWebinarDataFromForm(
          formData,
          existingData as WebinarEvent | undefined,
        );
        // Form input is a valid subset of Partial<WebinarEvent> - saveWebinar only uses the fields we provide
        return this.saveWebinar(
          webinarData as Partial<WebinarEvent>,
          formData.scheduledAt,
          consultantId,
        );
      }
      case "class": {
        const classData = this.buildClassDataFromForm(
          formData,
          existingData as ClassEvent | undefined,
        );
        // Form input is a valid subset of Partial<ClassEvent> - saveClass only uses the fields we provide
        return this.saveClass(
          classData as Partial<ClassEvent>,
          consultantId,
          formData.scheduledAt?.toString(),
        );
      }
      case "consultation": {
        const consultationData = this.buildConsultationDataFromForm(
          formData,
          existingData as ConsultationPlanEvent | undefined,
        );
        return this.saveConsultationPlan(consultationData, consultantId);
      }
      case "subscription": {
        const subscriptionData = this.buildSubscriptionDataFromForm(
          formData,
          existingData as SubscriptionPlanEvent | undefined,
        );
        return this.saveSubscriptionPlan(subscriptionData, consultantId);
      }
      default:
        throw new Error(`Unsupported event type: ${eventType}`);
    }
  }

  // ============================================================================
  // TOPIC OPERATIONS
  // ============================================================================

  /**
   * Create topics by name
   */
  static async createTopics(topicNames: string[]): Promise<string[]> {
    return TopicService.createTopics(topicNames);
  }

  /**
   * Get topics for autocomplete
   */
  static async getTopics(search?: string) {
    return TopicService.getTopics(search);
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Format class contents for API submission
   */
  static formatClassContents(
    classContents: ClassContentInput[],
    classPlanId: string,
    now: Date,
  ): ClassContentInput[] {
    return ClassService.formatClassContents(classContents, classPlanId, now);
  }

  /**
   * Show success toast for event operations
   */
  static showSuccessToast(
    title: string,
    isUpdate: boolean,
    eventType: "webinar" | "class" | "consultation" | "subscription",
  ): void {
    const action = isUpdate ? "Updated" : "Created";
    const typeLabel =
      eventType === "consultation"
        ? "consultation plan"
        : eventType === "subscription"
          ? "subscription plan"
          : eventType;
    toast({
      title: "Success",
      description: `${action} ${typeLabel} "${title}" successfully`,
    });
  }

  /**
   * Handle save errors with appropriate toast messages
   */
  static handleSaveError(error: unknown, eventType: string): void {
    console.error(`[PlannerService] Error saving ${eventType}:`, error);
    toast({
      title: "Error",
      description:
        error instanceof Error ? error.message : `Failed to save ${eventType}`,
      variant: "destructive",
    });
  }

  // ============================================================================
  // TYPE GUARDS
  // ============================================================================

  static isWebinarEvent(event: Event): event is WebinarEvent {
    return event.type === "webinar";
  }

  static isClassEvent(event: Event): event is ClassEvent {
    return event.type === "class";
  }

  static isConsultationPlanEvent(event: Event): event is ConsultationPlanEvent {
    return event.type === "consultation";
  }

  static isSubscriptionPlanEvent(event: Event): event is SubscriptionPlanEvent {
    return event.type === "subscription";
  }

  // ============================================================================
  // PRIVATE HELPER METHODS - Form Data Builders
  // ============================================================================

  private static buildWebinarDataFromForm(
    formData: FormData,
    existingData?: WebinarEvent,
  ): WebinarFormInput {
    return {
      id: existingData?.id,
      webinarPlan: {
        id: existingData?.webinarPlan?.id,
        title: formData.title,
        description: formData.description || null,
        price: formData.price,
        priceCurrency: formData.priceCurrency || "INR",
        durationInHours: formData.durationInHours ?? 1,
        maxParticipants: formData.maxParticipants,
        certificateProvided: formData.certificateProvided ?? false,
        language: formData.language || null,
        level: formData.level || null,
        prerequisites: formData.prerequisites,
        materialProvided: formData.materialProvided,
        learningOutcomes: formData.learningOutcomes || [],
        topics: formData.topics || [],
        consultantProfileId:
          formData.consultantProfileId ||
          existingData?.webinarPlan?.consultantProfileId ||
          "",
      },
    };
  }

  private static buildClassDataFromForm(
    formData: FormData,
    existingData?: ClassEvent,
  ): ClassFormInput {
    return {
      id: existingData?.id,
      classPlan: {
        id: existingData?.classPlan?.id,
        title: formData.title,
        description: formData.description || null,
        price: formData.price,
        priceCurrency: formData.priceCurrency || "INR",
        durationInMonths: formData.durationInMonths ?? 1,
        sessionsPerWeek: formData.sessionsPerWeek ?? 1,
        maxParticipants: formData.maxParticipants,
        certificateProvided: formData.certificateProvided ?? false,
        recordingEnabled: formData.recordingEnabled ?? false,
        emailSupport: formData.emailSupport || "GENERAL",
        language: formData.language || null,
        level: formData.level || null,
        prerequisites: formData.prerequisites,
        materialProvided: formData.materialProvided,
        learningOutcomes: formData.learningOutcomes || [],
        topics: formData.topics || [],
        classContents: formData.classContents || [],
        consultantProfileId:
          formData.consultantProfileId ||
          existingData?.classPlan?.consultantProfileId ||
          "",
      },
    };
  }

  private static buildConsultationDataFromForm(
    formData: FormData,
    existingData?: ConsultationPlanEvent,
  ): Partial<ConsultationPlanEvent> {
    return {
      id: existingData?.id,
      consultationPlan: {
        id: existingData?.consultationPlan?.id,
        title: formData.title,
        description: formData.description,
        price: formData.price,
        priceCurrency: formData.priceCurrency || "INR",
        durationInHours: formData.durationInHours ?? 1,
        language: formData.language || null,
        level: formData.level || null,
        prerequisites: formData.prerequisites,
        materialProvided: formData.materialProvided,
        learningOutcomes: formData.learningOutcomes || [],
        consultantProfileId:
          formData.consultantProfileId ||
          existingData?.consultationPlan?.consultantProfileId ||
          "",
      },
    } as Partial<ConsultationPlanEvent>;
  }

  private static buildSubscriptionDataFromForm(
    formData: FormData,
    existingData?: SubscriptionPlanEvent,
  ): Partial<SubscriptionPlanEvent> {
    return {
      id: existingData?.id,
      subscriptionPlan: {
        id: existingData?.subscriptionPlan?.id,
        title: formData.title,
        description: formData.description,
        price: formData.price,
        priceCurrency: formData.priceCurrency || "INR",
        durationInMonths: formData.durationInMonths ?? 1,
        sessionsPerWeek: formData.sessionsPerWeek ?? 1,
        emailSupport: formData.emailSupport || "GENERAL",
        language: formData.language || null,
        level: formData.level || null,
        prerequisites: formData.prerequisites,
        materialProvided: formData.materialProvided,
        learningOutcomes: formData.learningOutcomes || [],
        consultantProfileId:
          formData.consultantProfileId ||
          existingData?.subscriptionPlan?.consultantProfileId ||
          "",
      },
    } as Partial<SubscriptionPlanEvent>;
  }
}
