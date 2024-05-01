import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { Account, NextAuthOptions, Profile, Session, User } from "next-auth";
import { AdapterUser } from "next-auth/adapters";
import { JWT } from "next-auth/jwt";
import NextAuth from "next-auth/next";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";

import { inngestClient } from "@/lib/inngest";
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
      // TODO: Verify if isNewUser is working as expected
      try {
        const isNewUser = await prisma.user.findUnique({
          where: {
            email: user.email!,
          },
        });

        if (!isNewUser) {
          console.log("New user signed up:", user.email);
          await inngestClient.send({
            name: "user/created",
            data: {
              user_first_name: user.name,
              user_email: user.email,
            },
          });
        } else {
          console.log("User signed in:", user.email);
          await inngestClient.send({
            name: "user/signed-in",
            data: {
              user_first_name: user.name,
              user_email: user.email,
            },
          });
        }
        return true;
      } catch (error: any) {
        console.error("Error sending event to Inngest:", error.message);
        return false;
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

const authHandler = NextAuth(authOptions);

export { authHandler as GET, authHandler as POST, authOptions };
