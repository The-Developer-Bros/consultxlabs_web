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
    // The callbacks are arranged in the order they are called in when authenticating a user.

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
      return true;
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
      if (user) {
        token.sub = user.id;
      }
      return token;
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
      //////////////////////////// DO NOT REMOVE ////////////////////////////

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
    },

    async redirect({
      url,
      baseUrl,
    }: {
      url: string;
      baseUrl: string;
    }): Promise<string> {
      return baseUrl + "/dashboard";
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
