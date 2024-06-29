/**
* This code was generated by v0 by Vercel.
* @see https://v0.dev/t/gB6hNorMXWB
* Documentation: https://v0.dev/docs#integrating-generated-code-into-your-nextjs-app
*/
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export function FindExperts() {
  return (
    <div key="1" className="w-full px-4 py-6 space-y-6 md:px-6 md:py-12">
      <div className="flex flex-col space-y-2">
        <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">Find an Expert</h1>
        <p className="text-gray-500 grid-rows-2 dark:text-gray-400">
          Search for experts in various fields. Enter keywords to find experts in specific areas.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
          <div>
            <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-gray-300" htmlFor="domain">
              Domain
            </label>
            <Select>
              <SelectTrigger id="domain" aria-label="Select domain">
                <SelectValue placeholder="Select domain" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tech">Tech</SelectItem>
                <SelectItem value="business">Business</SelectItem>
                <SelectItem value="finance">Finance</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="mt-4">
            <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-gray-300" htmlFor="subdomain">
              Subdomain
            </label>
            <Select>
              <SelectTrigger id="subdomain" aria-label="Select subdomain">
                <SelectValue placeholder="Select subdomain" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Tech</SelectLabel>
                  <SelectItem value="nlp">NLP</SelectItem>
                  <SelectItem value="computer-vision">Computer Vision</SelectItem>
                  <SelectItem value="data-science">Data Science</SelectItem>
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Business</SelectLabel>
                  <SelectItem value="entrepreneurship">Entrepreneurship</SelectItem>
                  <SelectItem value="leadership">Leadership</SelectItem>
                  <SelectItem value="marketing">Marketing</SelectItem>
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Finance</SelectLabel>
                  <SelectItem value="taxes">Taxes</SelectItem>
                  <SelectItem value="investment">Investment</SelectItem>
                  <SelectItem value="accounting">Accounting</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="border border-gray-200 rounded-lg p-4 flex flex-col justify-between dark:border-gray-800">
          <div>
            <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-gray-300" htmlFor="tags">
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
            <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-gray-300" htmlFor="experience">
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
            <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-gray-300" htmlFor="pricing">
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
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Tech</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">NLP</span>
            <span className="text-sm">Computer Vision</span>
            <span className="text-sm">Data Science</span>
          </div>
          <div className="grid gap-4 md:grid-cols-1">
            <div className="border border-gray-200 rounded-lg p-4 flex items-center justify-between space-x-4 dark:border-gray-800">
              <div className="flex items-center space-x-4">
                <img
                  alt="Portrait"
                  className="rounded-full overflow-hidden"
                  height="80"
                  src="/placeholder.svg"
                  style={{ aspectRatio: "80/80", objectFit: "cover" }}
                  width="80"
                />
                <div className="space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <h3 className="font-semibold">Alice Johnson</h3>
                    <span className="text-sm text-gray-500 dark:text-gray-400">@alicejohnson</span>
                  </div>
                  <div className="text-sm grid gap-0.5">
                    <p>Ph.D. in Natural Language Processing</p>
                    <p>10 years of experience in AI</p>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        NLP
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        AI
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Expert
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end space-y-2">
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
            <div className="border border-gray-200 rounded-lg p-4 flex items-center justify-between space-x-4 dark:border-gray-800">
              <div className="flex items-center space-x-4">
                <img
                  alt="Portrait"
                  className="rounded-full overflow-hidden"
                  height="80"
                  src="/placeholder.svg"
                  style={{ aspectRatio: "80/80", objectFit: "cover" }}
                  width="80"
                />
                <div className="space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <h3 className="font-semibold">Bob Smith</h3>
                    <span className="text-sm text-gray-500 dark:text-gray-400">@bobsmith</span>
                  </div>
                  <div className="text-sm grid gap-0.5">
                    <p>Expert in Computer Vision</p>
                    <p>Published 20+ papers in AI</p>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Computer Vision
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        AI
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Expert
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end space-y-2">
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
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Business</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Entrepreneurship</span>
            <span className="text-sm">Leadership</span>
            <span className="text-sm">Marketing</span>
          </div>
          <div className="grid gap-4 md:grid-cols-1">
            <div className="border border-gray-200 rounded-lg p-4 flex items-center justify-between space-x-4 dark:border-gray-800">
              <div className="flex items-center space-x-4">
                <img
                  alt="Portrait"
                  className="rounded-full overflow-hidden"
                  height="80"
                  src="/placeholder.svg"
                  style={{ aspectRatio: "80/80", objectFit: "cover" }}
                  width="80"
                />
                <div className="space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <h3 className="font-semibold">Claire Rodriguez</h3>
                    <span className="text-sm text-gray-500 dark:text-gray-400">@clairerodriguez</span>
                  </div>
                  <div className="text-sm grid gap-0.5">
                    <p>Serial Entrepreneur</p>
                    <p>Expert in Growth Hacking</p>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Entrepreneurship
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Growth Hacking
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Expert
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end space-y-2">
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
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Finance</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Taxes</span>
            <span className="text-sm">Investment</span>
            <span className="text-sm">Accounting</span>
          </div>
          <div className="grid gap-4 md:grid-cols-1">
            <div className="border border-gray-200 rounded-lg p-4 flex items-center justify-between space-x-4 dark:border-gray-800">
              <div className="flex items-center space-x-4">
                <img
                  alt="Portrait"
                  className="rounded-full overflow-hidden"
                  height="80"
                  src="/placeholder.svg"
                  style={{ aspectRatio: "80/80", objectFit: "cover" }}
                  width="80"
                />
                <div className="space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <h3 className="font-semibold">David Lee</h3>
                    <span className="text-sm text-gray-500 dark:text-gray-400">@davidlee</span>
                  </div>
                  <div className="text-sm grid gap-0.5">
                    <p>Expert in Tax Law</p>
                    <p>15 years of experience in Finance</p>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Taxes
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Finance
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Expert
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end space-y-2">
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
            <div className="border border-gray-200 rounded-lg p-4 flex items-center justify-between space-x-4 dark:border-gray-800">
              <div className="flex items-center space-x-4">
                <img
                  alt="Portrait"
                  className="rounded-full overflow-hidden"
                  height="80"
                  src="/placeholder.svg"
                  style={{ aspectRatio: "80/80", objectFit: "cover" }}
                  width="80"
                />
                <div className="space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <h3 className="font-semibold">Emma Brown</h3>
                    <span className="text-sm text-gray-500 dark:text-gray-400">@emmabrown</span>
                  </div>
                  <div className="text-sm grid gap-0.5">
                    <p>Investment Advisor</p>
                    <p>Expert in Portfolio Management</p>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Investment
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Finance
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Expert
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end space-y-2">
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
            <div className="border border-gray-200 rounded-lg p-4 flex items-center justify-between space-x-4 dark:border-gray-800">
              <div className="flex items-center space-x-4">
                <img
                  alt="Portrait"
                  className="rounded-full overflow-hidden"
                  height="80"
                  src="/placeholder.svg"
                  style={{ aspectRatio: "80/80", objectFit: "cover" }}
                  width="80"
                />
                <div className="space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <h3 className="font-semibold">Sophia Turner</h3>
                    <span className="text-sm text-gray-500 dark:text-gray-400">@sophiaturner</span>
                  </div>
                  <div className="text-sm grid gap-0.5">
                    <p>CPA with 20 years of experience</p>
                    <p>Expert in Corporate Accounting</p>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Accounting
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Finance
                      </span>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                        Expert
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end space-y-2">
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
        </div>
      </div>
    </div>
  )
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
  )
}
