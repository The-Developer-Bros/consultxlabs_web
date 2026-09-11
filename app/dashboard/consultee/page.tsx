import { redirect } from "next/navigation";

/**
 * Catches `/dashboard/consultee` without a profile id and hands off to
 * `/dashboard`, which does the role-based routing.
 *
 * Was a client component that rendered a spinner and called
 * `router.replace` in an effect — so the browser fetched a page, ran React,
 * hydrated, and only then navigated. A server redirect resolves it in the
 * response, with no spinner frame and no JS on the critical path.
 */
export default function ConsulteeDashboardRedirect() {
  redirect("/dashboard");
}
