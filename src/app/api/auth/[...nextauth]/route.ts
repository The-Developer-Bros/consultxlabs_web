import {
  firebaseAdminAuth,
  firebaseAdminDb,
} from "@/app/firebase-admin.config";
import { firebaseAuth } from "@/app/firebase.config";
import { FirestoreAdapter } from "@next-auth/firebase-adapter";
import { signInWithCustomToken } from "firebase/auth";
import firebase from "firebase/compat/app";
import { Account, NextAuthOptions, Profile, Session, User } from "next-auth";
import { AdapterUser } from "next-auth/adapters";
import { JWT } from "next-auth/jwt";
import NextAuth from "next-auth/next";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";

const authOptions: NextAuthOptions = {
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
  adapter: FirestoreAdapter(firebaseAdminDb),
  session: { strategy: "jwt" },
  jwt: {
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
      email?: { verificationRequest?: boolean };
      credentials?: any;
    }): Promise<boolean | string> {
      if (account?.provider === "google" || account?.provider === "github") {
        // Check if user is in your database
        // const userSnapshot = await firebase
        //   .firestore()
        //   .collection("users")
        //   .where("email", "==", email)
        //   .get();
        // if (userSnapshot.empty) {
        //   // If the user is not in the database, return an error message
        //   console.log("User not found.Please create an account first.");
        //   return false;
        // }
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
      if (session?.user && !session.firebaseToken) {
        if (token.sub) {
          try {
            session.user.id = token.sub;
            const firebaseToken = await firebaseAdminAuth?.createCustomToken(
              token.sub
            );
            if (!firebaseToken) {
              throw new Error("Failed to create Firebase token.");
            }
            session.firebaseToken = firebaseToken;
            console.log("Firebase token created:", session.firebaseToken);
          } catch (error) {
            console.log("Error creating custom token:", error);
          }

          try {
            if (session.firebaseToken) {
              await signInWithCustomToken(firebaseAuth, session.firebaseToken);
              console.log("Firebase token signed in:", session.firebaseToken);
            }
          } catch (error) {
            console.log("Error signing in with custom token:", error);
          }
        }
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
      return baseUrl;
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
