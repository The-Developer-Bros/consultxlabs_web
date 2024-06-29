"use client";
/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/u214VkmlHz5
 */
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import Image from "next/image";

export default function Feed() {
  return (
    <div className="flex px-4  md:px-6 py-20 md:py-30 lg:py-30 xl:py-40 max-w-7xl mx-auto">
      <aside className="w-1/5 space-y-6">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-bold">Action Items</h2>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              <li>
                <Button variant="outline">Action 1</Button>
              </li>
              <li>
                <Button variant="outline">Action 2</Button>
              </li>
              <li>
                <Button variant="outline">Action 3</Button>
              </li>
            </ul>
          </CardContent>
        </Card>
      </aside>
      <main className="w-3/5 px-4 space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Avatar className="h-9 w-9">
                <AvatarImage alt="User Avatar" src="/placeholder-avatar.jpg" />
                <AvatarFallback>JP</AvatarFallback>
              </Avatar>
              <div className="grid gap-0.5 text-xs">
                <div className="font-medium">John Doe</div>
                <div className="text-gray-500 dark:text-gray-400">
                  Posted on December 12, 2023
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Image
              alt="Post related"
              className="w-full h-48 object-cover mb-4"
              height="200"
              src="/placeholder.svg"
              style={{
                aspectRatio: "500/200",
                objectFit: "cover",
              }}
              width="500"
            />
            <h2 className="text-xl font-bold">The Future of Consultancy</h2>
            <p className="mt-2 text-gray-500">
              Consultancy has always been about helping businesses make better
              decisions...
            </p>
            <div className="flex items-center mt-4 space-x-2">
              <Button variant="link">100 Likes</Button>
              <Button variant="link">20 Comments</Button>
              <Button variant="link">3 Shares</Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Avatar className="h-9 w-9">
                <AvatarImage alt="User Avatar" src="/placeholder-avatar.jpg" />
                <AvatarFallback>JP</AvatarFallback>
              </Avatar>
              <div className="grid gap-0.5 text-xs">
                <div className="font-medium">Jane Smith</div>
                <div className="text-gray-500 dark:text-gray-400">
                  Posted on December 15, 2023
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <h2 className="text-xl font-bold">Consultancy in the Age of AI</h2>
            <p className="mt-2 text-gray-500">
              As AI continues to evolve, what does this mean for the consultancy
              industry...
            </p>
            <div className="flex items-center mt-4 space-x-2">
              <Button variant="link">150 Likes</Button>
              <Button variant="link">30 Comments</Button>
              <Button variant="link">5 Shares</Button>
            </div>
          </CardContent>
        </Card>
      </main>
      <aside className="w-1/5 space-y-6">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-bold">More Actions</h2>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              <li>
                <Button variant="link">Action 4</Button>
              </li>
              <li>
                <Button variant="link">Action 5</Button>
              </li>
              <li>
                <Button variant="link">Action 6</Button>
              </li>
            </ul>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
