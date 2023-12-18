"use client";
/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/fveGq6CZgm9
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import Navbar from "@/components/navbar";

export default function Programs() {
  return (
    <>
      <Navbar />
      {/* <div className="bg-white xl:py-40 lg:py-32 md:py-24 sm:py-16 py-12"> */}
      <div className="bg-white mt-20 sm:mt-30 md:mt-30 lg:mt-30 xl:mt-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col">
            <div className="flex justify-between border-b border-gray-200 py-6">
              <div className="flex space-x-4">
                <Button className="bg-gray-100 text-gray-900" variant="ghost">
                  Home
                </Button>
                <Button className="text-gray-900" variant="ghost">
                  Events
                </Button>
                <Button className="text-gray-900" variant="ghost">
                  Hackathons
                </Button>
                <Button className="text-gray-900" variant="ghost">
                  Webinars
                </Button>
                <Button className="text-gray-900" variant="ghost">
                  Community
                </Button>
              </div>
              <div>
                <Input className="border-gray-300" placeholder="Search" />
              </div>
            </div>
            <div className="flex space-x-2 py-4">
              <Button className="bg-gray-100 text-gray-900" variant="ghost">
                Upcoming
              </Button>
              <Button className="text-gray-900" variant="ghost">
                Past Events
              </Button>
              <Button className="text-gray-900" variant="ghost">
                Popular
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-6">
              <Card className="w-full">
                <img
                  alt="Event thumbnail"
                  className="aspect-video"
                  height="180"
                  src="/placeholder.svg"
                  width="320"
                />
                <div className="p-4">
                  <h3 className="text-lg font-semibold">AI Hackathon 2024</h3>
                  <p className="text-gray-500">Starts in 3 days</p>
                </div>
              </Card>
              <Card className="w-full">
                <img
                  alt="Event thumbnail"
                  className="aspect-video"
                  height="180"
                  src="/placeholder.svg"
                  width="320"
                />
                <div className="p-4">
                  <h3 className="text-lg font-semibold">
                    Online Web Development Workshop
                  </h3>
                  <p className="text-gray-500">Starts in 1 week</p>
                </div>
              </Card>
              <Card className="w-full">
                <img
                  alt="Event thumbnail"
                  className="aspect-video"
                  height="180"
                  src="/placeholder.svg"
                  width="320"
                />
                <div className="p-4">
                  <h3 className="text-lg font-semibold">
                    Data Science Seminar
                  </h3>
                  <p className="text-gray-500">Starts in 2 weeks</p>
                </div>
              </Card>
              <Card className="w-full">
                <img
                  alt="Event thumbnail"
                  className="aspect-video"
                  height="180"
                  src="/placeholder.svg"
                  width="320"
                />
                <div className="p-4">
                  <h3 className="text-lg font-semibold">
                    Blockchain Hackathon 2024
                  </h3>
                  <p className="text-gray-500">Starts in 3 weeks</p>
                </div>
              </Card>
              <Card className="w-full">
                <img
                  alt="Event thumbnail"
                  className="aspect-video"
                  height="180"
                  src="/placeholder.svg"
                  width="320"
                />
                <div className="p-4">
                  <h3 className="text-lg font-semibold">
                    Offline Networking Event
                  </h3>
                  <p className="text-gray-500">Starts in 1 month</p>
                </div>
              </Card>
              <Card className="w-full">
                <img
                  alt="Event thumbnail"
                  className="aspect-video"
                  height="180"
                  src="/placeholder.svg"
                  width="320"
                />
                <div className="p-4">
                  <h3 className="text-lg font-semibold">
                    Online Consultation with Industry Experts
                  </h3>
                  <p className="text-gray-500">Available now</p>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
