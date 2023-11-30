import { FirestoreAdapter } from "@next-auth/firebase-adapter";
import { profile } from "console";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  GithubAuthProvider,
  GoogleAuthProvider,
  getAuth,
  signInWithPopup,
  signInWithRedirect,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import {
  Account,
  AuthOptions,
  Awaitable,
  Profile,
  Session,
  User,
} from "next-auth";
import { AdapterUser } from "next-auth/adapters";
import { JWT } from "next-auth/jwt";
import NextAuth from "next-auth/next";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";

const firebaseConfig: Record<string, string> = {
  apiKey: process.env.FIREBASE_API_KEY!,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.FIREBASE_PROJECT_ID!,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.FIREBASE_APP_ID!,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID!,
};

const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig); // This is to ensure that we don't initialize the app more than once
const firestore = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

const authOptions: AuthOptions = {
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
  adapter: FirestoreAdapter(firestore as any),
  // callbacks: {
  //   async signIn({
  //     user,
  //     account,
  //     profile,
  //     email,
  //     credentials,
  //   }: {
  //     user: User | AdapterUser;
  //     account: Account | null;
  //     profile?: Profile;
  //     email?: { verificationRequest?: boolean };
  //     credentials?: any;
  //   }): Promise<boolean> {
  //     if (account?.provider === "google") {
  //       const googleProvider = new GoogleAuthProvider();
  //       await signInWithRedirect(auth, googleProvider);
  //     } else if (account?.provider === "github") {
  //       const githubProvider = new GithubAuthProvider();
  //       await signInWithPopup(auth, githubProvider);
  //     }
  //     return true;
  //   },

  //   async redirect({
  //     url,
  //     baseUrl,
  //   }: {
  //     url: string;
  //     baseUrl: string;
  //   }): Promise<string> {
  //     return baseUrl;
  //   },

  //   async session({
  //     session,
  //     token,
  //     user,
  //   }: {
  //     session: Session;
  //     token: JWT;
  //     user: User | AdapterUser;
  //   }): Promise<any> {
  //     return session;
  //   },

  //   async jwt({
  //     token,
  //     user,
  //     account,
  //     profile,
  //     isNewUser,
  //   }: {
  //     token: JWT;
  //     user: User | AdapterUser;
  //     account: Account | null;
  //     profile?: Profile;
  //     isNewUser?: boolean;
  //   }): Promise<any> {
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

const authHandler = NextAuth(authOptions);

export {
  authHandler as GET,
  authHandler as POST,
  auth,
  authOptions,
  firebaseApp,
  firestore,
};
