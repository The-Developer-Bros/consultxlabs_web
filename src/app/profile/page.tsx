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
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import Link from "next/link";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export default function Profile() {
  
  return (
    <>
      <div className="flex justify-center items-center min-h-screen px-4 py-20 md:py-30 lg:py-30 xl:py-40">
        <div className="flex w-full max-w-4xl gap-4">
          <div className="w-1/2">
            <Card className="w-full max-w-xs">
              <CardHeader>
                <CardTitle>Account Settings</CardTitle>
                <CardDescription>
                  Manage your account settings and preferences.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-4 grid grid-cols-[25px_1fr] items-start pb-4 last:mb-0 last:pb-0">
                  <Avatar
                    alt="User Avatar"
                    className="w-8 h-8"
                    src="/placeholder.svg?height=32&width=32"
                  />
                  <div className="grid gap-1">
                    <p className="text-sm font-medium">Current User</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      user@example.com
                    </p>
                  </div>
                </div>
                <div className="mb-4 grid grid-cols-[25px_1fr] items-start pb-4 last:mb-0 last:pb-0">
                  <SettingsIcon className="w-4 h-4" />
                  <div className="grid gap-1">
                    <Link className="text-sm font-medium underline" href="#">
                      Logout of all devices
                    </Link>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      This will logout your account from all devices.
                    </p>
                  </div>
                </div>
                <div className="mb-4 grid grid-cols-[25px_1fr] items-start pb-4 last:mb-0 last:pb-0">
                  <TrashIcon className="w-4 h-4" />
                  <div className="grid gap-1">
                    <Link
                      className="text-sm font-medium underline text-red-500"
                      href="#"
                    >
                      Delete Account
                    </Link>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      This will permanently delete your account.
                    </p>
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
          <div className="w-1/2 space-y-4">
            <Card className="w-full max-w-xs">
              <CardHeader>
                <CardTitle>Profile Information</CardTitle>
                <CardDescription>
                  View and update your personal information.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-4 grid grid-cols-[25px_1fr] items-start pb-4 last:mb-0 last:pb-0">
                  <Avatar
                    alt="User Avatar"
                    className="w-16 h-16"
                    src="/placeholder.svg?height=64&width=64"
                  />
                  <div className="grid gap-1">
                    <p className="text-sm font-medium">Full Name</p>
                    <p className="text-sm">John Doe</p>
                  </div>
                </div>
                <div className="mb-4 grid grid-cols-[25px_1fr] items-start pb-4 last:mb-0 last:pb-0">
                  <MailIcon className="w-4 h-4" />
                  <div className="grid gap-1">
                    <p className="text-sm font-medium">Email</p>
                    <p className="text-sm">johndoe@example.com</p>
                  </div>
                </div>
                <div className="mb-4 grid grid-cols-[25px_1fr] items-start pb-4 last:mb-0 last:pb-0">
                  <PhoneIcon className="w-4 h-4" />
                  <div className="grid gap-1">
                    <p className="text-sm font-medium">Phone</p>
                    <p className="text-sm">+1 234 567 8910</p>
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <Button className="w-full" variant="outline">
                  Update Information
                </Button>
              </CardFooter>
            </Card>
            <Card key="1" className="w-full max-w-lg">
              <CardHeader className="border-b border-dark-gray-300 pb-4">
                <div className="flex items-center">
                  <CookieIcon className="mr-2" />
                  <CardTitle>Cookie Preferences</CardTitle>
                </div>
                <CardDescription>
                  Manage your cookie settings. You can enable or disable
                  different types of cookies below.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <div className="flex justify-between items-start space-y-2">
                  <div>
                    <Label htmlFor="essential">Essential Cookies</Label>
                    <p className="text-dark-gray-500 text-sm">
                      These cookies are necessary for the website to function
                      and cannot be switched off.
                    </p>
                  </div>
                  <Switch className="ml-auto" id="essential" />
                </div>
                <div className="flex justify-between items-start space-y-2">
                  <div>
                    <Label htmlFor="analytics">Analytics Cookies</Label>
                    <p className="text-dark-gray-500 text-sm">
                      These cookies allow us to count visits and traffic
                      sources, so we can measure and improve the performance of
                      our site.
                    </p>
                  </div>
                  <Switch className="ml-auto" id="analytics" />
                </div>
                <div className="flex justify-between items-start space-y-2">
                  <div>
                    <Label htmlFor="marketing">Marketing Cookies</Label>
                    <p className="text-dark-gray-500 text-sm">
                      These cookies help us show you relevant ads.
                    </p>
                  </div>
                  <Switch className="ml-auto" id="marketing" />
                </div>
              </CardContent>
              <div className="border-t border-dark-gray-300 mt-4" />
              <div className="flex justify-end items-center py-4">
                <Card className="max-w-2xl mx-auto">
                  <CardHeader>
                    <CardTitle>Notification Preferences</CardTitle>
                    <CardDescription>
                      Select which notifications you'd like to receive
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    <div className="flex items-center">
                      <div className="space-y-1">
                        <Label
                          className="text-sm font-medium leading-none"
                          htmlFor="all"
                        >
                          All Notifications
                        </Label>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          Receive all notifications.
                        </p>
                      </div>
                      <Switch className="ml-auto" id="all" />
                    </div>
                    <div className="flex items-center">
                      <div className="space-y-1">
                        <Label
                          className="text-sm font-medium leading-none"
                          htmlFor="mentions"
                        >
                          Mentions
                        </Label>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          Receive notifications only when someone mentions you.
                        </p>
                      </div>
                      <Switch className="ml-auto" id="mentions" />
                    </div>
                    <div className="flex items-center">
                      <div className="space-y-1">
                        <Label
                          className="text-sm font-medium leading-none"
                          htmlFor="direct-messages"
                        >
                          Direct Messages
                        </Label>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          Receive notifications for direct messages.
                        </p>
                      </div>
                      <Switch className="ml-auto" id="direct-messages" />
                    </div>
                    <div className="flex items-center">
                      <div className="space-y-1">
                        <Label
                          className="text-sm font-medium leading-none"
                          htmlFor="updates"
                        >
                          Updates
                        </Label>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          Get notifications about new features and updates.
                        </p>
                      </div>
                      <Switch className="ml-auto" id="updates" />
                    </div>
                  </CardContent>
                </Card>
              </div>
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
      </div>
    </>
  );
}

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
