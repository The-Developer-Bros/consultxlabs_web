"use client";
import TestimonialsSection from "@/components/testimonials";
import store from "@/redux/store";
import { Provider as ReduxProvider } from "react-redux";

import { Faq } from "@/components/faq";
import { Newsletter } from "@/components/newsletter";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { AnimatePresence } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import bannerImage from "../public/static/assets/images/main-banner.jpeg";

export default function Home() {

  return (
    <ReduxProvider store={store}>
      <AnimatePresence>
        {/* <AnnouncementBar /> */}
        <main className="flex-0">
          <section
            className="h-full py-12 md:py-24 lg:py-40 xl:py-56 bg-gray-100"
            style={{
              backgroundImage: `url(${bannerImage.src})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              backgroundPositionY: "15%", // Lower the image vertically
            }}
          >
            <div className="px-4 md:px-6">
              <div className="flex flex-col items-center space-y-4 text-center">
                <div className="space-y-2">
                  <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-bold tracking-tighter">
                    Welcome to ConsultX
                  </h1>
                  <p className="mx-auto max-w-[700px] text-gray-500 md:text-xl italic dark:text-gray-800">
                    <q>
                      A platform where experts share their advice through 1-1
                      sessions, classes, webinars, and conferences.
                    </q>
                  </p>
                </div>
                <div className="space-x-4">
                  <Link
                    className="inline-flex h-9 items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-gray-50 shadow transition-colors hover:bg-gray-900/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50 dark:bg-gray-50 dark:text-gray-900 dark:hover:bg-gray-50/90 dark:focus-visible:ring-gray-300"
                    href="#"
                  >
                    Join Now
                  </Link>
                  <Link
                    className="inline-flex h-9 items-center justify-center rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-black shadow-sm transition-colors hover:bg-gray-100 hover:text-black focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50 dark:border-gray-800 dark:bg-gray-950 dark:text-white dark:focus-visible:ring-gray-300"
                    href="#"
                  >
                    Learn more
                  </Link>
                </div>
              </div>
            </div>
          </section>
          <section className="w-full py-12 md:py-24 lg:py-32">
            <div className="grid items-center gap-6 lg:gap-12 xl:grid-cols-[1fr_550px] px-4 md:px-6">
              <Image
                alt="Image"
                className="mx-auto aspect-video overflow-hidden rounded-xl object-cover object-center sm:w-full lg:order-last"
                height={310}
                src="/placeholder.svg"
                width={550}
              />
              <div className="flex flex-col justify-center space-y-4">
                <div className="space-y-2">
                  <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-bold tracking-tighter">
                    Our Services
                  </h2>
                  <p className="max-w-[600px] text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
                    We provide a range of services including 1-1 sessions,
                    classes, webinars, and conferences. Our experts are ready to
                    share their advice and experience with you.
                  </p>
                </div>
                <div className="flex space-x-4 justify-around">
                  <Link
                    className="inline-flex items-center justify-center rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-black shadow-sm transition-colors hover:bg-gray-100 hover:text-black focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50 dark:border-gray-800 dark:bg-gray-950 dark:text-white dark:focus-visible:ring-gray-300"
                    href="#"
                  >
                    View Services
                  </Link>
                </div>
              </div>
            </div>
          </section>
          <section className="w-full py-12 md:py-24 lg:py-32 bg-gray-100">
            <div className="px-4 md:px-6">
              <div className="grid items-center text-center gap-4">
                <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-bold tracking-tighter">
                  Meet our Featured Experts
                </h2>
                <p className="mx-auto max-w-[700px] text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
                  We have a diverse team of experts ready to share their
                  knowledge and expertise with you.
                </p>
                <div className="grid w-full grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-8 lg:gap-12">
                  <Card>
                    <CardHeader>
                      <Avatar />
                      <h3 className="text-lg font-bold">Expert 1</h3>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        Expert in business and entrepreneurship.
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <Avatar />
                      <h3 className="text-lg font-bold">Expert 2</h3>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        Expert in nutrition and wellness.
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <Avatar />
                      <h3 className="text-lg font-bold">Expert 3</h3>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        Expert in digital marketing and SEO.
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <Avatar />
                      <h3 className="text-lg font-bold">Expert 4</h3>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        Expert in personal development and coaching.
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <Avatar />
                      <h3 className="text-lg font-bold">Expert 5</h3>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        Expert in Higher Education and Travel
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </div>
          </section>
          <section className="container mx-auto px-4 py-10">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-900 mb-4">
              Check out our various offerings
            </h1>
            <p className="text-gray-600 dark:text-gray-900">
              Connect with experts in various fields for 1-1 sessions, classes,
              webinars, and conferences.
            </p>
          </section>
          <section className="container mx-auto px-4 grid gap-6 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 mb-4">
            <Card className="rounded-lg shadow-md">
              <CardHeader className="text-lg font-semibold text-gray-900 dark:text-gray-900">
                1-1 Sessions
              </CardHeader>
              <CardContent className="text-gray-900 dark:text-gray-900">
                Connect with experts for personal sessions and gain insights
                from industry leaders.
              </CardContent>
            </Card>
            <Card className="rounded-lg shadow-md">
              <CardHeader className="text-lg font-semibold text-gray-900 dark:text-gray-900">
                Classes
              </CardHeader>
              <CardContent className="text-gray-900 dark:text-gray-900">
                Join classes offered by professionals and broaden your knowledge
                in various fields.
              </CardContent>
            </Card>
            <Card className="rounded-lg shadow-md">
              <CardHeader className="text-lg font-semibold text-gray-900 dark:text-gray-900">
                Webinars
              </CardHeader>
              <CardContent className="text-gray-900 dark:text-gray-900">
                Participate in webinars to learn from experts in a collaborative
                setting.
              </CardContent>
            </Card>
            <Card className="rounded-lg shadow-md">
              <CardHeader className="text-lg font-semibold text-gray-900 dark:text-gray-900">
                Conferences
              </CardHeader>
              <CardContent className="text-gray-900 dark:text-gray-900">
                Join conferences to hear from multiple experts and network with
                other participants.
              </CardContent>
            </Card>
          </section>
          <section className="w-full py-12 md:py-24 lg:py-32 bg-gray-100">
            <div className="grid items-center justify-center gap-4 px-4 text-center md:px-6">
              <div className="space-y-3">
                <h2 className="text-3xl font-bold tracking-tighter md:text-4xl/tight">
                  Join our Community of Experts
                </h2>
                <p className="mx-auto max-w-[600px] text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
                  Share your expertise with people who need it and grow your
                  personal brand.
                </p>
              </div>
              <div className="mx-auto w-full max-w-sm space-y-2">
                <Button className="w-full dark:bg-gray-800 text-white">
                  Become an Expert
                </Button>
              </div>
            </div>
          </section>
        </main>
        <Faq />
        <TestimonialsSection />
        <Newsletter />
      </AnimatePresence>
    </ReduxProvider>
  );
}
