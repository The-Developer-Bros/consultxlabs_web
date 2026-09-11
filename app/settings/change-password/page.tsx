"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { authClient } from "@/lib/auth-client";
import { GlobeIcon } from "@/components/auth/auth-icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ChangePasswordPage() {
  const { toast } = useToast();
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword.length < 8) {
      toast({
        title: "Password Too Short",
        description: "New password must be at least 8 characters.",
        variant: "destructive",
      });
      return;
    }

    if (newPassword !== confirmPassword) {
      toast({
        title: "Passwords do not match",
        description: "New password and confirmation must match.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    toast({ title: "Changing password..." });

    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
      });

      if (error) {
        toast({
          title: "Password Change Failed",
          description: error.message || "An unexpected error occurred.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Password Changed",
          description: "Your password has been updated successfully.",
        });
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        router.push("/dashboard");
      }
    } catch (error: unknown) {
      console.error("Change password error:", error);
      const message =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred.";
      toast({
        title: "Password Change Failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted px-4 dark:bg-gray-950">
      <div className="w-full max-w-md p-8 space-y-6 bg-card rounded-lg shadow-md dark:bg-gray-900">
        <div className="text-center">
          <GlobeIcon className="mx-auto h-12 w-auto text-foreground dark:text-gray-100" />
          <h2 className="mt-6 text-fluid-3xl font-extrabold tracking-tight text-foreground dark:text-white">
            Change Password
          </h2>
          <p className="mt-2 text-sm text-muted-foreground dark:text-gray-400">
            Enter your current password and choose a new one.
          </p>
        </div>

        <form className="space-y-6" onSubmit={handleChangePassword}>
          <div>
            <Label htmlFor="current-password">Current Password</Label>
            <Input
              id="current-password"
              name="current-password"
              type="password"
              required
              className="mt-1 appearance-none rounded-md relative block w-full px-3 py-2 border border-border dark:border-gray-700 placeholder:text-muted-foreground dark:placeholder-gray-400 text-foreground dark:text-white focus:outline-none focus:ring-ring focus:border-ring focus:z-10 sm:text-sm"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={isLoading}
            />
          </div>

          <div>
            <Label htmlFor="new-password">New Password</Label>
            <Input
              id="new-password"
              name="new-password"
              type="password"
              required
              className="mt-1 appearance-none rounded-md relative block w-full px-3 py-2 border border-border dark:border-gray-700 placeholder:text-muted-foreground dark:placeholder-gray-400 text-foreground dark:text-white focus:outline-none focus:ring-ring focus:border-ring focus:z-10 sm:text-sm"
              placeholder="New password (min 8 characters)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={isLoading}
            />
          </div>

          <div>
            <Label htmlFor="confirm-new-password">Confirm New Password</Label>
            <Input
              id="confirm-new-password"
              name="confirm-new-password"
              type="password"
              required
              className="mt-1 appearance-none rounded-md relative block w-full px-3 py-2 border border-border dark:border-gray-700 placeholder:text-muted-foreground dark:placeholder-gray-400 text-foreground dark:text-white focus:outline-none focus:ring-ring focus:border-ring focus:z-10 sm:text-sm"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={isLoading}
            />
          </div>

          <div>
            <Button
              type="submit"
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-primary-foreground bg-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring"
              disabled={isLoading}
            >
              {isLoading ? "Changing..." : "Change Password"}
            </Button>
          </div>
        </form>

        <div className="text-sm text-center">
          <Link
            href="/dashboard"
            className="font-medium text-foreground hover:text-muted-foreground"
          >
            Back to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
