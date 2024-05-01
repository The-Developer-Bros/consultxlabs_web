/**
* This code was generated by v0 by Vercel.
* @see https://v0.dev/t/pA10QFZKzHH
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
import Link from "next/link"

export function UserSigninEmailTemplate() {
  return (
    <div className="bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-50 rounded-lg p-6 max-w-[600px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <MountainIcon className="h-8 w-8" />
          <span className="text-xl font-semibold">ConsultX</span>
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">Explore the Platform</div>
      </div>
      <div className="space-y-4">
        <h2 className="text-2xl font-bold">Discover the Power of ConsultX</h2>
        <p className="text-gray-500 dark:text-gray-400">
          Unlock a world of possibilities with our comprehensive consulting platform. Explore the features that can
          transform your business.
        </p>
        <div className="grid gap-4">
          <div className="flex items-start gap-4">
            <BriefcaseIcon className="h-6 w-6 text-gray-900 dark:text-gray-50" />
            <div>
              <h3 className="font-semibold">Expert Consulting</h3>
              <p className="text-gray-500 dark:text-gray-400">
                Leverage the expertise of our seasoned consultants to tackle your toughest challenges.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-4">
            <ClipboardIcon className="h-6 w-6 text-gray-900 dark:text-gray-50" />
            <div>
              <h3 className="font-semibold">Comprehensive Insights</h3>
              <p className="text-gray-500 dark:text-gray-400">
                Gain in-depth analysis and actionable recommendations to drive your business forward.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-4">
            <RocketIcon className="h-6 w-6 text-gray-900 dark:text-gray-50" />
            <div>
              <h3 className="font-semibold">Accelerated Growth</h3>
              <p className="text-gray-500 dark:text-gray-400">
                Unlock new opportunities and scale your business with our innovative solutions.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-4">
            <ShieldIcon className="h-6 w-6 text-gray-900 dark:text-gray-50" />
            <div>
              <h3 className="font-semibold">Secure and Compliant</h3>
              <p className="text-gray-500 dark:text-gray-400">
                Rest assured that your data and operations are protected with our robust security measures.
              </p>
            </div>
          </div>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Explore the full range of features and services offered by ConsultX. Contact us today to learn more and unlock
          your business's true potential.
        </p>
        <div className="flex justify-center">
          <Link
            className="inline-flex items-center justify-center rounded-md bg-gradient-to-r from-black to-gray-500 px-6 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-gradient-to-r hover:from-gray-500 hover:to-black focus:outline-none focus:ring-2 focus:ring-gray-950 focus:ring-offset-2 dark:bg-gradient-to-r dark:from-gray-50 dark:to-gray-400 dark:text-gray-900 dark:hover:bg-gradient-to-r dark:hover:from-gray-400 dark:hover:to-gray-50 dark:focus:ring-gray-300"
            href="#"
          >
            Explore Website
          </Link>
        </div>
      </div>
    </div>
  )
}

function BriefcaseIcon(props) {
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
      <rect width="20" height="14" x="2" y="7" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  )
}


function ClipboardIcon(props) {
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
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  )
}


function MountainIcon(props) {
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
      <path d="m8 3 4 8 5-5 5 15H2L8 3z" />
    </svg>
  )
}


function RocketIcon(props) {
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
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  )
}


function ShieldIcon(props) {
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
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
    </svg>
  )
}
