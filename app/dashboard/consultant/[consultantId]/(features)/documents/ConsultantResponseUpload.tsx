"use client";

import * as Sentry from "@sentry/nextjs";
import React, { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Upload, X, FileText, Loader2 } from "lucide-react";
import { formatFileSize } from "@/lib/documents/document-utils";
import { ConsultantDocumentService } from "@/components/planner/services/materials-service";
import { IDocument } from "../../types";

interface ConsultantResponseUploadProps {
  appointmentId: string;
  responseToDocument?: IDocument | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function ConsultantResponseUpload({
  appointmentId,
  responseToDocument,
  isOpen,
  onClose,
  onSuccess,
}: ConsultantResponseUploadProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file size (10MB limit)
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: "File too large",
          description: "Please select a file smaller than 10MB",
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
      await ConsultantDocumentService.uploadResponseDocument(
        appointmentId,
        selectedFile,
        {
          description: description || undefined,
          responseToDocumentId: responseToDocument?.id,
        },
      );

      toast({
        title: "Document uploaded",
        description: responseToDocument
          ? `Response to "${responseToDocument.originalName}" has been uploaded.`
          : `${selectedFile.name} has been uploaded successfully.`,
      });

      // Reset form and close
      clearForm();
      onClose();
      onSuccess?.();
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Upload error:", error);
      toast({
        title: "Upload failed",
        description:
          error instanceof Error ? error.message : "Failed to upload document",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const clearForm = () => {
    setSelectedFile(null);
    setDescription("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleClose = () => {
    clearForm();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[500px] max-h-[90dvh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {responseToDocument
              ? "Upload Response Document"
              : "Upload Document"}
          </DialogTitle>
          <DialogDescription>
            {responseToDocument
              ? `Upload a document in response to "${responseToDocument.originalName}"`
              : "Upload a document for this appointment"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
          {/* Show original document info if this is a response */}
          {responseToDocument && (
            <div className="bg-muted p-3 rounded-lg">
              <div className="text-sm font-medium text-muted-foreground mb-1">
                Responding to:
              </div>
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">
                  {responseToDocument.originalName}
                </span>
                <span className="text-xs text-muted-foreground">
                  ({formatFileSize(responseToDocument.fileSize)})
                </span>
              </div>
              {responseToDocument.description && (
                <p className="text-xs text-muted-foreground mt-1">
                  {responseToDocument.description}
                </p>
              )}
            </div>
          )}

          {/* File Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Select File</label>
            <div className="flex items-center gap-2">
              <Input
                ref={fileInputRef}
                type="file"
                onChange={handleFileSelect}
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.gif,.txt,.csv,.md,.zip,.rar"
                className="flex-1"
              />
              {selectedFile && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={clearForm}
                  className="shrink-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Supported: PDF, Office documents, images, text files (max 10MB)
            </p>
          </div>

          {selectedFile && (
            <>
              <div className="text-sm bg-muted p-2 rounded">
                <span className="font-medium">{selectedFile.name}</span>
                <span className="text-muted-foreground ml-2">
                  ({formatFileSize(selectedFile.size)})
                </span>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Description (optional)
                </label>
                <Textarea
                  placeholder="Add a description or notes about this document..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="min-h-[80px]"
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isUploading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={!selectedFile || isUploading}
          >
            {isUploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Upload
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
