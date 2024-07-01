"use client";
/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/1a1RTNuUXEU
 */

/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/Yudwvib
 */

/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/3get5aEaNz1
 */

/**
* This code was generated by v0 by Vercel.
* @see https://v0.dev/t/r3WQJxLalyw
* Documentation: https://v0.dev/docs#integrating-generated-code-into-your-nextjs-app
*/


/**
* This code was generated by v0 by Vercel.
* @see https://v0.dev/t/etn5A3SUSbO
* Documentation: https://v0.dev/docs#integrating-generated-code-into-your-nextjs-app
*/

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
import Link from "next/link";

// Import the modal components
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import Image from "next/image";
import { useState } from "react";
import { useSession } from "next-auth/react";

export default function Profile() {
  const { data: session } = useSession();
  const [name, setName] = useState(session?.user?.name || "");
  const [phone, setPhone] = useState(session?.user?.phone || "");
  const [email, setEmail] = useState(session?.user?.email || "");

  const handleUpdateProfile = async (e: { preventDefault: () => void; }) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/update-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, phone, email }),
      });

      if (res.ok) {
        // Profile updated successfully
        const updatedUser = await res.json();
        // Update the UI with new user data (optional)
        setName(updatedUser.name);
        setPhone(updatedUser.phone);
        setEmail(updatedUser.email);
      } else {
        // Handle error
        console.error('Failed to update profile');
      }
    } catch (error) {
      console.error('An unexpected error occurred:', error);
    }
  };

  return (
    <div className="flex justify-center items-center min-h-screen px-4 py-20 md:py-30 lg:py-30 xl:py-40">
      <div className="max-w-4xl w-full space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <Card>
            <CardHeader>
              <CardTitle>Profile Information</CardTitle>
              <CardDescription>
                View and update your personal information.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center space-x-4 mb-6">
                <Avatar>
                  <AvatarImage src={session?.user?.image || "https://github.com/shadcn.png"} />
                  <AvatarFallback>CN</AvatarFallback>
                </Avatar>

                <div>
                  <p className="text-lg font-medium">{session?.user?.name || "John Doe"}</p>
                  <p className="text-sm text-gray-500">Full Name</p>
                </div>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button className="w-1/2" variant="outline">
                      Upload Profile Picture
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[425px] bg-white shadow-lg rounded-lg p-6">
                    <DialogHeader>
                      <DialogTitle>Update Profile Picture</DialogTitle>
                      <DialogDescription>
                        Upload a new profile picture to update your account.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                      <div className="grid items-center gap-4">
                        <div className="flex flex-col items-center justify-center">
                          <Image
                            src="/placeholder.svg"
                            alt="Profile Preview"
                            className="rounded-full"
                            width={100}
                            height={100}
                          />
                          <p className="mt-2 text-sm text-muted-foreground">
                            Preview of selected image
                          </p>
                        </div>
                        <div className="flex flex-col space-y-1.5">
                          <Label htmlFor="profile-picture">
                            Profile Picture
                          </Label>
                          <Input id="profile-picture" type="file" />
                        </div>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline">Cancel</Button>
                      <Button
                        type="submit"
                        style={{ backgroundColor: "black", color: "white" }}
                      >
                        Update
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>

              <div className="space-y-4">
                <div className="flex items-center">
                  <MailIcon className="w-5 h-5 text-gray-400 mr-2" />
                  <div>
                    <p className="text-sm font-medium">Email</p>
                    <p className="text-sm">{session?.user?.email || "johndoe@example.com"}</p>
                  </div>
                </div>
                <div className="flex items-center">
                  <PhoneIcon className="w-5 h-5 text-gray-400 mr-2" />
                  <div>
                    <p className="text-sm font-medium">Phone</p>
                    <p className="text-sm">{session?.user?.phone || "+1 234 567 8910"}</p>
                  </div>
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Dialog>
                <DialogTrigger asChild>
                  <Button className="w-full" variant="outline">
                    Update Information
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[450px] bg-white shadow-lg rounded-lg p-6">
                  <DialogHeader>
                    <DialogTitle>Update Information</DialogTitle>
                    <DialogDescription>
                      Update your personal information below.
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleUpdateProfile}>
                    <div className="grid gap-4 py-4">
                      <div className="grid grid-cols-4 items-center gap-4">
                        <Label htmlFor="name" className="text-right">
                          Full Name
                        </Label>
                        <Input
                          id="name"
                          placeholder="John Doe"
                          className="col-span-3"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </div>
                      <div className="grid grid-cols-4 items-center gap-4">
                        <Label htmlFor="phone" className="text-right">
                          Phone
                        </Label>
                        <Input
                          id="phone"
                          placeholder="+1 (555) 555-5555"
                          className="col-span-3"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                        />
                      </div>
                      <div className="grid grid-cols-4 items-center gap-4">
                        <Label htmlFor="email" className="text-right">
                          Email
                        </Label>
                        <Input
                          id="email"
                          type="email"
                          placeholder="john@example.com"
                          className="col-span-3"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        type="submit"
                        style={{ backgroundColor: "black", color: "white" }}
                      >
                        Update Information
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Account Settings</CardTitle>
              <CardDescription>
                Manage your account settings and preferences.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center mb-4">
                <Avatar>
                  <AvatarImage src="" />
                  <AvatarFallback>JP</AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-sm font-medium">Current User</p>
                  <p className="text-sm text-gray-500">user@example.com</p>
                </div>
              </div>
              <div className="space-y-4">
                <div className="flex items-center">
                  <SettingsIcon className="w-5 h-5 text-gray-400 mr-2" />
                  <div>
                    <Link className="text-sm font-medium underline" href="#">
                      Logout of all devices
                    </Link>
                    <p className="text-sm text-gray-500">
                      This will logout your account from all devices.
                    </p>
                  </div>
                </div>
                <div className="flex items-center">
                  <TrashIcon className="w-5 h-5 text-red-500 mr-2" />
                  <div>
                    <Link
                      className="text-sm font-medium underline text-red-500"
                      href="#"
                    >
                      Delete Account
                    </Link>
                    <p className="text-sm text-gray-500">
                      This will permanently delete your account.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button className="w-full" variant="outline">
                Save Changes
              </Button>
            </CardFooter>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <div className="flex items-center">
              <CookieIcon className="w-5 h-5 text-gray-400 mr-2" />
              <CardTitle>Cookie Preferences</CardTitle>
            </div>
            <CardDescription>
              Manage your cookie settings. You can enable or disable different
              types of cookies below.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="essential">Essential Cookies</Label>
                <p className="text-sm text-gray-500">
                  These cookies are necessary for the website to function and
                  cannot be switched off.
                </p>
              </div>
              <Switch id="essential" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="analytics">Analytics Cookies</Label>
                <p className="text-sm text-gray-500">
                  These cookies allow us to count visits and traffic sources, so
                  we can measure and improve the performance of our site.
                </p>
              </div>
              <Switch id="analytics" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="marketing">Marketing Cookies</Label>
                <p className="text-sm text-gray-500">
                  These cookies help us show you relevant ads.
                </p>
              </div>
              <Switch id="marketing" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Notification Preferences</CardTitle>
            <CardDescription>
              Select which notifications you'd like to receive
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex items-center justify-between">
              <div>
                <Label
                  className="text-sm font-medium leading-none"
                  htmlFor="all"
                >
                  All Notifications
                </Label>
                <p className="text-sm text-gray-500">
                  Receive all notifications.
                </p>
              </div>
              <Switch id="all" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label
                  className="text-sm font-medium leading-none"
                  htmlFor="mentions"
                >
                  Mentions
                </Label>
                <p className="text-sm text-gray-500">
                  Receive notifications only when someone mentions you.
                </p>
              </div>
              <Switch id="mentions" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label
                  className="text-sm font-medium leading-none"
                  htmlFor="direct-messages"
                >
                  Direct Messages
                </Label>
                <p className="text-sm text-gray-500">
                  Receive notifications for direct messages.
                </p>
              </div>
              <Switch id="direct-messages" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label
                  className="text-sm font-medium leading-none"
                  htmlFor="updates"
                >
                  Updates
                </Label>
                <p className="text-sm text-gray-500">
                  Get notifications about new features and updates.
                </p>
              </div>
              <Switch id="updates" />
            </div>
          </CardContent>
          <CardFooter>
            <Button
              className="ml-auto"
              type="submit"
              style={{ backgroundColor: "black", color: "white" }}
            >
              Save Preferences
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}

// ... (icon components remain the same)

function SettingsIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function TrashIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function MailIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

function PhoneIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function CookieIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
      <path d="M8.5 8.5v.01" />
      <path d="M16 15.5v.01" />
      <path d="M12 12v.01" />
      <path d="M11 17v.01" />
      <path d="M7 14v.01" />
    </svg>
  );
}
