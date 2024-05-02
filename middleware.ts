import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import micromatch from "micromatch";

const apiRoutes = ["/api/**"];
const authApiRoutes = ["/api/auth/**"];
const inngestApiRoutes = ["/api/inngest/**"];
const protectedRoutes = [
  "/form/**",
  "/admin/**",
  "/dashboard/**",
  "/settings/**",
  "/profile/**",
];
const publicAuthRoutes = ["/auth/**"];
/**
 * Middleware function to handle authentication and authorization for routes.
 * @param req The NextRequest object representing the incoming request.
 * @returns The appropriate NextResponse object based on the authentication and authorization rules.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // const sessionToken = req.cookies.get("next-auth.session-token");
  // const isLoggedIn = sessionToken !== undefined;
  // Check if the user is logged in
  const token = await getToken({ req });
  const isAuthenticated = !!token;
  // Check if the current route is an API route
  if (micromatch.isMatch(pathname, apiRoutes)) {
    // Bypass authentication for the Inngest API routes
    if (micromatch.isMatch(pathname, inngestApiRoutes)) {
      return NextResponse.next();
    }
    if (!micromatch.isMatch(pathname, authApiRoutes)) {
      if (!isAuthenticated) {
        return NextResponse.redirect(new URL("/auth/signin", req.url));
      }
    }
  }
  // Check if the current route is a protected route
  if (micromatch.isMatch(pathname, protectedRoutes)) {
    // Allow access only to authenticated users
    if (!isAuthenticated) {
      const callbackUrl = encodeURIComponent(req.url);
      return NextResponse.redirect(
        new URL(`/auth/signin?callbackUrl=${callbackUrl}`, req.url)
      );
    }
  }
  // Check if the current route is a public route
  if (micromatch.isMatch(pathname, publicAuthRoutes)) {
    // Redirect to the dashboard if the user is already logged in
    if (isAuthenticated) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
  }
  // Allow access to public routes
  return NextResponse.next();
}
export const config = {
  matcher: ["/((?!.+\\.[\\w]+$|_next).*)", "/", "/(api|trpc)(.*)"],
};
