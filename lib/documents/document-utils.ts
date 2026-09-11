import {
  Clock,
  AlertCircle,
  CheckCircle,
  X,
  FileText,
  FileImage,
  FileType,
  FileSpreadsheet,
  FileArchive,
} from "lucide-react";
import { createElement } from "react";

/**
 * Format file size from bytes to human-readable string
 */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Get CSS classes for document review status badge
 */
export function getStatusColor(status: string): string {
  switch (status) {
    case "PENDING":
      return "bg-yellow-100 text-yellow-800";
    case "IN_REVIEW":
      return "bg-blue-100 text-blue-800";
    case "APPROVED":
      return "bg-green-100 text-green-800";
    case "REJECTED":
      return "bg-red-100 text-red-800";
    case "NEEDS_REVISION":
      return "bg-orange-100 text-orange-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

/**
 * Get Lucide icon component for document review status
 * Returns React element with appropriate icon and styling
 */
export function getStatusIcon(status: string) {
  switch (status) {
    case "PENDING":
      return createElement(Clock, { className: "h-4 w-4 text-yellow-500" });
    case "IN_REVIEW":
      return createElement(AlertCircle, { className: "h-4 w-4 text-blue-500" });
    case "APPROVED":
      return createElement(CheckCircle, {
        className: "h-4 w-4 text-green-500",
      });
    case "REJECTED":
      return createElement(X, { className: "h-4 w-4 text-red-500" });
    case "NEEDS_REVISION":
      return createElement(AlertCircle, {
        className: "h-4 w-4 text-orange-500",
      });
    default:
      return createElement(Clock, { className: "h-4 w-4 text-gray-500" });
  }
}

/**
 * Get human-readable label for document review status enum
 */
export function getStatusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "IN_REVIEW":
      return "In Review";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    case "NEEDS_REVISION":
      return "Needs Revision";
    default:
      return status;
  }
}

/**
 * Get Lucide icon element for a document based on its MIME type
 */
export function getDocumentTypeIcon(mimeType: string) {
  if (mimeType === "application/pdf") {
    return createElement(FileText, { className: "h-5 w-5 text-red-500" });
  }
  if (mimeType.startsWith("image/")) {
    return createElement(FileImage, { className: "h-5 w-5 text-green-500" });
  }
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword"
  ) {
    return createElement(FileType, { className: "h-5 w-5 text-blue-500" });
  }
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel"
  ) {
    return createElement(FileSpreadsheet, {
      className: "h-5 w-5 text-green-600",
    });
  }
  if (
    mimeType === "application/zip" ||
    mimeType === "application/x-rar-compressed" ||
    mimeType === "application/gzip"
  ) {
    return createElement(FileArchive, {
      className: "h-5 w-5 text-yellow-500",
    });
  }
  return createElement(FileText, { className: "h-5 w-5 text-gray-400" });
}
