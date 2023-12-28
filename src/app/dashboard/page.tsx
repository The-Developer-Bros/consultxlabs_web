"use client";
import Link from "next/link";
import {
  CardDescription,
  CardHeader,
  CardContent,
  Card,
} from "@/components/ui/card";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/navbar";
import Image from "next/image";

export default function Dashboard() {
  const { data: session } = useSession();

  const router = useRouter();
  if (!session) {
    router.push("/");
  }
  return (
    <>
      <Navbar />
      <div className="grid h-screen min-h-screen w-full lg:grid-cols-[280px_1fr]">
        <div className="hidden lg:block bg-gray-100/40 dark:bg-gray-900 py-96">
          <div className="flex h-full max-h-screen flex-col gap-2">
            <div className="flex-1 overflow-auto">
              <nav className="grid items-start px-4 text-sm font-medium">
                <Link
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-gray-500 transition-all hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50"
                  href="#"
                >
                  <HomeIcon className="h-4 w-4" />
                  Dashboard
                </Link>
                <Link
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-gray-500 transition-all hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50"
                  href="#"
                >
                  <CalendarIcon className="h-4 w-4" />
                  Sessions Schedule
                </Link>
                <Link
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-gray-500 transition-all hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50"
                  href="#"
                >
                  <BookIcon className="h-4 w-4" />
                  Resources
                </Link>
                <Link
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-gray-500 transition-all hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50"
                  href="#"
                >
                  <TextIcon className="h-4 w-4" />
                  Connect with Peers
                </Link>
              </nav>
            </div>
          </div>
        </div>
        <div className="flex flex-col py-40">
          <main className="flex flex-1 flex-col gap-4 p-4 md:gap-8 md:p-6">
            <div className="flex items-center gap-4">
              <h1 className="font-bold text-2xl md:text-3xl">Dashboard</h1>
            </div>
            <div className="grid gap-6">
              <Card className="flex flex-col border-none shadow-none">
                <CardHeader>
                  <CardDescription className="font-bold text-lg md:text-xl">
                    Upcoming 1-1 Sessions
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex space-x-4 overflow-x-auto pb-2">
                    <div className="min-w-[200px] h-[300px] bg-gray-200">
                      <Image
                        alt="Session"
                        src="/placeholder.svg"
                        width={200}
                        height={200}
                        layout="responsive"
                        objectFit="cover"
                      />
                      <div className="p-2">
                        <h3 className="font-bold">Session Name</h3>
                        <p>Date - Time - Host</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="flex flex-col">
                <CardHeader>
                  <CardDescription className="font-bold text-lg md:text-xl">
                    Upcoming Classes
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex space-x-4 overflow-x-scroll pb-2">
                    <div className="min-w-[200px] h-[300px] bg-gray-200">
                      <Image
                        alt="Class"
                        src="/placeholder.svg"
                        width={200}
                        height={200}
                        layout="responsive"
                        objectFit="cover"
                      />
                      <div className="p-2">
                        <h3 className="font-bold">Class Name</h3>
                        <p>Date - Time - Host</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="flex flex-col">
                <CardHeader>
                  <CardDescription className="font-bold text-lg md:text-xl">
                    Upcoming Webinars
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex space-x-4 overflow-x-scroll pb-2">
                    <div className="min-w-[200px] h-[300px] bg-gray-200">
                      <Image
                        alt="Webinar"
                        src="/placeholder.svg"
                        width={200}
                        height={200}
                        layout="responsive"
                        objectFit="cover"
                      />
                      <div className="p-2">
                        <h3 className="font-bold">Webinar Name</h3>
                        <p>Date - Time - Host</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="flex flex-col">
                <CardHeader>
                  <CardDescription className="font-bold text-lg md:text-xl">
                    Upcoming Conferences
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex space-x-4 overflow-x-scroll pb-2">
                    <div className="min-w-[200px] h-[300px] bg-gray-200">
                      <Image
                        alt="Conference"
                        src="/placeholder.svg"
                        width={200}
                        height={200}
                        layout="responsive"
                        objectFit="cover"
                      />
                      <div className="p-2">
                        <h3 className="font-bold">Conference Name</h3>
                        <p>Date - Time - Host</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </main>
        </div>
      </div>
    </>
  );
}

function HomeIcon(props: any) {
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
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function CalendarIcon(props: any) {
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
      <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
      <line x1="16" x2="16" y1="2" y2="6" />
      <line x1="8" x2="8" y1="2" y2="6" />
      <line x1="3" x2="21" y1="10" y2="10" />
    </svg>
  );
}

function BookIcon(props: any) {
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
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </svg>
  );
}

function TextIcon(props: any) {
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
      <path d="M17 6.1H3" />
      <path d="M21 12.1H3" />
      <path d="M15.1 18H3" />
    </svg>
  );
}
