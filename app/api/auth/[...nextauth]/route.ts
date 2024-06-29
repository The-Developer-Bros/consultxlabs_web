import NextAuth from "next-auth/next";
import authOptions from "./options";

// Important: The "options" and "routes" must be in separate files.

// The "as never" is a workaround for a TypeScript error.
// The error occurs when deploying to Vercel/Netlify/Render and is caused by the way NextAuth is implemented.
export const authHandler = NextAuth(authOptions) as never;
export { authHandler as GET, authHandler as POST };
