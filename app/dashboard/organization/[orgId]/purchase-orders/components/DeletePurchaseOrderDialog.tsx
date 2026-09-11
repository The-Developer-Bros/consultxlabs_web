"use client";

/**
 * Confirmation dialog for the narrow PO delete path.
 *
 * The server-side guard rejects deletion of a PO referenced by any
 * Contract or Invoice (409). The client surfaces the message verbatim.
 * For referenced POs the user should mark CANCELLED via Edit instead.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { deletePurchaseOrder } from "../utils/api";
import type { PurchaseOrderRow } from "../utils/types";

interface DeletePurchaseOrderDialogProps {
  orgId: string;
  po: PurchaseOrderRow | null;
  onClose: () => void;
  onError: (msg: string) => void;
}

export function DeletePurchaseOrderDialog({
  orgId,
  po,
  onClose,
  onError,
}: DeletePurchaseOrderDialogProps) {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: (poId: string) => deletePurchaseOrder(orgId, poId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["org-purchase-orders", orgId],
      });
      onClose();
    },
    onError: (err: Error) => onError(err.message),
  });

  return (
    <AlertDialog open={!!po} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete PO?</AlertDialogTitle>
          <AlertDialogDescription>
            Permanently delete PO{" "}
            <span className="font-medium">{po?.poNumber}</span>? This is
            only possible because no contracts or invoices reference it.
            If you change your mind later you’ll need to register a new
            PO number.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 hover:bg-red-700 text-white"
            onClick={() => {
              if (!po) return;
              deleteMutation.mutate(po.id);
            }}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
