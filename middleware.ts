import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import micromatch from "micromatch";

const apiRoutes = ["/api/**"];
const authApiRoutes = ["/api/auth/**"];
const protectedRoutes = [
    "/form/**",
    "/admin/**",
    "/dashboard/**",
    "/settings/**",
    "/profile/**"
];

const publicAuthRoutes = ["/auth/**"];

/**
 * Middleware function to handle authentication and authorization for routes.
 * @param req The NextRequest object representing the incoming request.
 * @returns The appropriate NextResponse object based on the authentication and authorization rules.
 */
export async function middleware(req: NextRequest) {
    const { pathname } = req.nextUrl;
    const sessionToken = req.cookies.get("next-auth.session-token");

    // Check if the user is logged in
    const isLoggedIn = sessionToken !== undefined;

    // Check if the current route is an API route
    if (micromatch.isMatch(pathname, apiRoutes) && !micromatch.isMatch(pathname, authApiRoutes)) {
        // Allow access only to users with the "admin" role
        // Redirect to the sign-in page if the user is not logged in or does not have the "admin" role
        const token = await getToken({ req });
        // TODO: Check if the token.sub is an admin using prisma
        if (!isLoggedIn || (token && token.role !== "admin")) {
            return NextResponse.redirect(new URL("/auth/signin", req.url));
        }
    }

    // Check if the current route is a protected route
    if (micromatch.isMatch(pathname, protectedRoutes)) {
        // Allow access only to authenticated users
        if (!isLoggedIn) {
            return NextResponse.redirect(new URL("/auth/signin", req.url));
        }
    }

    // Check if the current route is a public route
    if (micromatch.isMatch(pathname, publicAuthRoutes)) {
        // Redirect to the dashboard if the user is already logged in
        if (isLoggedIn) {
            return NextResponse.redirect(new URL("/dashboard", req.url));
        }
    }

    // Allow access to public routes
    return NextResponse.next();
}

export const config = {
    matcher: ["/((?!.+\\.[\\w]+$|_next).*)", "/", "/(api|trpc)(.*)"],
};