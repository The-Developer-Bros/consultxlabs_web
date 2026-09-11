import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * App-router not-found boundary for `/dashboard/organization/[orgId]/**`.
 *
 * Fires when a sub-page explicitly calls `notFound()` (e.g. layout-level
 * fetch of `fetchOrgDetails` returns null because the orgId doesn't
 * exist or the caller lost membership). Sends the user back to the org
 * switcher landing instead of the platform root so they keep their
 * dashboard context.
 */
export default function OrgDashboardNotFound() {
  return (
    <div className="container mx-auto pt-24 py-8 px-4 min-h-[calc(100vh-400px)]">
      <Card className="max-w-2xl mx-auto text-center">
        <CardHeader>
          <CardTitle>Organization not found</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            We couldn&apos;t find what you were looking for. The
            organization may have been deleted, or you may no longer be a
            member.
          </p>
        </CardContent>
        <CardFooter className="justify-center space-x-4">
          <Button variant="outline" asChild>
            <Link href="/dashboard">Back to your organizations</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
