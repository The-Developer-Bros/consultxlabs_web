import {
  TAppointment,
  TConsultation,
  TSubscription,
} from "@/types/appointment";
import { TConsultantProfile } from "@/types/consultant";
import {
  ApiResponse,
  DocumentsPage,
  IActivity,
  IApproval,
} from "../types";

/**
 * Query params accepted by the consultant documents API (issue #346).
 * All fields are optional; defaults match the server's behavior.
 */
export interface FetchDocumentsParams {
  limit?: number;
  offset?: number;
  status?: string; // "PENDING" | "IN_REVIEW" | "APPROVED" | "REJECTED" | "NEEDS_REVISION"
  appointmentType?: string; // "Consultation" | "Subscription"
  /** B1-personal-retrofit: org-scope filter ("personal" | <orgId> | "all"). */
  orgScope?: string | null;
}

/** Enhanced error with additional diagnostic fields for the document fetch system */
export interface DocumentFetchError extends Error {
  technicalMessage?: string;
  status?: number;
  originalError?: Error;
}

// Data fetching functions using relative URLs
// These work in both client and server components

export async function fetchConsultantData(
  consultantId: string,
): Promise<TConsultantProfile> {
  try {
    const response = await fetch(`/api/user/consultants/${consultantId}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch consultant data: ${response.statusText}`,
      );
    }
    const data: ApiResponse<TConsultantProfile> = await response.json();
    return data.data;
  } catch (error) {
    console.error("Error fetching consultant data:", error);
    throw error;
  }
}

export async function fetchAppointments(
  consultantId: string,
): Promise<TAppointment[]> {
  try {
    const response = await fetch(
      `/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch appointments: ${response.statusText}`);
    }
    const data: ApiResponse<TAppointment[]> = await response.json();

    // Return the data directly as TAppointment[] since we're now using TAppointment everywhere
    return data.data;
  } catch (error) {
    console.error("Error fetching appointments:", error);
    throw error;
  }
}

