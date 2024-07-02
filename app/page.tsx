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
import {AvatarFallback, AvatarImage} from "@/components/ui/avatar";

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
          <section className="w-full py-12 md:py-24 lg:py-32 flex flex-col justify-around items-center">
            <div className="grid items-center gap-6 lg:gap-12 xl:grid-cols-[1fr_550px] px-10 sm:w-full md:w-2/3 lg:w-5/6 xl:w-6/7">
              <Image
                // src={servicesImage}
                src="/placeholder.svg"
                className="mx-auto aspect-video overflow-hidden rounded-xl object-cover object-center sm:w-full lg:order-last"
                width={550}
                height={300}
                alt="Image"
                loading="eager"
              />
              <div className="flex flex-col justify-around space-y-4">
                <div className="space-y-2">
                  <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-bold tracking-tighter">
                    Our Services
                  </h2>
                  <p className="w-2/3 text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
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
          <section
            id="features"
            className="w-full py-12 md:py-24 lg:py-32 bg-gray-100"
          >
            <div className="px-4 md:px-6">
              <div className="flex flex-col items-center justify-center space-y-4 text-center">
                <div className="space-y-2">
                  <h2 className="text-3xl font-bold tracking-tighter sm:text-5xl">
                    Unlock Your Professional Potential
                  </h2>
                  <p className="max-w-[900px] text-muted-foreground md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed">
                    Our comprehensive mentorship consultancy provides you with
                    the guidance and support you need to achieve your career and
                    personal development goals.
                  </p>
                </div>
              </div>
              <div className="mx-auto grid max-w-5xl items-center gap-6 py-12 lg:grid-cols-2 lg:gap-12">
                <div className="flex flex-col justify-center space-y-4">
                  <ul className="grid gap-6">
                    <li>
                      <div className="grid gap-1">
                        <h3 className="text-xl font-bold">
                          Personalized Mentorship Plans
                        </h3>
                        <p className="text-muted-foreground">
                          Receive customized mentorship plans tailored to your
                          career aspirations, goals, and industry.
                        </p>
                      </div>
                    </li>
                    <li>
                      <div className="grid gap-1">
                        <h3 className="text-xl font-bold">
                          Expert Career Advice
                        </h3>
                        <p className="text-muted-foreground">
                          Get professional advice on navigating your career
                          path, overcoming challenges, and seizing
                          opportunities.
                        </p>
                      </div>
                    </li>
                    <li>
                      <div className="grid gap-1">
                        <h3 className="text-xl font-bold">
                          One-on-One Coaching
                        </h3>
                        <p className="text-muted-foreground">
                          Work closely with our experienced mentors to stay
                          motivated, accountable, and on track to achieve your
                          goals.
                        </p>
                      </div>
                    </li>
                  </ul>
                </div>
                <Image
                  src="/placeholder.svg"
                  width="550"
                  height="310"
                  alt="Features"
                  className="mx-auto aspect-video overflow-hidden rounded-xl object-cover object-center sm:w-full lg:order-last"
                />
              </div>
            </div>
          </section>
          <section className="w-full border-y pt-6 md:pt-12 lg:pt-16 xl:pt-20">
            <div className="px-4 md:px-6 space-y-10 xl:space-y-16">
              <div className="grid max-w-[1300px] mx-auto gap-4 px-4 sm:px-6 md:px-10 md:grid-cols-2 md:gap-16">
                <div>
                  <h1 className="lg:leading-tighter text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl xl:text-[3.4rem] 2xl:text-[3.75rem]">
                    The Best Experts in the World
                  </h1>
                </div>
                <div className="flex flex-col items-start space-y-4">
                  <p className="mx-auto max-w-[700px] text-gray-500 md:text-xl dark:text-gray-400">
                    Explore our wide range of consultants and find the right one
                    for your business.
                  </p>
                  <div className="space-x-4">
                    <Link
                      className="inline-flex h-9 items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-gray-50 shadow transition-colors hover:bg-gray-900/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50 dark:bg-gray-50 dark:text-gray-900 dark:hover:bg-gray-50/90 dark:focus-visible:ring-gray-300"
                      href="#"
                    >
                      Get Started
                    </Link>
                  </div>
                </div>
              </div>
              <Image
                alt="Hero"
                className="mx-auto aspect-[3/1] overflow-hidden rounded-t-xl object-cover"
                height="300"
                src="/placeholder.svg"
                width="1270"
              />
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
                <div className="grid gap-12">
                  <Button className="w-full lg:w-auto dark:bg-gray-800 text-white mx-auto">
                    View All Experts
                  </Button>
                </div>
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
        <MeetTheTeam />
        <Newsletter />
      </AnimatePresence>
    </ReduxProvider>
  );
}

/**
 * v0 by Vercel.
 * @see https://v0.dev/t/pbezvcjADh4
 * Documentation: https://v0.dev/docs#integrating-generated-code-into-your-nextjs-app
 */

