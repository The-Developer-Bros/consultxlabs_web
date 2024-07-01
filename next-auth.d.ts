import NextAuth, { DefaultSession } from "next-auth";

declare module "next-auth" {
  /**
   * Returned by `useSession`, `getSession` and received as a prop on the `Provider` React Context
   */
  interface Session extends DefaultSession {
    // supabaseToken?: string;
    user: {
      id: string;
      emailVerified: boolean | null;
      phone: string;
      address: string;
      onboardingCompleted: boolean;
      role: string;

      // name, email, image are provided by default
    } & DefaultSession["user"];
  }
}
