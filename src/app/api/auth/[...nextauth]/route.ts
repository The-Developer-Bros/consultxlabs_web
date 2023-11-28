import { FirestoreAdapter } from "@next-auth/firebase-adapter";
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { NextAuthOptions } from "next-auth";
import NextAuth from "next-auth/next";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";

const firebaseConfig: Record<string, string> = {
  apiKey: process.env.FIREBASE_API_KEY ?? "",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.FIREBASE_APP_ID ?? "",
  measurementId: process.env.FIREBASE_MEASUREMENT_ID ?? "",
};

const firebaseApp = initializeApp(firebaseConfig);
const firestore = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    }),
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  adapter: FirestoreAdapter(firestore as any),
  // callbacks: {
  //   async signIn({ user, account, profile, email, credentials }) {
  //     return true;
  //   },
  //   async redirect({ url, baseUrl }) {
  //     return baseUrl;
  //   },
  //   async session({ session, token, user }) {
  //     return session;
  //   },
  //   async jwt({ token, user, account, profile, isNewUser }) {
  //     return token;
  //   },
  // },
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
  //   newUser: null, // If set, new users will be directed here on first sign in
  // }
};

export default NextAuth(authOptions);
