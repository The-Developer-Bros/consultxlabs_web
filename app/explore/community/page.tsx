"use client";
/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/zCAL8ghPlzE
 * Documentation: https://v0.dev/docs#integrating-generated-code-into-your-nextjs-app
 */

/** Add fonts into your Next.js project:

import { Archivo } from 'next/font/google'
import { Libre_Franklin } from 'next/font/google'

archivo({
  subsets: ['latin'],
  display: 'swap',
})

libre_franklin({
  subsets: ['latin'],
  display: 'swap',
})

To read more about using these font, please visit the Next.js documentation:
- App Directory: https://nextjs.org/docs/app/building-your-application/optimizing/fonts
- Pages Directory: https://nextjs.org/docs/pages/building-your-application/optimizing/fonts
**/
import Link from "next/link";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import Image from "next/image";

export default function CommunitySection() {
  return (
    <div className="w-full">
      <section className="flex justify-center items-center py-20 md:py-32 lg:py-40 xl:py-48 bg-zinc-900 text-white">
        <div className="px-4 md:px-6 max-w-7xl w-full">
          <div className="grid gap-6 md:grid-cols-2 items-center">
            <div className="space-y-4">
              <h1 className="text-4xl font-bold md:text-5xl lg:text-6xl">
                Join Our Thriving Community
              </h1>
              <p className="text-lg md:text-xl text-primary-foreground/80">
                Connect with like-minded professionals, share insights, and
                collaborate on projects.
              </p>
              <Link
                href="#"
                className="inline-flex h-10 items-center justify-center rounded-md bg-white px-8 text-sm font-medium text-black shadow transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                prefetch={false}
              >
                Join the Community
              </Link>
            </div>
            <div className="hidden md:block">
              <Image
                src="/placeholder.svg"
                width={500}
                height={400}
                alt="Community"
                className="rounded-xl"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="py-12 md:py-20 flex justify-center items-center">
        <div className="px-4 md:px-6 max-w-7xl w-full">
          <div className="space-y-4 mb-8 text-center">
            <h2 className="text-3xl font-bold">Meet Our Community</h2>
            <p className="text-gray-400">
              Explore the diverse backgrounds and expertise of our community
              members.
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
            <div className="flex flex-col items-center space-y-2">
              <Avatar>
                <AvatarImage src="/placeholder-user.jpg" />
                <AvatarFallback>JD</AvatarFallback>
              </Avatar>
              <div className="text-center">
                <p className="font-medium">John Doe</p>
                <p className="text-sm text-gray-400">Software Engineer</p>
              </div>
            </div>
            <div className="flex flex-col items-center space-y-2">
              <Avatar>
                <AvatarImage src="/placeholder-user.jpg" />
                <AvatarFallback>SM</AvatarFallback>
              </Avatar>
              <div className="text-center">
                <p className="font-medium">Sarah Miller</p>
                <p className="text-sm text-gray-400">Product Manager</p>
              </div>
            </div>
            <div className="flex flex-col items-center space-y-2">
              <Avatar>
                <AvatarImage src="/placeholder-user.jpg" />
                <AvatarFallback>JB</AvatarFallback>
              </Avatar>
              <div className="text-center">
                <p className="font-medium">James Brown</p>
                <p className="text-sm text-gray-400">UX Designer</p>
              </div>
            </div>
            <div className="flex flex-col items-center space-y-2">
              <Avatar>
                <AvatarImage src="/placeholder-user.jpg" />
                <AvatarFallback>LW</AvatarFallback>
              </Avatar>
              <div className="text-center">
                <p className="font-medium">Lisa Wang</p>
                <p className="text-sm text-gray-400">Data Analyst</p>
              </div>
            </div>
            <div className="flex flex-col items-center space-y-2">
              <Avatar>
                <AvatarImage src="/placeholder-user.jpg" />
                <AvatarFallback>MR</AvatarFallback>
              </Avatar>
              <div className="text-center">
                <p className="font-medium">Michael Rodriguez</p>
                <p className="text-sm text-gray-400">Project Manager</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-muted py-12 md:py-20">
        <div className="px-4 md:px-6">
          <div className="space-y-4 mb-8">
            <h2 className="text-3xl font-bold">Recent Community Activity</h2>
            <p className="text-muted-foreground">
              Stay up-to-date with the latest discussions and interactions.
            </p>
          </div>
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>
                  New Discussion: Best Practices for Remote Work
                </CardTitle>
                <CardDescription>
                  Join the conversation on optimizing productivity and
                  collaboration for remote teams.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <Avatar>
                    <AvatarImage src="/placeholder-user.jpg" />
                    <AvatarFallback>JD</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">John Doe</p>
                    <p className="text-sm text-muted-foreground">
                      Software Engineer
                    </p>
                  </div>
                  <div className="ml-auto text-sm text-muted-foreground">
                    2 days ago
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>
                  New Resource: Guide to Building Effective Client Relationships
                </CardTitle>
                <CardDescription>
                  Check out our latest guide on strengthening client
                  partnerships.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <Avatar>
                    <AvatarImage src="/placeholder-user.jpg" />
                    <AvatarFallback>SM</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">Sarah Miller</p>
                    <p className="text-sm text-muted-foreground">
                      Product Manager
                    </p>
                  </div>
                  <div className="ml-auto text-sm text-muted-foreground">
                    1 week ago
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>
                  New Announcement: Upcoming Community Meetup in San Francisco
                </CardTitle>
                <CardDescription>
                  Join us for an in-person networking event and workshop.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <Avatar>
                    <AvatarImage src="/placeholder-user.jpg" />
                    <AvatarFallback>MR</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">Michael Rodriguez</p>
                    <p className="text-sm text-muted-foreground">
                      Project Manager
                    </p>
                  </div>
                  <div className="ml-auto text-sm text-muted-foreground">
                    2 weeks ago
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>
    </div>
  );
}
