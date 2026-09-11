"use client";

import Image from "next/image";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authClient, signOut, useSession } from "@/lib/auth-client";
import { AUTH_PROVIDERS, AuthProviderId } from "@/lib/auth-providers";
import { PROVIDER_ICONS } from "@/components/auth/auth-icons";
import { useRouter } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  User as UserIcon,
  Settings,
  Trash2,
  Phone,
  MapPin,
  Cookie,
  Bell,
  AtSign,
  MessageSquare,
  Sparkles,
  LogOut,
  Shield,
  Camera,
  Upload,
  Link2,
  Check,
  X,
  Loader2,
} from "lucide-react";
import { motion } from "framer-motion";

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

const staggerChildren = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

interface LinkedAccount {
  id: string;
  provider: string;
  accountId: string;
}

export default function Profile() {
  const { data: session } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const [name, setName] = useState(session?.user?.name ?? "");
  const [phone, setPhone] = useState(session?.user?.phone ?? "");
  const [address, setAddress] = useState(session?.user?.address ?? "");

  // Profile picture state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);

  // Connected accounts state
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);

  // Logout all devices state
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // Delete account state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState("");
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // Cookie preferences state
  const [cookieAnalytics, setCookieAnalytics] = useState(false);
  const [cookieMarketing, setCookieMarketing] = useState(false);
  const [isSavingCookies, setIsSavingCookies] = useState(false);

  // Notification preferences state
  const [notifAll, setNotifAll] = useState(true);
  const [notifMentions, setNotifMentions] = useState(false);
  const [notifDirect, setNotifDirect] = useState(false);
  const [notifUpdates, setNotifUpdates] = useState(false);
  const [isSavingNotifs, setIsSavingNotifs] = useState(false);

  // Sync form state when session loads
  useEffect(() => {
    if (session?.user) {
      setName(session.user.name ?? "");
      setPhone(session.user.phone ?? "");
      setAddress(session.user.address ?? "");
    }
  }, [session?.user]);

  // Load cookie and notification preferences
  useEffect(() => {
    async function loadPreferences() {
      const [cookieResult, notifResult] = await Promise.allSettled([
        fetch("/api/user/cookie-preferences"),
        fetch("/api/user/notification-preferences"),
      ]);

      if (cookieResult.status === "fulfilled" && cookieResult.value.ok) {
        try {
          const { data } = await cookieResult.value.json();
          setCookieAnalytics(data.analytics);
          setCookieMarketing(data.marketing);
        } catch (e) {
          console.error("Failed to parse cookie preferences:", e);
        }
      }

      if (notifResult.status === "fulfilled" && notifResult.value.ok) {
        try {
          const { data } = await notifResult.value.json();
          setNotifAll(data.allNotifications);
          setNotifMentions(data.mentions);
          setNotifDirect(data.directMessages);
          setNotifUpdates(data.updates);
        } catch (e) {
          console.error("Failed to parse notification preferences:", e);
        }
      }
    }
    loadPreferences();
  }, []);

  const saveCookiePreferences = async () => {
    setIsSavingCookies(true);
    try {
      const res = await fetch("/api/user/cookie-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analytics: cookieAnalytics,
          marketing: cookieMarketing,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast({
        title: "Cookie preferences saved",
        description: "Your cookie preferences have been updated.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to save cookie preferences. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSavingCookies(false);
    }
  };

  const saveNotificationPreferences = async () => {
    setIsSavingNotifs(true);
    try {
      const res = await fetch("/api/user/notification-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allNotifications: notifAll,
          mentions: notifMentions,
          directMessages: notifDirect,
          updates: notifUpdates,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast({
        title: "Notification preferences saved",
        description: "Your notification preferences have been updated.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to save notification preferences. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSavingNotifs(false);
    }
  };

  // Load linked accounts
  const loadLinkedAccounts = useCallback(async () => {
    try {
      setIsLoadingAccounts(true);
      const { data, error } = await authClient.listAccounts();
      if (!error && data) {
        setLinkedAccounts(
          data.map((a) => ({
            id: a.id,
            provider: a.providerId,
            accountId: a.accountId,
          })),
        );
      }
    } catch {
      console.error("Failed to load linked accounts");
    } finally {
      setIsLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    loadLinkedAccounts();
  }, [loadLinkedAccounts]);

  const handleUpdateProfile = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/user/${session?.user?.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, address }),
      });

      if (res.ok) {
        const { data: updatedUser } = await res.json();
        setName(updatedUser.name ?? "");
        setPhone(updatedUser.phone ?? "");
        setAddress(updatedUser.address ?? "");
        toast({
          title: "Profile Updated",
          description: "Your profile has been updated successfully.",
        });
      } else {
        toast({
          title: "Error",
          description: "Failed to update profile. Please try again.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("An unexpected error occurred:", error);
      toast({
        title: "Error",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    }
  };

  // Profile picture handlers
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Please select an image under 2MB.",
        variant: "destructive",
      });
      return;
    }

    setSelectedFile(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const handleUploadProfilePicture = async () => {
    if (!selectedFile) return;
    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const res = await fetch("/api/user/profile-image", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (res.ok && data.success) {
        toast({
          title: "Profile Picture Updated",
          description: "Your profile picture has been updated successfully.",
        });
        setUploadDialogOpen(false);
        setSelectedFile(null);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
        router.refresh();
      } else {
        toast({
          title: "Upload Failed",
          description: data.error || "Failed to upload profile picture.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Upload Failed",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteProfilePicture = async () => {
    setIsDeleting(true);
    try {
      const res = await fetch("/api/user/profile-image", { method: "DELETE" });
      const data = await res.json();

      if (res.ok && data.success) {
        toast({
          title: "Profile Picture Removed",
          description: "Your profile picture has been removed.",
        });
        setUploadDialogOpen(false);
        router.refresh();
      } else {
        toast({
          title: "Error",
          description: data.error || "Failed to remove profile picture.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Error",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Connected accounts handlers
  const handleLinkAccount = (providerId: string) => {
    authClient.linkSocial({
      provider: providerId as AuthProviderId,
      callbackURL: "/profile",
    });
  };

  const handleUnlinkAccount = async (providerId: string) => {
    try {
      const { error } = await authClient.unlinkAccount({ providerId });
      if (error) {
        toast({
          title: "Failed to Disconnect",
          description: error.message || "Could not disconnect this account.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Account Disconnected",
          description: `${providerId.charAt(0).toUpperCase() + providerId.slice(1)} account has been disconnected.`,
        });
        loadLinkedAccounts();
      }
    } catch {
      toast({
        title: "Error",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    }
  };

  // Logout all devices handler
  const handleLogoutAllDevices = async () => {
    setIsLoggingOut(true);
    try {
      await authClient.revokeOtherSessions();
      toast({
        title: "Sessions Revoked",
        description: "All other sessions have been revoked. Signing you out...",
      });
      // Small delay to show the toast before signing out
      setTimeout(() => {
        signOut({
          fetchOptions: {
            onSuccess: () => router.push("/auth/signin"),
          },
        });
      }, 1000);
    } catch {
      toast({
        title: "Error",
        description: "Failed to revoke sessions.",
        variant: "destructive",
      });
      setIsLoggingOut(false);
    }
  };

  // Delete account handler
  const handleDeleteAccount = async () => {
    if (deleteConfirmEmail !== session?.user?.email) {
      toast({
        title: "Email Mismatch",
        description: "Please enter your email address exactly to confirm.",
        variant: "destructive",
      });
      return;
    }

    setIsDeletingAccount(true);
    try {
      const res = await fetch(`/api/user/${session?.user?.id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        toast({
          title: "Account Deleted",
          description: "Your account has been permanently deleted.",
        });
        setTimeout(() => {
          signOut({
            fetchOptions: {
              onSuccess: () => router.push("/"),
            },
          });
        }, 1000);
      } else {
        const data = await res.json();
        toast({
          title: "Deletion Failed",
          description: data.error || "Failed to delete account.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Error",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsDeletingAccount(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted pt-20">
      {/* Hero Header */}
      <div className="bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 relative overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:32px_32px]" />
        <div className="max-w-5xl mx-auto px-4 py-12 md:py-16 relative">
          <div className="flex flex-col md:flex-row items-center gap-6">
            <div className="relative group">
              <Avatar className="h-28 w-28 ring-4 ring-zinc-700 ring-offset-4 ring-offset-zinc-900">
                <AvatarImage src={session?.user?.image ?? ""} />
                <AvatarFallback className="bg-zinc-700 text-zinc-200 text-3xl font-semibold">
                  {session?.user?.name?.charAt(0) || "U"}
                </AvatarFallback>
              </Avatar>
              <Dialog
                open={uploadDialogOpen}
                onOpenChange={(open) => {
                  setUploadDialogOpen(open);
                  if (!open) {
                    setSelectedFile(null);
                    if (previewUrl) URL.revokeObjectURL(previewUrl);
                    setPreviewUrl(null);
                  }
                }}
              >
                <DialogTrigger asChild>
                  <button className="absolute bottom-0 right-0 h-10 w-10 rounded-full bg-card text-foreground flex items-center justify-center shadow-lg hover:bg-muted transition-colors">
                    <Camera className="h-5 w-5" />
                  </button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Update Profile Picture</DialogTitle>
                    <DialogDescription>
                      Upload a new profile picture to personalize your account.
                      Max 2MB (JPEG, PNG, WebP).
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col items-center gap-4 py-6">
                    <div className="h-32 w-32 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                      {previewUrl ? (
                        <Image
                          src={previewUrl}
                          alt="Preview"
                          width={128}
                          height={128}
                          className="h-full w-full object-cover"
                          unoptimized
                        />
                      ) : session?.user?.image ? (
                        <Image
                          src={session.user.image}
                          alt="Current"
                          width={128}
                          height={128}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Upload className="h-10 w-10 text-muted-foreground/70" />
                      )}
                    </div>
                    <Input
                      id="profile-picture"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="max-w-xs"
                      onChange={handleFileSelect}
                    />
                  </div>
                  <DialogFooter className="gap-2 sm:gap-0">
                    {session?.user?.image && (
                      <Button
                        variant="destructive"
                        onClick={handleDeleteProfilePicture}
                        disabled={isDeleting || isUploading}
                        className="mr-auto"
                      >
                        {isDeleting ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : null}
                        Remove
                      </Button>
                    )}
                    <DialogClose asChild>
                      <Button variant="outline">Cancel</Button>
                    </DialogClose>
                    <Button
                      className="bg-primary hover:bg-primary/90 text-primary-foreground"
                      onClick={handleUploadProfilePicture}
                      disabled={!selectedFile || isUploading}
                    >
                      {isUploading ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : null}
                      Upload
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
            <div className="text-center md:text-left">
              <h1 className="text-fluid-4xl font-bold tracking-tight text-white mb-2">
                {session?.user?.name || "Welcome"}
              </h1>
              <p className="text-zinc-400 text-lg">
                {session?.user?.email || "Manage your account settings"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <motion.div
        initial="hidden"
        animate="visible"
        variants={staggerChildren}
        className="max-w-5xl mx-auto px-4 py-10 -mt-8"
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          {/* Profile Information */}
          <motion.div variants={fadeInUp} className="h-full">
            <Card className="border-border shadow-sm hover:shadow-md transition-shadow h-full flex flex-col">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center">
                    <UserIcon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">
                      Profile Information
                    </CardTitle>
                    <CardDescription>Your personal details</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 flex-1">
                <div className="flex items-center gap-4 p-4 rounded-xl bg-muted border border-border">
                  <Avatar className="h-14 w-14 ring-2 ring-border">
                    <AvatarImage src={session?.user?.image ?? ""} />
                    <AvatarFallback className="bg-muted text-muted-foreground font-semibold">
                      {session?.user?.name?.charAt(0) || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <p className="font-semibold text-foreground">
                      {session?.user?.name || "Your Name"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {session?.user?.email || "your@email.com"}
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted transition-colors">
                    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center">
                      <MapPin className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-muted-foreground">
                        Address
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {session?.user?.address || "Not provided"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted transition-colors">
                    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-muted-foreground">Phone</p>
                      <p className="text-sm text-muted-foreground">
                        {session?.user?.phone || "Not provided"}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-0 mt-auto">
                <Dialog>
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full border-border hover:bg-muted"
                    >
                      <Settings className="h-4 w-4 mr-2" />
                      Update Information
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>Update Information</DialogTitle>
                      <DialogDescription>
                        Update your personal information below.
                      </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleUpdateProfile}>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label htmlFor="name">Full Name</Label>
                          <Input
                            id="name"
                            placeholder="John Doe"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="phone">Phone</Label>
                          <Input
                            id="phone"
                            placeholder="+1 (555) 555-5555"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="address">Address</Label>
                          <Input
                            id="address"
                            placeholder="1234 Elm Street"
                            value={address}
                            onChange={(e) => setAddress(e.target.value)}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button
                          type="submit"
                          className="bg-primary hover:bg-primary/90 text-primary-foreground"
                        >
                          Save Changes
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>
              </CardFooter>
            </Card>
          </motion.div>

          {/* Account Settings */}
          <motion.div variants={fadeInUp} className="h-full">
            <Card className="border-border shadow-sm hover:shadow-md transition-shadow h-full flex flex-col">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center">
                    <Shield className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Account Settings</CardTitle>
                    <CardDescription>
                      Security and account management
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 flex-1">
                <div className="flex items-center gap-4 p-4 rounded-xl bg-muted border border-border">
                  <Avatar className="h-12 w-12 ring-2 ring-border">
                    <AvatarImage src={session?.user?.image ?? ""} />
                    <AvatarFallback className="bg-muted text-muted-foreground font-semibold">
                      {session?.user?.name?.charAt(0) || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <p className="font-medium text-foreground">Current User</p>
                    <p className="text-sm text-muted-foreground">
                      {session?.user?.email || "user@example.com"}
                    </p>
                  </div>
                </div>

                {/* Logout all devices */}
                <Dialog
                  open={logoutDialogOpen}
                  onOpenChange={setLogoutDialogOpen}
                >
                  <DialogTrigger asChild>
                    <button className="w-full flex items-center gap-3 p-4 rounded-xl hover:bg-muted transition-colors text-left border border-transparent hover:border-border">
                      <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                        <LogOut className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-foreground">
                          Logout of all devices
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Sign out from all active sessions
                        </p>
                      </div>
                    </button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>Logout of All Devices</DialogTitle>
                      <DialogDescription>
                        This will revoke all active sessions and sign you out.
                        You will need to sign in again on all devices.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                      <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                      </DialogClose>
                      <Button
                        variant="destructive"
                        onClick={handleLogoutAllDevices}
                        disabled={isLoggingOut}
                      >
                        {isLoggingOut ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : null}
                        Logout All Devices
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Delete account */}
                <Dialog
                  open={deleteDialogOpen}
                  onOpenChange={(open) => {
                    setDeleteDialogOpen(open);
                    if (!open) setDeleteConfirmEmail("");
                  }}
                >
                  <DialogTrigger asChild>
                    <button className="w-full flex items-center gap-3 p-4 rounded-xl hover:bg-red-50 transition-colors text-left border border-transparent hover:border-red-100 group">
                      <div className="h-10 w-10 rounded-lg bg-red-50 group-hover:bg-red-100 flex items-center justify-center transition-colors">
                        <Trash2 className="h-5 w-5 text-red-500" />
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-red-600">
                          Delete Account
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Permanently delete your account and data
                        </p>
                      </div>
                    </button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle className="text-red-600">
                        Delete Account
                      </DialogTitle>
                      <DialogDescription>
                        This action is permanent and cannot be undone. All your
                        data, including profiles, bookings, and preferences will
                        be permanently deleted.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="p-3 rounded-lg bg-red-50 border border-red-200">
                        <p className="text-sm text-red-700">
                          To confirm, type your email address:{" "}
                          <span className="font-semibold">
                            {session?.user?.email}
                          </span>
                        </p>
                      </div>
                      <Input
                        placeholder="Enter your email to confirm"
                        value={deleteConfirmEmail}
                        onChange={(e) => setDeleteConfirmEmail(e.target.value)}
                      />
                    </div>
                    <DialogFooter className="gap-2">
                      <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                      </DialogClose>
                      <Button
                        variant="destructive"
                        onClick={handleDeleteAccount}
                        disabled={
                          isDeletingAccount ||
                          deleteConfirmEmail !== session?.user?.email
                        }
                      >
                        {isDeletingAccount ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : null}
                        Delete My Account
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Connected Accounts */}
        <motion.div variants={fadeInUp} className="mt-6">
          <Card className="border-border shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center">
                  <Link2 className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <CardTitle className="text-lg">Connected Accounts</CardTitle>
                  <CardDescription>
                    Manage your linked social accounts. Signing in with any
                    connected provider will access the same account.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {isLoadingAccounts ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/70" />
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Credential account (email/password) */}
                  {linkedAccounts.some((a) => a.provider === "credential") && (
                    <div className="flex items-center justify-between p-4 rounded-xl border border-border">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                          <UserIcon className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div>
                          <p className="font-medium text-foreground">
                            Email & Password
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {session?.user?.email}
                          </p>
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
                        <Check className="h-3 w-3" />
                        Connected
                      </span>
                    </div>
                  )}

                  {/* OAuth providers */}
                  {AUTH_PROVIDERS.map((provider) => {
                    const Icon = PROVIDER_ICONS[provider.id];
                    const linked = linkedAccounts.find(
                      (a) => a.provider === provider.id,
                    );
                    const canUnlink = linkedAccounts.length > 1;

                    return (
                      <div
                        key={provider.id}
                        className="flex items-center justify-between p-4 rounded-xl border border-border hover:border-border/70 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                            {Icon && <Icon className="h-5 w-5 text-muted-foreground" />}
                          </div>
                          <div>
                            <p className="font-medium text-foreground">
                              {provider.label}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {linked ? "Account linked" : "Not connected"}
                            </p>
                          </div>
                        </div>
                        {linked ? (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
                              <Check className="h-3 w-3" />
                              Connected
                            </span>
                            {canUnlink && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground hover:text-red-600 hover:bg-red-50"
                                onClick={() => handleUnlinkAccount(provider.id)}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleLinkAccount(provider.id)}
                          >
                            Connect
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Cookie Preferences */}
        <motion.div variants={fadeInUp} className="mt-6">
          <Card className="border-border shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center">
                  <Cookie className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <CardTitle className="text-lg">Cookie Preferences</CardTitle>
                  <CardDescription>
                    Manage how we use cookies on your browser
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="p-4 rounded-xl border border-border hover:border-border/70 transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <Label
                      htmlFor="essential"
                      className="font-semibold text-foreground"
                    >
                      Essential
                    </Label>
                    <Switch id="essential" defaultChecked disabled />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Required for basic site functionality
                  </p>
                </div>
                <div className="p-4 rounded-xl border border-border hover:border-border/70 transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <Label
                      htmlFor="analytics"
                      className="font-semibold text-foreground"
                    >
                      Analytics
                    </Label>
                    <Switch
                      id="analytics"
                      checked={cookieAnalytics}
                      onCheckedChange={setCookieAnalytics}
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Help us improve site performance
                  </p>
                </div>
                <div className="p-4 rounded-xl border border-border hover:border-border/70 transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <Label
                      htmlFor="marketing"
                      className="font-semibold text-foreground"
                    >
                      Marketing
                    </Label>
                    <Switch
                      id="marketing"
                      checked={cookieMarketing}
                      onCheckedChange={setCookieMarketing}
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Personalized recommendations
                  </p>
                </div>
              </div>
            </CardContent>
            <CardFooter className="pt-0">
              <Button
                className="ml-auto bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={saveCookiePreferences}
                disabled={isSavingCookies}
              >
                {isSavingCookies ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Preferences"
                )}
              </Button>
            </CardFooter>
          </Card>
        </motion.div>

        {/* Notification Preferences */}
        <motion.div variants={fadeInUp} className="mt-6">
          <Card className="border-border shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center">
                  <Bell className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <CardTitle className="text-lg">
                    Notification Preferences
                  </CardTitle>
                  <CardDescription>
                    Choose what updates you want to receive
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-xl border border-border hover:border-border/70 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center">
                      <Bell className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">
                        All Notifications
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Receive all updates and alerts
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="all"
                    checked={notifAll}
                    onCheckedChange={setNotifAll}
                  />
                </div>
                <div className="flex items-center justify-between p-4 rounded-xl border border-border hover:border-border/70 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center">
                      <AtSign className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Mentions</p>
                      <p className="text-sm text-muted-foreground">
                        When someone mentions you
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="mentions"
                    checked={notifMentions}
                    onCheckedChange={setNotifMentions}
                  />
                </div>
                <div className="flex items-center justify-between p-4 rounded-xl border border-border hover:border-border/70 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center">
                      <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">
                        Direct Messages
                      </p>
                      <p className="text-sm text-muted-foreground">
                        New messages from experts
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="direct-messages"
                    checked={notifDirect}
                    onCheckedChange={setNotifDirect}
                  />
                </div>
                <div className="flex items-center justify-between p-4 rounded-xl border border-border hover:border-border/70 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center">
                      <Sparkles className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">
                        Product Updates
                      </p>
                      <p className="text-sm text-muted-foreground">
                        New features and improvements
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="updates"
                    checked={notifUpdates}
                    onCheckedChange={setNotifUpdates}
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter className="pt-0">
              <Button
                className="ml-auto bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={saveNotificationPreferences}
                disabled={isSavingNotifs}
              >
                {isSavingNotifs ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Preferences"
                )}
              </Button>
            </CardFooter>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  );
}
