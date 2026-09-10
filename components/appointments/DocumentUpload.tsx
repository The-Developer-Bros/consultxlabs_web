"use client";

import React, { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
} from "@/components/ui/responsive-modal";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  FileText,
  X,
  Eye,
  Download,
  RefreshCw,
  WifiOff,
  Database,
  HelpCircle,
  AlertCircle,
  Reply,
  UserCircle,
} from "lucide-react";
import {
  formatFileSize,
  getStatusColor,
  getStatusIcon,
} from "@/lib/documents/document-utils";

interface DocumentUploadProps {
  appointmentId: string;
  appointmentTitle: string;
  appointmentType: string;
  /** When true, dialog opens immediately (controlled externally) */
  defaultOpen?: boolean;
  /** External open state change handler */
  onOpenChange?: (open: boolean) => void;
}

type DocumentUploadRole = "CONSULTEE" | "CONSULTANT";

interface UploadedDocument {
  id: string;
  originalName: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  description: string | null;
  reviewStatus:
    | "PENDING"
    | "IN_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "NEEDS_REVISION";
  reviewNotes: string | null;
  reviewedAt: Date | null;
  uploadedAt: Date;
  // New fields for consultant responses
  uploadedByRole?: DocumentUploadRole;
  responseToDocumentId?: string | null;
  responseToDocument?: {
    id: string;
    originalName: string;
    uploadedByRole: DocumentUploadRole;
  } | null;
  responseDocuments?: UploadedDocument[];
  // Threaded review versioning — 1 = original upload; the highest number in
  // a thread is the current version.
  rootDocumentId?: string | null;
  versionNo?: number;
}

interface ApiError {
  error: string;
  message: string;
  code?: string;
  instructions?: string; // Manual bucket creation instructions
  technical?: string; // Technical error details
}

interface ApiResponse {
  data?: UploadedDocument[];
  message?: string;
  count?: number;
  appointmentTitle?: string;
  consultantName?: string;
  error?: string;
}

