"use client";
/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/10Iw0ehVDhW
 */
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function Community() {
  return (
    <section
      className="w-full mt-12 md:mt-24 lg:mt-32 xl:mt-48 bg-cover bg-center"
      style={{
        backgroundImage: "url('/placeholder.svg?height=1920&width=1080')",
      }}
    >
      <div className="px-4 md:px-6">
        <div className="flex flex-col items-center space-y-4 text-center">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl lg:text-6xl">
              Welcome to Our Community
            </h1>
            <p className="mx-auto max-w-[700px] text-gray-500 md:text-xl dark:text-gray-400">
              Join our community and get the latest updates and news about our
              products and services.
            </p>
          </div>
          <div className="w-full max-w-sm space-y-2">
            <form className="flex space-x-2">
              <Input
                className="max-w-lg flex-1"
                placeholder="Enter your email"
                type="email"
              />
              <Button type="submit" className="bg-black text-white">
                Sign Up
              </Button>
            </form>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              By signing up, you agree to our
              <Link className="underline underline-offset-2" href="#">
                Terms & Conditions
              </Link>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
