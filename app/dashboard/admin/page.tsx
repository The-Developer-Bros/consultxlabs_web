import { redirect } from "next/navigation";

/**
 * Redirect page for /dashboard/admin
 * This page catches requests to /dashboard/admin (without subpath)
 * and redirects to /dashboard/admin/home.
 *
 * Server-side redirect(): resolves during the RSC render — one hop, no
 * skeleton paint + hydration + client replace chain (the old client stub
 * flashed HomeSkeleton on every entry).
 */
export default function AdminDashboardRedirect() {
  redirect("/dashboard/admin/home");
}