function MeetTheTeam() {
  return (
    <section className="w-full py-12 md:py-24 lg:py-32">
      <div className="px-4 md:px-6">
        <div className="space-y-4 text-center">
          <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">Meet the Team</h2>
          <p className="text-muted-foreground md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed">
            Get to know the talented individuals behind our company.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-6 pt-10 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          <div className="flex flex-col items-center justify-center space-y-4 rounded-lg bg-background p-6 shadow-lg transition-transform duration-300 ease-in-out hover:-translate-y-2 hover:shadow-xl">
            <Avatar>
              <AvatarImage src="/placeholder-user.jpg" />
              <AvatarFallback>JD</AvatarFallback>
            </Avatar>
            <div className="space-y-1 text-center">
              <h4 className="text-lg font-semibold">John Doe</h4>
              <p className="text-sm text-muted-foreground">CEO</p>
              <p className="text-sm text-muted-foreground">
                John is the visionary behind our company, leading the team to new heights.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center space-y-4 rounded-lg bg-background p-6 shadow-lg transition-transform duration-300 ease-in-out hover:-translate-y-2 hover:shadow-xl">
            <Avatar>
              <AvatarImage src="/placeholder-user.jpg" />
              <AvatarFallback>JA</AvatarFallback>
            </Avatar>
            <div className="space-y-1 text-center">
              <h4 className="text-lg font-semibold">Jane Appleseed</h4>
              <p className="text-sm text-muted-foreground">CTO</p>
              <p className="text-sm text-muted-foreground">
                Jane leads our engineering team, ensuring our products are cutting-edge and reliable.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center space-y-4 rounded-lg bg-background p-6 shadow-lg transition-transform duration-300 ease-in-out hover:-translate-y-2 hover:shadow-xl">
            <Avatar>
              <AvatarImage src="/placeholder-user.jpg" />
              <AvatarFallback>KS</AvatarFallback>
            </Avatar>
            <div className="space-y-1 text-center">
              <h4 className="text-lg font-semibold">Kara Sato</h4>
              <p className="text-sm text-muted-foreground">Head of Design</p>
              <p className="text-sm text-muted-foreground">
                Kara leads our design team, ensuring our products have a beautiful and intuitive user experience.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center space-y-4 rounded-lg bg-background p-6 shadow-lg transition-transform duration-300 ease-in-out hover:-translate-y-2 hover:shadow-xl">
            <Avatar>
              <AvatarImage src="/placeholder-user.jpg" />
              <AvatarFallback>MR</AvatarFallback>
            </Avatar>
            <div className="space-y-1 text-center">
              <h4 className="text-lg font-semibold">Michael Reeves</h4>
              <p className="text-sm text-muted-foreground">Head of Marketing</p>
              <p className="text-sm text-muted-foreground">
                Michael leads our marketing efforts, ensuring our brand resonates with our target audience.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center space-y-4 rounded-lg bg-background p-6 shadow-lg transition-transform duration-300 ease-in-out hover:-translate-y-2 hover:shadow-xl">
            <Avatar>
              <AvatarImage src="/placeholder-user.jpg" />
              <AvatarFallback>LS</AvatarFallback>
            </Avatar>
            <div className="space-y-1 text-center">
              <h4 className="text-lg font-semibold">Lisa Simmons</h4>
              <p className="text-sm text-muted-foreground">Head of Sales</p>
              <p className="text-sm text-muted-foreground">
                Lisa leads our sales team, ensuring our customers receive top-notch service.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center space-y-4 rounded-lg bg-background p-6 shadow-lg transition-transform duration-300 ease-in-out hover:-translate-y-2 hover:shadow-xl">
            <Avatar>
              <AvatarImage src="/placeholder-user.jpg" />
              <AvatarFallback>JB</AvatarFallback>
            </Avatar>
            <div className="space-y-1 text-center">
              <h4 className="text-lg font-semibold">John Bauer</h4>
              <p className="text-sm text-muted-foreground">Head of Customer Support</p>
              <p className="text-sm text-muted-foreground">
                John leads our customer support team, ensuring our customers have a seamless experience.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center space-y-4 rounded-lg bg-background p-6 shadow-lg transition-transform duration-300 ease-in-out hover:-translate-y-2 hover:shadow-xl">
            <Avatar>
              <AvatarImage src="/placeholder-user.jpg" />
              <AvatarFallback>SM</AvatarFallback>
            </Avatar>
            <div className="space-y-1 text-center">
              <h4 className="text-lg font-semibold">Sarah Mayer</h4>
              <p className="text-sm text-muted-foreground">Head of Human Resources</p>
              <p className="text-sm text-muted-foreground">
                Sarah leads our HR team, ensuring our employees have the support they need to thrive.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center space-y-4 rounded-lg bg-background p-6 shadow-lg transition-transform duration-300 ease-in-out hover:-translate-y-2 hover:shadow-xl">
            <Avatar>
              <AvatarImage src="/placeholder-user.jpg" />
              <AvatarFallback>DW</AvatarFallback>
            </Avatar>
            <div className="space-y-1 text-center">
              <h4 className="text-lg font-semibold">David Wong</h4>
              <p className="text-sm text-muted-foreground">Head of Finance</p>
              <p className="text-sm text-muted-foreground">
                David leads our finance team, ensuring our company remains financially sound.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}