"use client";

/**
 * Dialog for creating a PurchaseOrder.
 *
 * Caller (PurchaseOrdersPage) owns the open/close state. The dialog
 * owns its own form state and resets it on close. On success we
 * invalidate the org-purchase-orders React Query cache so the list
 * refetches without a manual reload.
 *
 * Server contract: POST /api/organizations/[orgId]/billing-account/
 * purchase-orders. The `poNumber` is caller-issued and unique per org.
 * Currency stored in paise — we accept rupees from the form and convert
 * at the boundary.
 */

import { useState } from "react";
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

import { createPurchaseOrder } from "../utils/api";
import type { CreatePurchaseOrderBody, PoCurrency } from "../utils/types";

interface CreatePurchaseOrderDialogProps {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreatePurchaseOrderDialog({
  orgId,
  open,
  onOpenChange,
}: CreatePurchaseOrderDialogProps) {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [poNumber, setPoNumber] = useState("");
  const [poDate, setPoDate] = useState(today);
  const [validUntil, setValidUntil] = useState("");
  const [totalRupees, setTotalRupees] = useState("");
  const [currency, setCurrency] = useState<PoCurrency>("INR");
  const [uploadedDocUrl, setUploadedDocUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPoNumber("");
    setPoDate(today);
    setValidUntil("");
    setTotalRupees("");
    setCurrency("INR");
    setUploadedDocUrl("");
    setError(null);
  };

  const createMutation = useMutation({
    mutationFn: (body: CreatePurchaseOrderBody) =>
      createPurchaseOrder(orgId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["org-purchase-orders", orgId],
      });
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    if (!poNumber.trim()) {
      setError("PO number is required.");
      return;
    }
    const numeric = Number(totalRupees.replace(/,/g, ""));
    if (!Number.isFinite(numeric) || numeric <= 0) {
      setError("Total amount must be a positive number.");
      return;
    }
    if (validUntil && new Date(validUntil) <= new Date(poDate)) {
      setError("Valid-until date must be after the PO date.");
      return;
    }
    // Round at the boundary so we never send fractional paise.
    const totalPaise = Math.round(numeric * 100);
    createMutation.mutate({
      poNumber: poNumber.trim(),
      poDate: new Date(poDate).toISOString(),
      validUntil: validUntil ? new Date(validUntil).toISOString() : null,
      totalAmountPaise: totalPaise,
      currency,
      uploadedDocUrl: uploadedDocUrl.trim() || null,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Purchase Order</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="po-number">PO number *</Label>
            <Input
              id="po-number"
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              placeholder="e.g. PO-2026-0042"
              maxLength={64}
            />
            <p className="text-xs text-zinc-500">
              Use the number your AP team issued. Must be unique within
              this org.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="po-date">PO date *</Label>
              <Input
                id="po-date"
                type="date"
                value={poDate}
                onChange={(e) => setPoDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="valid-until">Valid until</Label>
              <Input
                id="valid-until"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
              <p className="text-xs text-zinc-500">Optional</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="total-amount">Total amount *</Label>
              <Input
                id="total-amount"
                type="text"
                inputMode="decimal"
                value={totalRupees}
                onChange={(e) => setTotalRupees(e.target.value)}
                placeholder="0.00"
              />
              <p className="text-xs text-zinc-500">
                Stored in paise. Will be rounded.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="currency">Currency</Label>
              <Select
                value={currency}
                onValueChange={(v) => setCurrency(v as PoCurrency)}
              >
                <SelectTrigger id="currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="INR">INR</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                  <SelectItem value="GBP">GBP</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="uploaded-doc">Uploaded PO document URL</Label>
            <Input
              id="uploaded-doc"
              type="url"
              value={uploadedDocUrl}
              onChange={(e) => setUploadedDocUrl(e.target.value)}
              placeholder="https://…"
            />
            <p className="text-xs text-zinc-500">
              Optional link to the signed PO PDF in your document store.
            </p>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Creating…
              </>
            ) : (
              "Create PO"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
