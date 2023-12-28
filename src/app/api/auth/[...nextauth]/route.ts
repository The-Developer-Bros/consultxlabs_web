import {
  firebaseAdminAuth,
  firebaseAdminDb,
} from "@/app/firebase-admin.config";
import { FirestoreAdapter } from "@next-auth/firebase-adapter";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { Account, NextAuthOptions, Profile, Session, User } from "next-auth";
import { AdapterUser } from "next-auth/adapters";
import { JWT } from "next-auth/jwt";
import NextAuth from "next-auth/next";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";

import prisma from "@/lib/prisma";

// DONT EXPORT authOptions if using Docker
const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  // adapter: FirestoreAdapter(firebaseAdminDb),
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
    //////////////////////////// NEWER BUGGY VERSION ////////////////////////////

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
      if (account?.provider === "google" || account?.provider === "github") {
        // Check if user is in your database
        const userRef = firebaseAdminDb.collection("users").doc(user.id);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
          // If the user is not in the database, create a new user in Firebase
          try {
            const newUser = await firebaseAdminAuth.createUser({
              uid: user.id,
              email: user.email as string,
              displayName: user.name as string,
            });
            console.log("New user created in Firebase:", newUser.uid);
          } catch (error) {
            console.error("Error creating new user in Firebase:", error);
            return false;
          }
        }
        return true;
      }
      return false;
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

      if (session?.user && !session.firebaseToken && token.sub) {
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
