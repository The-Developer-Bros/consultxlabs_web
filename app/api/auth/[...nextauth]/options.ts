import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { Account, NextAuthOptions, Profile, Session, User } from "next-auth";
import { AdapterUser } from "next-auth/adapters";
import { JWT } from "next-auth/jwt";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import prisma from "@/lib/prisma";

// DONT EXPORT authOptions if using Docker
const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  session: { strategy: "jwt" },
  jwt: {
    maxAge: 30 * (24 * 60 * 60), // 30 days
    secret: process.env.JWT_SECRET!,
  },

  callbacks: {
    async signIn({
      user,
      account,
      profile,
      email,
      credentials,
    }: {
      user: User | AdapterUser;
      account: Account | null;
      profile?: Profile;
      email?: string | { verificationRequest?: boolean };
      credentials?: any;
    }): Promise<boolean | string> {
      try {
        // Add any custom sign-in logic here
        return true;
      } catch (error) {
        console.error("Error during sign-in:", error);
        // Handle the error as needed
        return false; // or redirect to an error page
      }
    },

    async jwt({
      token,
      user,
      account,
      profile,
      isNewUser,
    }: {
      token: JWT;
      user: User | AdapterUser;
      account: Account | null;
      profile?: Profile;
      isNewUser?: boolean;
    }): Promise<any> {
      try {
        if (user) {
          token.sub = user.id;
        } else if (account?.providerAccountId) {
          token.accountId = account.providerAccountId;
        } else if (profile) {
          token.profile = profile;
        }
        // Optionally handle isNewUser or other properties
        return token;
      } catch (error) {
        console.error("Error during JWT callback:", error);
        // Handle the error as needed
        return token; // Ensure token is returned even in error cases
      }
    },  

    async session({
      session,
      token,
      user,
    }: {
      session: Session;
      token: JWT;
      user: User | AdapterUser;
    }): Promise<any> {
      try {
        if (session?.user && token.sub) {
          session.user.id = token.sub;

          const user = await prisma.user.findUnique({
            where: {
              email: session.user.email ?? "",
            },
          });

          session.user.email = user?.email;
          session.user.name = user?.name;
          session.user.image = user?.image;
          session.user.phone = user?.phone ?? "";
          session.user.address = user?.address ?? "";
          session.user.onboardingCompleted = user?.onboardingCompleted ?? false;
          session.user.role = user?.role ?? "CONSULTEE";
        }
        return session;
      } catch (error) {
        console.error("Error during session callback:", error);
        // Handle the error as needed, such as setting default values
        return session;
      }
    },

    async redirect({
      url,
      baseUrl,
    }: {
      url: string;
      baseUrl: string;
    }): Promise<string> {
      try {
        return baseUrl + "/dashboard";
      } catch (error) {
        console.error("Error during redirect callback:", error);
        // Handle the error as needed
        return baseUrl;
      }
    },
  },
  // theme: {
  //   colorScheme: "auto", // "auto" | "dark" | "light"
  //   brandColor: "", // Hex color value
  //   logo: "", // Absolute URL to logo image
  // },
  // pages: {
  //   signIn: "/auth/signin",
  //   signOut: "/auth/signout",
  //   error: "/auth/error",
  //   verifyRequest: "/auth/verify-request",
  //   // newUser: null, // If set, new users will be directed here on first sign in
  // }
};

export default authOptions;
