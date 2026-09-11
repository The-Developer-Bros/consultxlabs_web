import type { MetadataRoute } from "next";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: { path: string; priority: number }[] = [
    { path: "/", priority: 1.0 },
    { path: "/explore/experts", priority: 0.9 },
    { path: "/explore/recordings", priority: 0.7 },
    { path: "/about", priority: 0.8 },
    { path: "/pricing", priority: 0.8 },
    { path: "/contactus", priority: 0.7 },
  ];

  return staticRoutes.map(({ path, priority }) => ({
    url: `${BASE_URL}${path}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority,
  }));
}
