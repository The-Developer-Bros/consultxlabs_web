import { IPlanMaterial } from "@/types/planner-events";

export type PlanType = "consultation" | "subscription" | "webinar" | "class";

interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Service for managing plan materials
 */
export class MaterialsService {
  /**
   * Get the API endpoint for plan materials
   */
  private static getEndpoint(planType: PlanType, planId: string): string {
    const planTypeMap: Record<PlanType, string> = {
      consultation: "consultations",
      subscription: "subscriptions",
      webinar: "webinars",
      class: "classes",
    };
    const pluralType = planTypeMap[planType];
    return `/api/plans/${pluralType}/${planId}/materials`;
  }

  /**
   * Fetch all materials for a plan
   */
  static async getMaterials(
    planType: PlanType,
    planId: string,
  ): Promise<IPlanMaterial[]> {
    try {
      const response = await fetch(this.getEndpoint(planType, planId));
      const result: ApiResponse<IPlanMaterial[]> = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to fetch materials");
      }

      return result.data || [];
    } catch (error) {
      console.error("Error fetching materials:", error);
      throw error;
    }
  }

  /**
   * Upload a new material
   */
  static async uploadMaterial(
    planType: PlanType,
    planId: string,
    file: File,
    description?: string,
  ): Promise<IPlanMaterial> {
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (description) {
        formData.append("description", description);
      }

      const response = await fetch(this.getEndpoint(planType, planId), {
        method: "POST",
        body: formData,
      });

      const result: ApiResponse<IPlanMaterial> = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to upload material");
      }

      return result.data!;
    } catch (error) {
      console.error("Error uploading material:", error);
      throw error;
    }
  }

  /**
   * Delete a material
   */
  static async deleteMaterial(materialId: string): Promise<void> {
    try {
      const response = await fetch(`/api/plans/materials/${materialId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const result: ApiResponse<never> = await response.json();
        throw new Error(result.error || "Failed to delete material");
      }
    } catch (error) {
      console.error("Error deleting material:", error);
      throw error;
    }
  }

  /**
   * Update material order or description
   */
  static async updateMaterial(
    materialId: string,
    updates: { order?: number; description?: string },
  ): Promise<IPlanMaterial> {
    try {
      const response = await fetch(`/api/plans/materials/${materialId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updates),
      });

      const result: ApiResponse<IPlanMaterial> = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to update material");
      }

      return result.data!;
    } catch (error) {
      console.error("Error updating material:", error);
      throw error;
    }
  }

  /**
   * Reorder materials by providing an ordered list of IDs
   */
  static async reorderMaterials(
    planType: PlanType,
    planId: string,
    orderedIds: string[],
  ): Promise<void> {
    try {
      // Update each material's order
      await Promise.all(
        orderedIds.map((id, index) =>
          this.updateMaterial(id, { order: index }),
        ),
      );
    } catch (error) {
      console.error("Error reordering materials:", error);
      throw error;
    }
  }
}

/**
 * Service for managing consultant response documents
 */
export class ConsultantDocumentService {
  /**
   * Upload a consultant response document
   */
  static async uploadResponseDocument(
    appointmentId: string,
    file: File,
    options?: {
      description?: string;
      responseToDocumentId?: string;
    },
  ): Promise<unknown> {
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (options?.description) {
        formData.append("description", options.description);
      }
      if (options?.responseToDocumentId) {
        formData.append("responseToDocumentId", options.responseToDocumentId);
      }

      const response = await fetch(
        `/api/appointments/${appointmentId}/documents/consultant`,
        {
          method: "POST",
          body: formData,
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to upload document");
      }

      return result.data;
    } catch (error) {
      console.error("Error uploading consultant document:", error);
      throw error;
    }
  }
}
