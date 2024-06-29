/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/NMUnITsXJat
 */
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import Image from "next/image";

export default function Hackathon() {
  return (
    <>
      <div
        className="relative bg-gray-50/90 py-12 lg:py-16"
        style={{ paddingTop: "160px" }}
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center justify-center gap-4 text-center md:gap-10">
            <div className="space-y-3">
              <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
                Join the Hackathon
              </h2>
              <p className="mx-auto max-w-[600px] text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
                Get ready to build something amazing. The hackathon is a
                collaborative event where you can turn your ideas into reality.
              </p>
            </div>
            <div className="mx-auto max-w-sm space-y-2">
              <Input
                className="w-full border-gray-200 dark:border-gray-800"
                placeholder="Enter your email"
                type="email"
              />
              <Button className="w-full">Sign Up</Button>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Sign up to receive updates. We'll never share your email.
              </p>
            </div>
          </div>
        </div>
        {/* <Image
          alt="Hero"
          className="absolute inset-0 object-cover pointer-events-none hidden lg:grid"
          height="320"
          src="/placeholder.svg"
          style={{
            aspectRatio: "1440/320",
            objectFit: "cover",
          }}
          width="1440"
        /> */}
      </div>
      <section className="w-full py-12 md:py-24 lg:py-32">
        {" "}
        <div className="grid items-center justify-center gap-4 px-4 text-center md:gap-10 lg:px-6">
          {" "}
          <div className="space-y-3">
            {" "}
            <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
              {" "}
              Hackathon Schedule{" "}
            </h2>{" "}
            <p className="mx-auto max-w-3xl text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
              {" "}
              Here's a breakdown of the hackathon schedule. Mark your calendars!{" "}
            </p>{" "}
          </div>{" "}
          <div className="mx-auto grid w-full max-w-3xl items-start gap-4">
            {" "}
            <div className="grid w-full grid-cols-[1fr_4fr] items-start">
              {" "}
              <div className="flex w-10 h-10 items-center justify-center rounded-full border border-gray-200 bg-gray-900 text-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
                {" "}
                1{" "}
              </div>{" "}
              <div className="space-y-1">
                {" "}
                <h3 className="font-semibold">Opening Ceremony</h3>{" "}
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {" "}
                  Let's kick things off! Join us for the opening ceremony where
                  we'll introduce the judges and go over the rules.{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
            <div className="grid w-full grid-cols-[1fr_4fr] items-start">
              {" "}
              <div className="flex w-10 h-10 items-center justify-center rounded-full border border-gray-200 bg-gray-900 text-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
                {" "}
                2{" "}
              </div>{" "}
              <div className="space-y-1">
                {" "}
                <h3 className="font-semibold">Hacking Begins</h3>{" "}
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {" "}
                  It's time to start hacking! You have 24 hours to build
                  something amazing.{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
            <div className="grid w-full grid-cols-[1fr_4fr] items-start">
              {" "}
              <div className="flex w-10 h-10 items-center justify-center rounded-full border border-gray-200 bg-gray-900 text-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
                {" "}
                3{" "}
              </div>{" "}
              <div className="space-y-1">
                {" "}
                <h3 className="font-semibold">Workshops</h3>{" "}
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {" "}
                  We'll have a series of workshops on topics like design,
                  pitching, and more. Don't miss out!{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
            <div className="grid w-full grid-cols-[1fr_4fr] items-start">
              {" "}
              <div className="flex w-10 h-10 items-center justify-center rounded-full border border-gray-200 bg-gray-900 text-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
                {" "}
                4{" "}
              </div>{" "}
              <div className="space-y-1">
                {" "}
                <h3 className="font-semibold">Hacking Ends</h3>{" "}
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {" "}
                  Time's up! Make sure to submit your projects before the
                  deadline.{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
            <div className="grid w-full grid-cols-[1fr_4fr] items-start">
              {" "}
              <div className="flex w-10 h-10 items-center justify-center rounded-full border border-gray-200 bg-gray-900 text-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
                {" "}
                5{" "}
              </div>{" "}
              <div className="space-y-1">
                {" "}
                <h3 className="font-semibold">Judging</h3>{" "}
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {" "}
                  Our judges will review the projects and select the winners.
                  Good luck!{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
            <div className="grid w-full grid-cols-[1fr_4fr] items-start">
              {" "}
              <div className="flex w-10 h-10 items-center justify-center rounded-full border border-gray-200 bg-gray-900 text-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
                {" "}
                6{" "}
              </div>{" "}
              <div className="space-y-1">
                {" "}
                <h3 className="font-semibold">Closing Ceremony</h3>{" "}
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {" "}
                  Join us for the closing ceremony where we'll announce the
                  winners and wrap up the hackathon.{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
          </div>{" "}
        </div>{" "}
      </section>
      <section className="w-full py-12 md:py-24 lg:py-32">
        <div className="grid items-center justify-center gap-4 px-4 text-center md:gap-10 lg:px-6">
          <div className="space-y-3">
            <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
              Hackathon Rules
            </h2>
            <p className="mx-auto max-w-3xl text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
              Make sure you're familiar with the rules before the hackathon
              begins.
            </p>
          </div>
          <div className="mx-auto max-w-3xl space-y-4">
            <div className="grid w-full grid-cols-2 items-center justify-between">
              <div className="font-semibold">Team Size</div>
              <div>2-4 members per team</div>
            </div>
            <div className="grid w-full grid-cols-2 items-center justify-between">
              <div className="font-semibold">Submission Format</div>
              <div>Link to project repository</div>
            </div>
            <div className="grid w-full grid-cols-2 items-center justify-between">
              <div className="font-semibold">Judging Criteria</div>
              <div>Originality, functionality, design</div>
            </div>
            <div className="grid w-full grid-cols-2 items-center justify-between">
              <div className="font-semibold">Prizes</div>
              <div>Top 3 teams win exciting prizes</div>
            </div>
          </div>
        </div>
      </section>
      <section className="w-full py-12 md:py-24 lg:py-32">
        {" "}
        <div className="grid items-center justify-center gap-4 px-4 text-center md:gap-10 lg:px-6">
          {" "}
          <div className="space-y-3">
            {" "}
            <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
              {" "}
              Judging Criteria{" "}
            </h2>{" "}
            <p className="mx-auto max-w-3xl text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
              {" "}
              Your project will be evaluated based on the following criteria.{" "}
            </p>{" "}
          </div>{" "}
          <div className="mx-auto max-w-3xl grid w-full grid-cols-2 items-start gap-4 md:grid-cols-4 md:items-center md:gap-8 lg:max-w-5xl">
            {" "}
            <div className="flex w-full items-center space-x-4">
              {" "}
              <div className="flex w-12 h-12 items-center justify-center rounded-full border border-gray-200 bg-gray-900 text-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
                {" "}
                1{" "}
              </div>{" "}
              <div className="space-y-1">
                {" "}
                <h3 className="font-semibold">Creativity</h3>{" "}
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {" "}
                  How original and innovative is the project?{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
            <div className="flex w-full items-center space-x-4">
              {" "}
              <div className="flex w-12 h-12 items-center justify-center rounded-full border border-gray-200 bg-gray-900 text-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
                {" "}
                2{" "}
              </div>{" "}
              <div className="space-y-1">
                {" "}
                <h3 className="font-semibold">Functionality</h3>{" "}
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {" "}
                  Does the project work as intended? Are all features
                  functional?{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
            <div className="flex w-full items-center space-x-4">
              {" "}
              <div className="flex w-12 h-12 items-center justify-center rounded-full border border-gray-200 bg-gray-900 text-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
                {" "}
                3{" "}
              </div>{" "}
              <div className="space-y-1">
                {" "}
                <h3 className="font-semibold">Design</h3>{" "}
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {" "}
                  Is the user interface well-designed and user-friendly?{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
            <div className="flex w-full items-center space-x-4">
              {" "}
              <div className="flex w-12 h-12 items-center justify-center rounded-full border border-gray-200 bg-gray-900 text-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
                {" "}
                4{" "}
              </div>{" "}
              <div className="space-y-1">
                {" "}
                <h3 className="font-semibold">Innovation</h3>{" "}
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {" "}
                  Does the project introduce new ideas or approaches?{" "}
                </p>{" "}
              </div>{" "}
            </div>{" "}
          </div>{" "}
        </div>{" "}
      </section>
      <section className="w-full py-12 md:py-24 lg:py-32">
        <div className="grid items-center justify-center gap-4 px-4 text-center md:gap-10 lg:px-6">
          <div className="space-y-3">
            <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
              About the Hackathon
            </h2>
            <p className="mx-auto max-w-3xl text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
              The hackathon is a collaborative event where you can turn your
              ideas into reality.
            </p>
          </div>
          <div className="mx-auto max-w-3xl grid w-full grid-cols-2 items-start gap-4 md:grid-cols-4 md:items-center md:gap-8 lg:max-w-5xl">
            <div className="flex w-full items-center space-x-4">
              <CalendarCheckIcon className="w-6 h-6 flex-shrink-0" />
              <div className="space-y-1">
                <h3 className="font-semibold">Dates</h3>
                <p>July 15-16, 2023</p>
              </div>
            </div>
            <div className="flex w-full items-center space-x-4">
              <UsersIcon className="w-6 h-6 flex-shrink-0" />
              <div className="space-y-1">
                <h3 className="font-semibold">Participants</h3>
                <p>Open to all developers</p>
              </div>
            </div>
            <div className="flex w-full items-center space-x-4">
              <GlobeIcon className="w-6 h-6 flex-shrink-0" />
              <div className="space-y-1">
                <h3 className="font-semibold">Location</h3>
                <p>Online</p>
              </div>
            </div>
            <div className="flex w-full items-center space-x-4">
              <TrophyIcon className="w-6 h-6 flex-shrink-0" />
              <div className="space-y-1">
                <h3 className="font-semibold">Prizes</h3>
                <p>Top 3 teams win exciting prizes</p>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="w-full py-12 md:py-24 lg:py-32">
        <div className="grid items-center justify-center gap-4 px-4 text-center md:gap-10 lg:px-6">
          <div className="space-y-3">
            <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
              {" "}
              Contact Us{" "}
            </h2>
            <p className="mx-auto max-w-3xl text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
              {" "}
              Have questions about the hackathon? Reach out to our team.{" "}
            </p>
          </div>
          <div className="mx-auto max-w-lg w-full space-y-4">
            <Input
              placeholder="Enter your email"
              type="email"
              className="w-full px-4 py-3 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <Textarea
              className="w-full min-h-[200px] px-4 py-3 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Your message"
            />
            <Button className="w-full bg-black text-white px-6 py-3 rounded-md">
              {" "}
              Send Message{" "}
            </Button>
          </div>
        </div>
      </section>
      <section className="w-full py-12 md:py-24 lg:py-32">
        <div className="grid items-center justify-center gap-4 px-4 text-center md:gap-10 lg:px-6">
          <div className="space-y-3">
            <h2 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
              Hackathon Imagery
            </h2>
            <p className="mx-auto max-w-3xl text-gray-500 md:text-xl/relaxed lg:text-base/relaxed xl:text-xl/relaxed dark:text-gray-400">
              Here are some images from our past hackathons.
            </p>
          </div>
          <div className="grid w-full grid-cols-2 gap-4 md:grid-cols-3 lg:gap-6">
            <Image
              alt="Hackathon Image"
              className="mx-auto rounded-lg object-cover overflow-hidden aspect-[4/3]"
              height="300"
              src="/placeholder.svg"
              width="480"
            />
            <Image
              alt="Hackathon Image"
              className="mx-auto rounded-lg object-cover overflow-hidden aspect-[4/3]"
              height="300"
              src="/placeholder.svg"
              width="480"
            />
            <Image
              alt="Hackathon Image"
              className="mx-auto rounded-lg object-cover overflow-hidden aspect-[4/3]"
              height="300"
              src="/placeholder.svg"
              width="480"
            />
            <Image
              alt="Hackathon Image"
              className="mx-auto rounded-lg object-cover overflow-hidden aspect-[4/3]"
              height="300"
              src="/placeholder.svg"
              width="480"
            />
            <Image
              alt="Hackathon Image"
              className="mx-auto rounded-lg object-cover overflow-hidden aspect-[4/3]"
              height="300"
              src="/placeholder.svg"
              width="480"
            />
            <Image
              alt="Hackathon Image"
              className="mx-auto rounded-lg object-cover overflow-hidden aspect-[4/3]"
              height="300"
              src="/placeholder.svg"
              width="480"
            />
          </div>
        </div>
      </section>
      <div className="flex w-full items-center justify-center">
        <TwitterIcon className="w-4 h-4 mr-1 flex-shrink-0" />
        <TwitterIcon className="w-4 h-4 mr-1 flex-shrink-0" />
        <TwitterIcon className="w-4 h-4 mr-1 flex-shrink-0" />
        <TwitterIcon className="w-4 h-4 mr-1 flex-shrink-0" />
        <TwitterIcon className="w-4 h-4 mr-1 flex-shrink-0" />
      </div>
      <div className="flex w-full items-center justify-center" />
    </>
  );
}

function CalendarCheckIcon(props: any) {
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
      <path d="m9 16 2 2 4-4" />
    </svg>
  );
}

function UsersIcon(props: any) {
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
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function GlobeIcon(props: any) {
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
      <circle cx="12" cy="12" r="10" />
      <line x1="2" x2="22" y1="12" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function TrophyIcon(props: any) {
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
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

function TwitterIcon(props: any) {
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
      <path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z" />
    </svg>
  );
}
