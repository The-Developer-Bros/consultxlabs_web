"use client";
/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/vLaw30kyQ2m
 */
import Link from "next/link";
import { CardHeader, CardContent, Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";

import React from "react";
import { SearchExperts } from "@/components/search-experts";

const categories = [
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

export default function ExploreExperts() {
  return (
    <>
      <section className="w-full border-y pt-24 md:pt-48 lg:pt-64 xl:pt-80">
        <div className="px-4 md:px-6 space-y-10 xl:space-y-16">
          <div className="grid max-w-[1300px] mx-auto gap-4 px-4 sm:px-6 md:px-10 md:grid-cols-2 md:gap-16">
            <div>
              <h1 className="lg:leading-tighter text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl xl:text-[3.4rem] 2xl:text-[3.75rem]">
                The Best Experts in the World
              </h1>
            </div>
            <div className="flex flex-col items-start space-y-4">
              <p className="mx-auto max-w-[700px] text-gray-500 md:text-xl dark:text-gray-400">
                Explore our wide range of consultants and find the right one for
                your business.
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
          <img
            alt="Hero"
            className="mx-auto aspect-[3/1] overflow-hidden rounded-t-xl object-cover"
            height="300"
            src="/placeholder.svg"
            width="1270"
          />
        </div>
      </section>
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
      <SearchExperts />
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
