import NextAuth, { DefaultSession } from "next-auth";

declare module "next-auth" {
  /**
   * Returned by `useSession`, `getSession` and received as a prop on the `Provider` React Context
   */
  interface Session extends DefaultSession {
    // supabaseToken?: string;
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}
