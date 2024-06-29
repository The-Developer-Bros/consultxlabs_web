"use client";
/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/vLaw30kyQ2m
 */
import { Avatar } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useEffect, useState } from "react";

const dummyConsultants = [
  {
    title: "Consultant Category 1",
    expertise: "Business Strategy",
    rating: "4.5",
    location: "London",
  },
  {
    title: "Consultant Category 2",
    expertise: "Finance",
    rating: "4.3",
    location: "New York",
  },
  {
    title: "Consultant Category 3",
    expertise: "IT Services",
    rating: "4.2",
    location: "Los Angeles",
  },
  {
    title: "Consultant Category 4",
    expertise: "Marketing",
    rating: "4.7",
    location: "Chicago",
  },
];

type Domain = string;
type Subdomain = string;

export default function ExploreExperts() {
  return (
    <>
      <section className="w-full py-12 md:py-24 lg:py-32">
        <div className="space-y-12 px-4 md:px-6">
          <div className="flex flex-col items-center justify-center space-y-4 text-center">
            <div className="space-y-2">
              <div className="inline-block rounded-lg bg-gray-100 px-3 py-1 text-sm dark:bg-gray-800">
                Featured Experts
              </div>
              <h2 className="text-3xl font-bold tracking-tighter sm:text-5xl">
                Top Consultants
              </h2>
              <p className="max-w-[900px] text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
                Discover the best of the best. Our top consultants are ready to
                help you with your business needs.
              </p>
            </div>
          </div>
          <div className="mx-auto grid items-start gap-8 sm:max-w-4xl sm:grid-cols-2 md:gap-12 lg:max-w-5xl lg:grid-cols-3">
            <Card>
              <CardHeader>
                <h3 className="text-lg font-bold">John Doe</h3>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Get help with your business strategy from a top consultant.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <h3 className="text-lg font-bold">Eliot</h3>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Get help with your product design from a top consultant.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <h3 className="text-lg font-bold">Macmillan</h3>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Get help with your marketing strategy from a top consultant.
                </p>
              </CardContent>
            </Card>
          </div>
          <div className="flex justify-center space-x-4">
            <Link
              className="inline-flex h-10 items-center justify-center rounded-md bg-gray-900 px-8 text-sm font-medium text-gray-50 shadow transition-colors hover:bg-gray-900/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50 dark:bg-gray-50 dark:text-gray-900 dark:hover:bg-gray-50/90 dark:focus-visible:ring-gray-300"
              href="#"
            >
              View All Experts
            </Link>
          </div>
        </div>
      </section>
      <FindExperts />

      <section className="w-full py-12 md:py-24 lg:py-32 bg-black dark:bg-black">
        <div className="grid items-center justify-center gap-4 px-4 text-center md:px-6">
          <div className="space-y-3">
            <h2 className="text-3xl font-bold tracking-tighter md:text-4xl/tight text-white">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-gray-700 to-white">
                What Our Customers Say
              </span>
            </h2>
            <p className="mx-auto max-w-[600px] text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
              Hear from our valued customers about their experience with our
              keyboards.
            </p>
          </div>
          <div className="mx-auto w-full max-w-sm space-y-2">
            <Avatar className="w-12 h-12" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              &ldquo;The mechanical keyboard I bought from here is the best
              I&apos;ve ever used. The keys are so satisfying to press!&ldquo;
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              - Happy Customer
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/gB6hNorMXWB
 * Documentation: https://v0.dev/docs#integrating-generated-code-into-your-nextjs-app
 */
import Image from "next/image";

type Profile = {
  name: string;
  username: string;
  description: string;
  experience: string;
  skills: string[];
};

type Category = {
  title: string;
  profiles: Profile[];
};

const data: Category[] = [
  {
    title: "Tech",
    profiles: [
      {
        name: "Alice Johnson",
        username: "@alicejohnson",
        description: "Ph.D. in Natural Language Processing",
        experience: "10 years of experience in AI",
        skills: ["NLP", "AI", "Expert"],
      },
    ],
  },
  {
    title: "Business",
    profiles: [
      {
        name: "Claire Rodriguez",
        username: "@clairerodriguez",
        description: "Serial Entrepreneur",
        experience: "Expert in Growth Hacking",
        skills: ["Entrepreneurship", "Growth Hacking", "Expert"],
      },
    ],
  },
  {
    title: "Finance",
    profiles: [
      {
        name: "David Lee",
        username: "@davidlee",
        description: "Expert in Tax Law",
        experience: "15 years of experience in Finance",
        skills: ["Taxes", "Finance", "Expert"],
      },
      {
        name: "Emma Brown",
        username: "@emmabrown",
        description: "Investment Advisor",
        experience: "Expert in Portfolio Management",
        skills: ["Investment", "Finance", "Expert"],
      },
      {
        name: "Sophia Turner",
        username: "@sophiaturner",
        description: "CPA with 20 years of experience",
        experience: "Expert in Corporate Accounting",
        skills: ["Accounting", "Finance", "Expert"],
      },
    ],
  },
];

export function FindExperts() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [subdomains, setSubdomains] = useState<Subdomain[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const response = await fetch("/api/consultant/info");
        const data = await response.json();
        if (data.data.domains && Array.isArray(data.data.domains)) {
          setDomains(data.data.domains);
        }
        if (data.data.subdomains && Array.isArray(data.data.subdomains)) {
          setSubdomains(data.data.subdomains);
        }
      } catch (error) {
        console.error("Error fetching domains and subdomains:", error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  return (
    <div key="1" className="w-full px-4 py-6 space-y-6 md:px-6 md:py-12">
      <div className="flex flex-col space-y-2">
        <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
          Find an Expert
        </h1>
        <p className="text-gray-500 grid-rows-2 dark:text-gray-400">
          Search for experts in various fields. Enter keywords to find experts
          in specific areas.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
          <div>
            <label
              className="block mb-2 text-sm font-medium text-gray-900 dark:text-gray-300"
              htmlFor="domain"
            >
              Domain
            </label>
            <Select disabled={isLoading}>
              <SelectTrigger id="domain" aria-label="Select domain">
                <SelectValue
                  placeholder={
                    isLoading ? "Loading domains..." : "Select domain"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {isLoading ? (
                  <SelectItem value="loading" disabled>
                    Loading domains...
                  </SelectItem>
                ) : (
                  domains.map((domain) => (
                    <SelectItem key={domain} value={domain.toLowerCase()}>
                      {domain}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-4">
            <label
              className="block mb-2 text-sm font-medium text-gray-900 dark:text-gray-300"
              htmlFor="subdomain"
            >
              Subdomain
            </label>
            <Select disabled={isLoading}>
              <SelectTrigger id="subdomain" aria-label="Select subdomain">
                <SelectValue
                  placeholder={
                    isLoading ? "Loading subdomains..." : "Select subdomain"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {isLoading ? (
                  <SelectItem value="loading" disabled>
                    Loading subdomains...
                  </SelectItem>
                ) : (
                  subdomains.map((subdomain) => (
                    <SelectItem key={subdomain} value={subdomain.toLowerCase()}>
                      {subdomain}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
          <div>
            <label
              className="block mb-2 text-sm font-medium text-gray-900 dark:text-gray-300"
              htmlFor="tags"
            >
              Tags
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white mt-2"
                id="tags"
                placeholder="NLP, Leadership, Taxes"
                type="text"
              />
              <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                NLP
                <button className="ml-2 inline-flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-gray-400">
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
              <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                Leadership
                <button className="ml-2 inline-flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-gray-400">
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
              <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                Taxes
                <button className="ml-2 inline-flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-gray-400">
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            </div>
          </div>
        </div>
        <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
          <div>
            <label
              className="block mb-2 text-sm font-medium text-gray-900 dark:text-gray-300"
              htmlFor="experience"
            >
              Experience Years
            </label>
            <input
              max="30"
              min="0"
              type="range"
              list="experience-ticks"
              className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-black focus:border-black block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
            />
            <datalist id="experience-ticks">
              <option value="0" label="0" />
              <option value="5" label="5" />
              <option value="10" label="10" />
              <option value="15" label="15" />
              <option value="20" label="20" />
              <option value="25" label="25" />
              <option value="30" label="30+" />
            </datalist>
          </div>
        </div>
        <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
          <div>
            <label
              className="block mb-2 text-sm font-medium text-gray-900 dark:text-gray-300"
              htmlFor="pricing"
            >
              Pricing
            </label>
            <input
              className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-black focus:border-black block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
              id="pricing"
              max="1000"
              min="0"
              type="range"
              list="pricing-ticks"
            />
            <datalist id="pricing-ticks">
              <option value="0" label="$0" />
              <option value="250" />
              <option value="500" label="$500" />
              <option value="750" />
              <option value="1000" label="$1000+" />
            </datalist>
          </div>
        </div>
      </div>
      <div className="border border-gray-200 rounded-lg grid items-center p-2 dark:border-gray-800">
        <Input
          className="appearance-none w-full border-0 focus:outline-none placeholder-gray-500 dark:placeholder-gray-400"
          placeholder="Search for experts"
          type="search"
        />
      </div>
      <div className="space-y-4">
        {data.map((category) => (
          <div key={category.title} className="space-y-2">
            <h2 className="text-xl font-semibold">{category.title}</h2>
            <div className="space-y-4">
              {category.profiles.map((profile) => (
                <div
                  key={profile.username}
                  className="border border-gray-200 rounded-lg p-4 flex items-center justify-between space-x-4 dark:border-gray-800"
                >
                  <div className="flex items-center space-x-4">
                    <Image
                      alt="Portrait"
                      className="rounded-full overflow-hidden"
                      height="80"
                      src="/placeholder.svg"
                      style={{ aspectRatio: "80/80", objectFit: "cover" }}
                      width="80"
                    />
                    <div className="space-y-1.5">
                      <div className="flex items-center space-x-2">
                        <h3 className="font-semibold">{profile.name}</h3>
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          {profile.username}
                        </span>
                      </div>
                      <div className="text-sm grid gap-0.5">
                        <p>{profile.description}</p>
                        <p>{profile.experience}</p>
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          {profile.skills.map((skill) => (
                            <span
                              key={skill}
                              className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200"
                            >
                              {skill}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex">
                    <div className="bg-card rounded-lg shadow-lg w-[320px] mr-4">
                      <Tabs defaultValue="1-month" className="w-full">
                        <TabsList className="grid grid-cols-4 border-b">
                          <TabsTrigger value="1-month">1 Month</TabsTrigger>
                          <TabsTrigger value="3-month">3 Months</TabsTrigger>
                          <TabsTrigger value="6-month">6 Months</TabsTrigger>
                          <TabsTrigger value="12-month">12 Months</TabsTrigger>
                        </TabsList>
                        <TabsContent value="1-month">
                          <Card className="rounded-b-lg">
                            <CardContent className="grid gap-4 p-6">
                              <div className="flex items-center justify-between">
                                <div className="text-4xl font-bold">$99</div>
                                <div className="text-muted-foreground">
                                  per month
                                </div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Calls per week</div>
                                <div className="font-medium">1</div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Email support</div>
                                <div className="font-medium">Unlimited</div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Video meetings</div>
                                <div className="font-medium">1 per month</div>
                              </div>
                            </CardContent>
                          </Card>
                        </TabsContent>
                        <TabsContent value="3-month">
                          <Card className="rounded-b-lg">
                            <CardContent className="grid gap-4 p-6">
                              <div className="flex items-center justify-between">
                                <div className="text-4xl font-bold">$79</div>
                                <div className="text-muted-foreground">
                                  per month
                                </div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Calls per week</div>
                                <div className="font-medium">3</div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Email support</div>
                                <div className="font-medium">Unlimited</div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Video meetings</div>
                                <div className="font-medium">2 per month</div>
                              </div>
                            </CardContent>
                          </Card>
                        </TabsContent>
                        <TabsContent value="6-month">
                          <Card className="rounded-b-lg">
                            <CardContent className="grid gap-4 p-6">
                              <div className="flex items-center justify-between">
                                <div className="text-4xl font-bold">$59</div>
                                <div className="text-muted-foreground">
                                  per month
                                </div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Calls per week</div>
                                <div className="font-medium">6</div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Email support</div>
                                <div className="font-medium">Unlimited</div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Video meetings</div>
                                <div className="font-medium">4 per month</div>
                              </div>
                            </CardContent>
                          </Card>
                        </TabsContent>
                        <TabsContent value="12-month">
                          <Card className="rounded-b-lg">
                            <CardContent className="grid gap-4 p-6">
                              <div className="flex items-center justify-between">
                                <div className="text-4xl font-bold">$39</div>
                                <div className="text-muted-foreground">
                                  per month
                                </div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Calls per week</div>
                                <div className="font-medium">12</div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Email support</div>
                                <div className="font-medium">Unlimited</div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div>Video meetings</div>
                                <div className="font-medium">8 per month</div>
                              </div>
                            </CardContent>
                          </Card>
                        </TabsContent>
                      </Tabs>
                    </div>
                    <div className="flex flex-col items-cen space-y-2 pt-5 justify-start">
                      <Button className="w-[140px]" variant="outline">
                        Book a Free Trial
                      </Button>
                      <Button className="w-[140px]" variant="outline">
                        Book a Session
                      </Button>
                      <Button className="w-[140px]" variant="outline">
                        Book Mentorship
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function XIcon(props: any) {
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
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/7C8g2UpU0QT
 * Documentation: https://v0.dev/docs#integrating-generated-code-into-your-nextjs-app
 */

/** Add fonts into your Next.js project:

import { Inter } from 'next/font/google'

inter({
  subsets: ['latin'],
  display: 'swap',
})

To read more about using these font, please visit the Next.js documentation:
- App Directory: https://nextjs.org/docs/app/building-your-application/optimizing/fonts
- Pages Directory: https://nextjs.org/docs/pages/building-your-application/optimizing/fonts
**/
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function ConsultantPricing() {
  return (
    <div className="flex items-start gap-6 w-full max-w-[900px]">
      <div className="bg-card rounded-lg shadow-lg w-[320px]">
        <Tabs defaultValue="1-month" className="w-full">
          <TabsList className="grid grid-cols-4 border-b">
            <TabsTrigger value="1-month">1 Month</TabsTrigger>
            <TabsTrigger value="3-month">3 Months</TabsTrigger>
            <TabsTrigger value="6-month">6 Months</TabsTrigger>
            <TabsTrigger value="12-month">12 Months</TabsTrigger>
          </TabsList>
          <TabsContent value="1-month">
            <Card className="rounded-b-lg">
              <CardContent className="grid gap-4 p-6">
                <div className="flex items-center justify-between">
                  <div className="text-4xl font-bold">$99</div>
                  <div className="text-muted-foreground">per month</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Calls per week</div>
                  <div className="font-medium">1</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Email support</div>
                  <div className="font-medium">Unlimited</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Video meetings</div>
                  <div className="font-medium">1 per month</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Dedicated account manager</div>
                  <div className="font-medium">No</div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="3-month">
            <Card className="rounded-b-lg">
              <CardContent className="grid gap-4 p-6">
                <div className="flex items-center justify-between">
                  <div className="text-4xl font-bold">$79</div>
                  <div className="text-muted-foreground">per month</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Calls per week</div>
                  <div className="font-medium">3</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Email support</div>
                  <div className="font-medium">Unlimited</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Video meetings</div>
                  <div className="font-medium">2 per month</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Dedicated account manager</div>
                  <div className="font-medium">No</div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="6-month">
            <Card className="rounded-b-lg">
              <CardContent className="grid gap-4 p-6">
                <div className="flex items-center justify-between">
                  <div className="text-4xl font-bold">$59</div>
                  <div className="text-muted-foreground">per month</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Calls per week</div>
                  <div className="font-medium">6</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Email support</div>
                  <div className="font-medium">Unlimited</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Video meetings</div>
                  <div className="font-medium">4 per month</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Dedicated account manager</div>
                  <div className="font-medium">Yes</div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="12-month">
            <Card className="rounded-b-lg">
              <CardContent className="grid gap-4 p-6">
                <div className="flex items-center justify-between">
                  <div className="text-4xl font-bold">$39</div>
                  <div className="text-muted-foreground">per month</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Calls per week</div>
                  <div className="font-medium">12</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Email support</div>
                  <div className="font-medium">Unlimited</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Video meetings</div>
                  <div className="font-medium">8 per month</div>
                </div>
                <div className="flex items-center justify-between">
                  <div>Dedicated account manager</div>
                  <div className="font-medium">Yes</div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
      <div className="flex flex-col gap-4">
        <Button size="lg">Book a Call</Button>
        <Button size="lg" variant="outline">
          Contact Sales
        </Button>
        <Button size="lg" variant="outline">
          Learn More
        </Button>
        <Button size="lg" variant="outline">
          Try for Free
        </Button>
      </div>
    </div>
  );
}
