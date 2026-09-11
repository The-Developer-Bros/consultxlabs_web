"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CertificationSchema } from "@/schemas/user";
import { Certification } from "./CertificationsSection";

interface AddCertificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (certification: Certification | Omit<Certification, "id">) => void;
  certification?: Certification | null;
}

export function AddCertificationModal({
  isOpen,
  onClose,
  onSave,
  certification,
}: AddCertificationModalProps) {
  const [formData, setFormData] = useState({
    name: "",
    issuingOrganization: "",
    issueDate: "",
    expiryDate: "",
    credentialId: "",
    credentialUrl: "",
  });

  const isEditing = !!certification;

  useEffect(() => {
    if (certification) {
      setFormData({
        name: certification.name,
        issuingOrganization: certification.issuingOrganization,
        issueDate: certification.issueDate
          ? new Date(certification.issueDate).toISOString().split("T")[0]
          : "",
        expiryDate: certification.expiryDate
          ? new Date(certification.expiryDate).toISOString().split("T")[0]
          : "",
        credentialId: certification.credentialId || "",
        credentialUrl: certification.credentialUrl || "",
      });
    } else {
      setFormData({
        name: "",
        issuingOrganization: "",
        issueDate: "",
        expiryDate: "",
        credentialId: "",
        credentialUrl: "",
      });
    }
  }, [certification, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const data = {
      ...(certification?.id ? { id: certification.id } : {}),
      name: formData.name,
      issuingOrganization: formData.issuingOrganization,
      issueDate: new Date(formData.issueDate),
      expiryDate: formData.expiryDate
        ? new Date(formData.expiryDate)
        : undefined,
      credentialId: formData.credentialId || undefined,
      credentialUrl: formData.credentialUrl || undefined,
    };

    const validated = CertificationSchema.parse(data);
    onSave(validated);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Certification" : "Add Certification"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update your certification details"
              : "Add details about your professional certification"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Certification Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                placeholder="e.g., AWS Solutions Architect"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="issuingOrganization">
                Issuing Organization *
              </Label>
              <Input
                id="issuingOrganization"
                value={formData.issuingOrganization}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    issuingOrganization: e.target.value,
                  })
                }
                placeholder="e.g., Amazon Web Services"
                required
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="issueDate">Issue Date *</Label>
                <Input
                  id="issueDate"
                  type="date"
                  value={formData.issueDate}
                  onChange={(e) =>
                    setFormData({ ...formData, issueDate: e.target.value })
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="expiryDate">Expiry Date</Label>
                <Input
                  id="expiryDate"
                  type="date"
                  value={formData.expiryDate}
                  onChange={(e) =>
                    setFormData({ ...formData, expiryDate: e.target.value })
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="credentialId">Credential ID</Label>
              <Input
                id="credentialId"
                value={formData.credentialId}
                onChange={(e) =>
                  setFormData({ ...formData, credentialId: e.target.value })
                }
                placeholder="e.g., ABC123XYZ"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="credentialUrl">Credential URL</Label>
              <Input
                id="credentialUrl"
                type="url"
                value={formData.credentialUrl}
                onChange={(e) =>
                  setFormData({ ...formData, credentialUrl: e.target.value })
                }
                placeholder="https://..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">{isEditing ? "Save Changes" : "Add"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
