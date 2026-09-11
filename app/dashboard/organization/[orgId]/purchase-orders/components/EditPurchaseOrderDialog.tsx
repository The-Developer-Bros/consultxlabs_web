"use client";

/**
 * Dialog for editing a PurchaseOrder.
 *
 * The PO row hydrates the form on open. Remaining amount can be
 * adjusted independently of total — invoice issuance does not
 * auto-decrement, so an operator may need to reconcile manually after
 * a partial fulfilment outside the platform.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { patchPurchaseOrder } from "../utils/api";
import type {
  PatchPurchaseOrderBody,
  PoStatus,
  PurchaseOrderRow,
} from "../utils/types";

interface EditPurchaseOrderDialogProps {
  orgId: string;
  po: PurchaseOrderRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditPurchaseOrderDialog({
  orgId,
  po,
  open,
  onOpenChange,
}: EditPurchaseOrderDialogProps) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PoStatus>("ACTIVE");
  const [poDate, setPoDate] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [totalRupees, setTotalRupees] = useState("");
  const [remainingRupees, setRemainingRupees] = useState("");
  const [uploadedDocUrl, setUploadedDocUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Hydrate form when the target PO changes. useEffect (not useMemo)
  // so the side-effect runs even when only the PO id changes between
  // two rows with the same content.
  useEffect(() => {
    if (!po) return;
    setStatus(po.status);
    setPoDate(po.poDate.slice(0, 10));
    setValidUntil(po.validUntil ? po.validUntil.slice(0, 10) : "");
    setTotalRupees((po.totalAmountPaise / 100).toString());
    setRemainingRupees((po.remainingAmountPaise / 100).toString());
    setUploadedDocUrl(po.uploadedDocUrl ?? "");
    setError(null);
  }, [po]);

  const patchMutation = useMutation({
    mutationFn: (body: PatchPurchaseOrderBody) =>
      patchPurchaseOrder(orgId, po!.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["org-purchase-orders", orgId],
      });
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!po) return null;

  const handleSubmit = () => {
    setError(null);
    if (validUntil && new Date(validUntil) <= new Date(poDate)) {
      setError("Valid-until date must be after the PO date.");
      return;
    }
    const total = Number(totalRupees.replace(/,/g, ""));
    const remaining = Number(remainingRupees.replace(/,/g, ""));
    if (!Number.isFinite(total) || total < 0) {
      setError("Total amount must be ≥ 0.");
      return;
    }
    if (!Number.isFinite(remaining) || remaining < 0) {
      setError("Remaining amount must be ≥ 0.");
      return;
    }
    if (remaining > total) {
      setError("Remaining amount cannot exceed total amount.");
      return;
    }
    const body: PatchPurchaseOrderBody = {
      status,
      poDate: new Date(poDate).toISOString(),
      validUntil: validUntil ? new Date(validUntil).toISOString() : null,
      totalAmountPaise: Math.round(total * 100),
      remainingAmountPaise: Math.round(remaining * 100),
      uploadedDocUrl: uploadedDocUrl.trim() || null,
    };
    patchMutation.mutate(body);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit PO {po.poNumber}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-status">Status</Label>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as PoStatus)}
            >
              <SelectTrigger id="edit-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                <SelectItem value="CLOSED">CLOSED</SelectItem>
                <SelectItem value="CANCELLED">CANCELLED</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-po-date">PO date</Label>
              <Input
                id="edit-po-date"
                type="date"
                value={poDate}
                onChange={(e) => setPoDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-valid-until">Valid until</Label>
              <Input
                id="edit-valid-until"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-total">Total ({po.currency})</Label>
              <Input
                id="edit-total"
                type="text"
                inputMode="decimal"
                value={totalRupees}
                onChange={(e) => setTotalRupees(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-remaining">Remaining ({po.currency})</Label>
              <Input
                id="edit-remaining"
                type="text"
                inputMode="decimal"
                value={remainingRupees}
                onChange={(e) => setRemainingRupees(e.target.value)}
              />
              <p className="text-xs text-zinc-500">
                Invoice issuance doesn’t auto-decrement.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-doc">Uploaded PO document URL</Label>
            <Input
              id="edit-doc"
              type="url"
              value={uploadedDocUrl}
              onChange={(e) => setUploadedDocUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={patchMutation.isPending}>
            {patchMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