export async function fetchApprovals(
  consultantId: string,
): Promise<IApproval[]> {
  try {
    // Fetch both consultations and subscriptions
    const [consultationsRes, subscriptionsRes] = await Promise.all([
      fetch(
        `/api/bookings/consultations?consultantProfileId=${consultantId}&status=PENDING`,
      ),
      fetch(
        `/api/bookings/subscriptions?consultantProfileId=${consultantId}&status=PENDING`,
      ),
    ]);

    if (!consultationsRes.ok || !subscriptionsRes.ok) {
      throw new Error("Failed to fetch approvals");
    }

    const consultationsData: ApiResponse<TConsultation[]> =
      await consultationsRes.json();
    const subscriptionsData: ApiResponse<TSubscription[]> =
      await subscriptionsRes.json();

    // Transform to IApproval format
    const approvals: IApproval[] = [];

    // Add consultations
    consultationsData.data.forEach((consultation: TConsultation) => {
      approvals.push({
        id: consultation.id,
        name: consultation.requestedBy?.user?.name || "Unknown",
        type: "Consultation",
        date: new Date(consultation.requestedAt).toLocaleDateString(),
        time: new Date(consultation.requestedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    });

    // Add subscriptions
    subscriptionsData.data.forEach((subscription: TSubscription) => {
      approvals.push({
        id: subscription.id,
        name: subscription.requestedBy?.user?.name || "Unknown",
        type: "Subscription",
        date: new Date(subscription.requestedAt).toLocaleDateString(),
        time: new Date(subscription.requestedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    });

    return approvals;
  } catch (error) {
    console.error("Error fetching approvals:", error);
    throw error;
  }
}

export async function fetchActivities(
  consultantId: string,
): Promise<IActivity[]> {
  try {
    const response = await fetch(
      `/api/activities?consultantId=${consultantId}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch activities: ${response.statusText}`);
    }
    const data: ApiResponse<IActivity[]> = await response.json();
    return data.data;
  } catch (error) {
    console.error("Error fetching activities:", error);
    throw error;
  }
}

export async function fetchDocuments(
  consultantId: string,
  params: FetchDocumentsParams = {},
): Promise<DocumentsPage> {
  try {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    if (params.status) qs.set("status", params.status);
    if (params.appointmentType)
      qs.set("appointmentType", params.appointmentType);
    // B1-personal-retrofit: forward orgScope to the dashboard endpoint
    // (which was retrofitted in PR-1 to accept ?orgScope=).
    if (params.orgScope && params.orgScope !== "personal")
      qs.set("orgScope", params.orgScope);

    const query = qs.toString();
    const url = `/api/dashboard/consultant/${consultantId}/documents${query ? `?${query}` : ""}`;

    const response = await fetch(url);

    if (!response.ok) {
      let errorMessage = "Failed to load documents";
      let userFriendlyMessage =
        "Unable to load documents for review. Please try again.";

      try {
        const errorData = await response.json();

        // Use the enhanced error messages from the API
        if (errorData.message) {
          userFriendlyMessage = errorData.message;
        }

        // Provide specific messages based on error codes
        switch (errorData.code) {
          case "UNAUTHORIZED":
            userFriendlyMessage = "Please sign in again to view documents.";
            break;
          case "ACCESS_DENIED":
            userFriendlyMessage =
              "You don't have permission to view these documents. Please check that you're accessing the correct consultant dashboard.";
            break;
          case "CONNECTION_ERROR":
            userFriendlyMessage =
              "Connection issue detected. Please check your internet connection and try again.";
            break;
          case "DATABASE_ERROR":
            userFriendlyMessage =
              "Document system is temporarily unavailable. Please try again in a few moments.";
            break;
          case "INVALID_FILTER":
            userFriendlyMessage =
              errorData.message ||
              "Invalid filter applied. Please check your search criteria.";
            break;
          default:
            // Use the message from API if available, otherwise fall back to default
            userFriendlyMessage = errorData.message || userFriendlyMessage;
        }

        errorMessage =
          errorData.error || `HTTP ${response.status}: ${response.statusText}`;
      } catch (_parseError) {
        // If we can't parse the error response, provide helpful messages based on status codes
        switch (response.status) {
          case 401:
            userFriendlyMessage = "Please sign in again to view documents.";
            break;
          case 403:
            userFriendlyMessage =
              "Access denied. Please check that you have permission to view these documents.";
            break;
          case 404:
            userFriendlyMessage =
              "Consultant profile not found. Please check the URL and try again.";
            break;
          case 500:
            userFriendlyMessage =
              "Server error occurred. Please try again later or contact support.";
            break;
          case 503:
            userFriendlyMessage =
              "Document system is temporarily unavailable. Please try again in a few moments.";
            break;
          default:
            userFriendlyMessage = `Unable to load documents (Error ${response.status}). Please try again.`;
        }
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }

      // Create an enhanced error with both technical and user-friendly messages
      const enhancedError = new Error(userFriendlyMessage) as DocumentFetchError;
      enhancedError.name = "DocumentFetchError";
      enhancedError.technicalMessage = errorMessage;
      enhancedError.status = response.status;

      throw enhancedError;
    }

    const data = (await response.json()) as Partial<DocumentsPage>;

    // Log helpful information for debugging
    if (data.message) {
      console.info("Documents API message:", data.message);
    }

    // Handle successful response but validate data structure. If the server
    // returns an unexpected shape, fall back to an empty page that matches
    // the DocumentsPage contract so callers never have to null-check.
    const fallbackPagination = {
      limit: params.limit ?? 10,
      offset: params.offset ?? 0,
      totalCount: 0,
      totalPages: 1,
      currentPage: 1,
      hasNextPage: false,
      hasPrevPage: false,
    };
    const fallbackMetadata = {
      pendingCount: 0,
      reviewingCount: 0,
      needsRevisionCount: 0,
      completedCount: 0,
    };

    if (!data.data) {
      console.warn(
        "Documents API response missing data array, returning empty page",
      );
      return {
        data: [],
        pagination: data.pagination ?? fallbackPagination,
        metadata: data.metadata ?? fallbackMetadata,
        count: data.count,
        message: data.message,
        consultant: data.consultant,
        filters: data.filters,
      };
    }

    return {
      data: data.data,
      pagination: data.pagination ?? fallbackPagination,
      metadata: data.metadata ?? fallbackMetadata,
      count: data.count,
      message: data.message,
      consultant: data.consultant,
      filters: data.filters,
    };
  } catch (error) {
    // Handle network errors and other exceptions
    if (error instanceof Error) {
      // If it's already our enhanced error, re-throw it
      if (error.name === "DocumentFetchError") {
        throw error;
      }

      // Handle network and other errors
      let userFriendlyMessage = "Unable to connect to the document system.";

      if (error.message.includes("fetch")) {
        userFriendlyMessage =
          "Network error: Please check your internet connection and try again.";
      } else if (error.message.includes("timeout")) {
        userFriendlyMessage =
          "Request timed out: The server is taking too long to respond. Please try again.";
      } else if (error.message.includes("JSON")) {
        userFriendlyMessage =
          "Data format error: Please refresh the page and try again.";
      } else {
        userFriendlyMessage =
          "An unexpected error occurred while loading documents. Please try again.";
      }

      const enhancedError = new Error(userFriendlyMessage) as DocumentFetchError;
      enhancedError.name = "DocumentFetchError";
      enhancedError.technicalMessage = error.message;
      enhancedError.originalError = error;

      console.error("Enhanced error fetching documents:", {
        userMessage: userFriendlyMessage,
        technicalMessage: error.message,
        stack: error.stack,
      });

      throw enhancedError;
    }

    // Handle non-Error objects (shouldn't happen, but just in case)
    const fallbackError = new Error(
      "An unknown error occurred while loading documents. Please try again.",
    ) as DocumentFetchError;
    fallbackError.name = "DocumentFetchError";
    fallbackError.technicalMessage = String(error);

    console.error("Unknown error fetching documents:", error);
    throw fallbackError;
  }
}
