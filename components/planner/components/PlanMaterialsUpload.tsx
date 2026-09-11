"use client";

import * as Sentry from "@sentry/nextjs";
import React, { useState, useRef, useEffect, useCallback } from "react";
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
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  FileText,
  X,
  Eye,
  Download,
  Trash2,
  Loader2,
} from "lucide-react";
import { formatFileSize } from "@/lib/documents/document-utils";
import { MaterialsService, type PlanType } from "../services/materials-service";
import { IPlanMaterial } from "@/types/planner-events";

interface PlanMaterialsUploadProps {
  planType: PlanType;
  planId: string;
  planTitle: string;
  isOpen: boolean;
  onClose: () => void;
  onMaterialsChange?: () => void;
}

// File type icons mapping
const getFileIcon = (mimeType: string) => {
  if (mimeType.includes("pdf")) return "PDF";
  if (mimeType.includes("word") || mimeType.includes("document")) return "DOC";
  if (mimeType.includes("excel") || mimeType.includes("spreadsheet"))
    return "XLS";
  if (mimeType.includes("powerpoint") || mimeType.includes("presentation"))
    return "PPT";
  if (mimeType.includes("image")) return "IMG";
  if (mimeType.includes("text")) return "TXT";
  if (mimeType.includes("zip") || mimeType.includes("rar")) return "ZIP";
  return "FILE";
};

export function PlanMaterialsUpload({
  planType,
  planId,
  planTitle,
  isOpen,
  onClose,
  onMaterialsChange,
}: PlanMaterialsUploadProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [materials, setMaterials] = useState<IPlanMaterial[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch materials when dialog opens
  const fetchMaterials = useCallback(async () => {
    if (!planId) return;

    setIsLoading(true);
    try {
      const data = await MaterialsService.getMaterials(planType, planId);
      setMaterials(data);
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Error fetching materials:", error);
      toast({
        title: "Error",
        description: "Failed to load materials. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [planId, planType, toast]);

  useEffect(() => {
    if (isOpen && planId) {
      fetchMaterials();
    }
  }, [isOpen, planId, fetchMaterials]);

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
      await MaterialsService.uploadMaterial(
        planType,
        planId,
        selectedFile,
        description || undefined,
      );

      toast({
        title: "Material uploaded",
        description: `${selectedFile.name} has been uploaded successfully.`,
      });

      // Reset form
      setSelectedFile(null);
      setDescription("");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      // Refresh materials list
      await fetchMaterials();
      onMaterialsChange?.();
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Upload error:", error);
      toast({
        title: "Upload failed",
        description:
          error instanceof Error ? error.message : "Failed to upload file",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (materialId: string, fileName: string) => {
    setDeletingId(materialId);
    try {
      await MaterialsService.deleteMaterial(materialId);

      toast({
        title: "Material deleted",
        description: `${fileName} has been deleted.`,
      });

      // Refresh materials list
      await fetchMaterials();
      onMaterialsChange?.();
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Delete error:", error);
      toast({
        title: "Delete failed",
        description:
          error instanceof Error ? error.message : "Failed to delete material",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleView = (material: IPlanMaterial) => {
    window.open(material.fileUrl, "_blank");
  };

  const handleDownload = (material: IPlanMaterial) => {
    const link = document.createElement("a");
    link.href = material.fileUrl;
    link.download = material.originalName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const clearFile = () => {
    setSelectedFile(null);
    setDescription("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[600px] max-h-[90dvh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Plan Materials</DialogTitle>
          <DialogDescription>
            Upload materials for &ldquo;{planTitle}&rdquo;. These materials will
            be available to all participants.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-4">
          {/* Upload Section */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium">Upload New Material</h3>

            {/* File Input */}
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
                  onClick={clearFile}
                  className="shrink-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>

            {selectedFile && (
              <>
                <div className="text-sm text-muted-foreground">
                  Selected: {selectedFile.name} (
                  {formatFileSize(selectedFile.size)})
                </div>

                <Textarea
                  placeholder="Add a description (optional)"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="min-h-[80px]"
                />

                <Button
                  onClick={handleUpload}
                  disabled={isUploading}
                  className="w-full"
                >
                  {isUploading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <Upload className="mr-2 h-4 w-4" />
                      Upload Material
                    </>
                  )}
                </Button>
              </>
            )}
          </div>

          {/* Materials List */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium">
              Uploaded Materials ({materials.length})
            </h3>

            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : materials.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No materials uploaded yet</p>
                <p className="text-sm">
                  Upload PDFs, documents, or images for your participants
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {materials.map((material) => (
                  <Card key={material.id}>
                    <CardContent className="p-3">
                      <div className="flex items-center gap-3">
                        <div className="flex-shrink-0 w-10 h-10 bg-muted rounded flex items-center justify-center text-xs font-medium">
                          {getFileIcon(material.mimeType)}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">
                            {material.originalName}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {formatFileSize(material.fileSize)}
                            {material.description && (
                              <> &bull; {material.description}</>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleView(material)}
                            title="View"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDownload(material)}
                            title="Download"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              handleDelete(material.id, material.originalName)
                            }
                            disabled={deletingId === material.id}
                            title="Delete"
                            className="text-destructive hover:text-destructive"
                          >
                            {deletingId === material.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t pt-4">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