export function DocumentUpload({
  appointmentId,
  appointmentTitle,
  appointmentType,
  defaultOpen = false,
  onOpenChange,
}: DocumentUploadProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    // Closing without uploading or cancelling used to leave `revisionOf` set,
    // so the NEXT ordinary upload silently threaded onto the old document and
    // became a revision of it.
    if (!open) setRevisionOf(null);
    onOpenChange?.(open);
  };
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  // Set when the learner clicks "Upload revision" on a NEEDS_REVISION doc, so
  // the new file threads onto the one it replaces instead of arriving as an
  // unrelated upload the reviewer has to match up by hand.
  const [revisionOf, setRevisionOf] = useState<UploadedDocument | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [contextInfo, setContextInfo] = useState<{
    appointmentTitle?: string;
    consultantName?: string;
    message?: string;
  }>({});
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocuments = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/appointments/${appointmentId}/documents`,
      );
      const result: ApiResponse | ApiError = await response.json();

      if (!response.ok) {
        const errorResult = result as ApiError;
        setError(errorResult);

        // Show different toast messages based on error type
        if (errorResult.code === "NOT_FOUND") {
          toast({
            title: "Appointment not found",
            description:
              "Please check if you have the correct appointment selected.",
            variant: "destructive",
          });
        } else if (errorResult.code === "CONNECTION_ERROR") {
          toast({
            title: "Connection issue",
            description: "Please check your internet connection and try again.",
            variant: "destructive",
          });
        } else if (errorResult.code === "DATABASE_ERROR") {
          toast({
            title: "Service temporarily unavailable",
            description: "Please try again in a few moments.",
            variant: "destructive",
          });
        } else {
          toast({
            title: "Unable to load documents",
            description: errorResult.message || "Please try again later.",
            variant: "destructive",
          });
        }

        return;
      }

      const successResult = result as ApiResponse;
      setDocuments(successResult.data || []);
      setContextInfo({
        appointmentTitle: successResult.appointmentTitle,
        consultantName: successResult.consultantName,
        message: successResult.message,
      });

      // Show informational message if no documents exist yet
      if (successResult.data?.length === 0 && successResult.message) {
        toast({
          title: "No documents yet",
          description: successResult.message,
        });
      }
    } catch (error) {
      console.error("Error fetching documents:", error);
      const networkError: ApiError = {
        error: "Network error",
        message:
          "Unable to connect to the server. Please check your internet connection and try again.",
        code: "NETWORK_ERROR",
      };
      setError(networkError);

      toast({
        title: "Connection failed",
        description: networkError.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [appointmentId, toast]);

  // Load existing documents when component mounts or dialog opens
  React.useEffect(() => {
    if (isOpen) {
      fetchDocuments();
    }
  }, [isOpen, appointmentId, fetchDocuments]);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Client-side validation for immediate feedback
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: "File too large",
          description: `The selected file is ${Math.round(file.size / 1024 / 1024)}MB. Please select a file smaller than 10MB.`,
          variant: "destructive",
        });
        return;
      }

      // Check file type
      const allowedTypes = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/gif",
        "text/plain",
      ];

      if (!allowedTypes.includes(file.type)) {
        toast({
          title: "Unsupported file type",
          description: `Please select a PDF, Word document, image (JPG, PNG, GIF), or text file. The file "${file.name}" is not supported.`,
          variant: "destructive",
        });
        return;
      }

      setSelectedFile(file);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      if (description.trim()) {
        formData.append("description", description.trim());
      }
      if (revisionOf) {
        formData.append("responseToDocumentId", revisionOf.id);
      }

      const response = await fetch(
        `/api/appointments/${appointmentId}/documents`,
        {
          method: "POST",
          body: formData,
        },
      );

      const result: ApiResponse | ApiError = await response.json();

      if (!response.ok) {
        const errorResult = result as ApiError;

        // Show specific error messages based on error codes
        let toastTitle = "Upload failed";
        let toastDescription = errorResult.message;

        switch (errorResult.code) {
          case "FILE_TOO_LARGE":
            toastTitle = "File too large";
            break;
          case "UNSUPPORTED_FILE_TYPE":
            toastTitle = "Unsupported file type";
            break;
          case "NETWORK_ERROR":
            toastTitle = "Network error";
            break;
          case "STORAGE_ERROR":
            toastTitle = "Storage issue";
            break;
          case "BUCKET_NOT_FOUND":
            toastTitle = "Storage not configured";
            // For bucket errors, show a longer description with instructions
            if ("instructions" in errorResult) {
              toastDescription = `${errorResult.message}\n\n${errorResult.instructions}`;
            }
            break;
          case "NO_FILE":
            toastTitle = "No file selected";
            break;
          default:
            toastTitle = "Upload failed";
        }

        toast({
          title: toastTitle,
          description: toastDescription,
          variant: "destructive",
        });
        return;
      }

      const successResult = result as ApiResponse;

      toast({
        title: "Document uploaded successfully",
        description:
          successResult.message ||
          `${selectedFile.name} has been uploaded and is ready for review.`,
      });

      // Reset form
      setSelectedFile(null);
      setDescription("");
      setRevisionOf(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      // Refresh documents list
      fetchDocuments();
    } catch (error) {
      console.error("Error uploading file:", error);
      toast({
        title: "Network error",
        description:
          "Upload failed due to a connection issue. Please check your internet connection and try again.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteDocument = async (documentId: string) => {
    try {
      const response = await fetch(
        `/api/appointments/${appointmentId}/documents/${documentId}`,
        {
          method: "DELETE",
        },
      );

      const result: ApiResponse | ApiError = await response.json();

      if (!response.ok) {
        const errorResult = result as ApiError;
        toast({
          title: "Delete failed",
          description:
            errorResult.message ||
            "Failed to delete document. Please try again.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Document deleted",
        description: "Document has been deleted successfully",
      });

      // Refresh documents list
      fetchDocuments();
    } catch (error) {
      console.error("Error deleting document:", error);
      toast({
        title: "Network error",
        description:
          "Delete failed due to a connection issue. Please try again.",
        variant: "destructive",
      });
    }
  };

  const getErrorIcon = (errorCode?: string) => {
    switch (errorCode) {
      case "CONNECTION_ERROR":
      case "NETWORK_ERROR":
        return <WifiOff className="h-5 w-5" />;
      case "DATABASE_ERROR":
      case "STORAGE_ERROR":
        return <Database className="h-5 w-5" />;
      case "NOT_FOUND":
        return <HelpCircle className="h-5 w-5" />;
      default:
        return <AlertCircle className="h-5 w-5" />;
    }
  };

  const renderErrorState = () => {
    if (!error) return null;

    return (
      <Alert className="mb-4" variant="destructive">
        <div className="flex items-start space-x-2">
          {getErrorIcon(error.code)}
          <div className="flex-1">
            <AlertTitle className="text-sm font-medium">
              {error.error}
            </AlertTitle>
            <AlertDescription className="text-sm mt-1">
              {error.message}
            </AlertDescription>
            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={fetchDocuments}
                disabled={isLoading}
              >
                <RefreshCw
                  className={`h-4 w-4 mr-1 ${isLoading ? "animate-spin" : ""}`}
                />
                Try Again
              </Button>
              {error.code === "NOT_FOUND" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleOpenChange(false)}
                >
                  Close
                </Button>
              )}
            </div>
          </div>
        </div>
      </Alert>
    );
  };

  return (
    <ResponsiveModal open={isOpen} onOpenChange={handleOpenChange}>
      {!defaultOpen && (
        <ResponsiveModalTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-full bg-muted hover:bg-muted/80 text-foreground border-border"
          >
            <Upload className="h-4 w-4 mr-2" />
            Upload Documents
          </Button>
        </ResponsiveModalTrigger>
      )}
      <ResponsiveModalContent className="max-w-[90vw] sm:max-w-[500px] lg:max-w-[600px] max-h-[85vh] overflow-y-auto p-4 sm:p-6">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Upload Documents</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            Upload documents for review for your {appointmentType.toLowerCase()}
            : {contextInfo.appointmentTitle || appointmentTitle}
            {contextInfo.consultantName && (
              <span className="block mt-1 text-sm text-muted-foreground">
                Consultant: {contextInfo.consultantName}
              </span>
            )}
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>

        <div className="space-y-4 sm:space-y-6">
          {renderErrorState()}

          {/* Upload New Document - Hide if there's a critical error */}
          {(!error || error.code !== "NOT_FOUND") && (
            <Card>
              <CardHeader className="pb-3 sm:pb-6">
                <CardTitle className="text-base sm:text-lg">
                  Upload New Document
                </CardTitle>
                <CardDescription className="text-xs sm:text-sm">
                  Select a document to upload for review (PDF, Word, Images,
                  Text files - Max 10MB)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Replacing a specific file is a different act from adding a
                    new one, and the form looks identical either way — say
                    which, and give a way out. */}
                {revisionOf && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
                    <Reply className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground">
                        Uploading a revision
                      </p>
                      <p className="text-muted-foreground truncate">
                        Replaces &ldquo;{revisionOf.originalName}&rdquo;. The
                        original stays on file with its review notes.
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0"
                      onClick={() => setRevisionOf(null)}
                      disabled={isUploading}
                    >
                      Cancel
                    </Button>
                  </div>
                )}

                <div>
                  <Input
                    ref={fileInputRef}
                    type="file"
                    onChange={handleFileSelect}
                    accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.txt"
                    className="cursor-pointer"
                    disabled={isUploading}
                  />
                </div>

                {selectedFile && (
                  <div className="bg-muted p-3 rounded-lg">
                    <div className="flex items-center space-x-3">
                      <FileText className="h-8 w-8 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs sm:text-sm font-medium text-foreground truncate max-w-[200px] sm:max-w-none">
                          {selectedFile.name.length > 30
                            ? `${selectedFile.name.substring(0, 30)}...`
                            : selectedFile.name}
                        </p>
                        <p className="text-xs sm:text-sm text-muted-foreground">
                          {formatFileSize(selectedFile.size)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelectedFile(null);
                          setRevisionOf(null);
                          if (fileInputRef.current)
                            fileInputRef.current.value = "";
                        }}
                        disabled={isUploading}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-xs sm:text-sm font-medium">
                    Description (Optional)
                  </label>
                  <Textarea
                    placeholder="Describe what this document is (e.g., Resume, ITR, Legal document, etc.)"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="mt-1 text-xs sm:text-sm"
                    disabled={isUploading}
                    rows={2}
                  />
                </div>

                <Button
                  onClick={handleUpload}
                  disabled={!selectedFile || isUploading}
                  className="w-full"
                >
                  {isUploading ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    "Upload Document"
                  )}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Existing Documents */}
          <Card>
            <CardHeader className="pb-3 sm:pb-6">
              <CardTitle className="text-base sm:text-lg">
                Uploaded Documents
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                {contextInfo.message ||
                  "Documents you've uploaded for this appointment"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="text-center py-8">
                  <RefreshCw className="h-8 w-8 text-muted-foreground mx-auto animate-spin mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Loading your documents...
                  </p>
                </div>
              ) : error && error.code === "NOT_FOUND" ? (
                <div className="text-center py-8">
                  <HelpCircle className="h-12 w-12 text-muted-foreground/70 mx-auto mb-4" />
                  <p className="text-sm text-muted-foreground mb-2">
                    Unable to load documents
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    Please check your appointment details
                  </p>
                </div>
              ) : documents.length === 0 ? (
                <div className="text-center py-8">
                  <FileText className="h-12 w-12 text-muted-foreground/70 mx-auto mb-4" />
                  <p className="text-sm text-muted-foreground mb-2">
                    No documents uploaded yet
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    Upload your first document to get feedback from{" "}
                    {contextInfo.consultantName || "your consultant"}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Filter to only show consultee documents (responses are shown nested) */}
                  {documents
                    .filter(
                      (doc) =>
                        !doc.uploadedByRole ||
                        doc.uploadedByRole === "CONSULTEE",
                    )
                    .map((doc) => (
                      <div
                        key={doc.id}
                        className="border border-border rounded-lg p-3 sm:p-4 hover:bg-muted transition-colors"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between space-y-3 sm:space-y-0">
                          <div className="flex items-start space-x-3 flex-1 min-w-0">
                            <FileText className="h-6 w-6 sm:h-8 sm:w-8 text-muted-foreground/70 flex-shrink-0 mt-1" />
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-xs sm:text-sm font-medium text-foreground truncate max-w-[180px] sm:max-w-[250px]">
                                  {doc.originalName.length > 25
                                    ? `${doc.originalName.substring(0, 25)}...`
                                    : doc.originalName}
                                </p>
                                <div className="flex items-center gap-1">
                                  {getStatusIcon(doc.reviewStatus)}
                                  <Badge
                                    variant="secondary"
                                    className={`${getStatusColor(doc.reviewStatus)} text-xs`}
                                  >
                                    {doc.reviewStatus.replace("_", " ")}
                                  </Badge>
                                  {(doc.versionNo ?? 1) > 1 && (
                                    <Badge
                                      variant="outline"
                                      className="text-xs"
                                      title={
                                        doc.uploadedByRole === "CONSULTANT"
                                          ? `Consultant response #${doc.versionNo} in this review thread`
                                          : `Revision v${doc.versionNo}`
                                      }
                                    >
                                      {doc.uploadedByRole === "CONSULTANT"
                                        ? `response #${doc.versionNo}`
                                        : `v${doc.versionNo}`}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              {doc.description && (
                                <p className="text-sm text-muted-foreground mt-1">
                                  {doc.description}
                                </p>
                              )}
                              <div className="flex items-center space-x-4 mt-2 text-xs text-muted-foreground/70">
                                <span>{formatFileSize(doc.fileSize)}</span>
                                <span>
                                  Uploaded{" "}
                                  {new Date(
                                    doc.uploadedAt,
                                  ).toLocaleDateString()}
                                </span>
                                {doc.reviewedAt && (
                                  <span>
                                    Reviewed{" "}
                                    {new Date(
                                      doc.reviewedAt,
                                    ).toLocaleDateString()}
                                  </span>
                                )}
                              </div>
                              {doc.reviewNotes && (
                                <div className="mt-2 p-2 bg-muted rounded text-sm border border-border">
                                  <p className="font-medium text-foreground">
                                    Review Notes:
                                  </p>
                                  <p className="text-muted-foreground">
                                    {doc.reviewNotes}
                                  </p>
                                </div>
                              )}
                              {/* The loop used to end here: the learner could
                                  read WHAT to fix but had no way to act on it,
                                  because the only action was delete-while-
                                  PENDING. This is the way back in. */}
                              {doc.reviewStatus === "NEEDS_REVISION" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="mt-2"
                                  onClick={() => {
                                    setRevisionOf(doc);
                                    setIsOpen(true);
                                    fileInputRef.current?.click();
                                  }}
                                >
                                  <Upload className="h-3 w-3 mr-1.5" />
                                  Upload revision
                                </Button>
                              )}
                            </div>
                          </div>
                          <div className="flex space-x-1 ml-0 sm:ml-4 justify-end sm:justify-start">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => window.open(doc.fileUrl, "_blank")}
                              title="View document"
                              className="h-7 w-7 sm:h-9 sm:w-9 p-0"
                            >
                              <Eye className="h-3 w-3 sm:h-4 sm:w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                // Use our download API endpoint instead of direct Supabase URL
                                const downloadUrl = `/api/appointments/${appointmentId}/documents/${doc.id}/download`;
                                const link = window.document.createElement("a");
                                link.href = downloadUrl;
                                link.download = doc.originalName;
                                window.document.body.appendChild(link);
                                link.click();
                                window.document.body.removeChild(link);
                              }}
                              title="Download document"
                              className="h-7 w-7 sm:h-9 sm:w-9 p-0"
                            >
                              <Download className="h-3 w-3 sm:h-4 sm:w-4" />
                            </Button>
                            {doc.reviewStatus === "PENDING" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteDocument(doc.id)}
                                className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 h-7 w-7 sm:h-9 sm:w-9 p-0"
                                title="Delete document (only available for pending documents)"
                              >
                                <X className="h-3 w-3 sm:h-4 sm:w-4" />
                              </Button>
                            )}
                          </div>
                        </div>

                        {/* Threaded children. Since revisions were added, this
                            list holds BOTH the consultant's replies and the
                            learner's own re-uploads, so the old fixed
                            "Consultant Response" heading labelled a learner's
                            revision as a consultant reply. Name it for what
                            the thread actually contains. */}
                        {doc.responseDocuments &&
                          doc.responseDocuments.length > 0 && (
                            <div className="mt-3 pl-4 sm:pl-8 border-l-2 border-border">
                              <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                                <Reply className="h-3 w-3" />
                                <span className="font-medium">
                                  {(() => {
                                    const kinds = new Set(
                                      doc.responseDocuments.map((r) =>
                                        r.uploadedByRole === "CONSULTEE"
                                          ? "revision"
                                          : "response",
                                      ),
                                    );
                                    const n = doc.responseDocuments.length;
                                    if (kinds.size > 1) return "Follow-up documents";
                                    return kinds.has("revision")
                                      ? `Your revision${n > 1 ? "s" : ""}`
                                      : `Consultant response${n > 1 ? "s" : ""}`;
                                  })()}
                                </span>
                              </div>
                              <div className="space-y-2">
                                {doc.responseDocuments.map((response) => (
                                  <div
                                    key={response.id}
                                    className="bg-muted rounded-lg p-2 sm:p-3"
                                  >
                                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                                      <div className="flex items-start space-x-2 flex-1 min-w-0">
                                        <UserCircle className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                                        <div className="flex-1 min-w-0">
                                          <p className="text-xs sm:text-sm font-medium text-foreground truncate">
                                            {response.originalName.length > 30
                                              ? `${response.originalName.substring(0, 30)}...`
                                              : response.originalName}
                                          </p>
                                          {response.description && (
                                            <p className="text-xs text-muted-foreground mt-0.5">
                                              {response.description}
                                            </p>
                                          )}
                                          <div className="flex items-center space-x-3 mt-1 text-xs text-muted-foreground/70">
                                            <span>
                                              {formatFileSize(
                                                response.fileSize,
                                              )}
                                            </span>
                                            <span>
                                              {new Date(
                                                response.uploadedAt,
                                              ).toLocaleDateString()}
                                            </span>
                                          </div>
                                        </div>
                                      </div>
                                      <div className="flex space-x-1 justify-end">
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() =>
                                            window.open(
                                              response.fileUrl,
                                              "_blank",
                                            )
                                          }
                                          title="View response"
                                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                        >
                                          <Eye className="h-3 w-3" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => {
                                            const downloadUrl = `/api/appointments/${appointmentId}/documents/${response.id}/download`;
                                            const link =
                                              window.document.createElement(
                                                "a",
                                              );
                                            link.href = downloadUrl;
                                            link.download =
                                              response.originalName;
                                            window.document.body.appendChild(
                                              link,
                                            );
                                            link.click();
                                            window.document.body.removeChild(
                                              link,
                                            );
                                          }}
                                          title="Download response"
                                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                        >
                                          <Download className="h-3 w-3" />
                                        </Button>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
