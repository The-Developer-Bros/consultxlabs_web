import { FirestoreAdapter } from "@next-auth/firebase-adapter";
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { NextAuthOptions } from "next-auth";
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

export const options: NextAuthOptions = {
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
  callbacks: {
    async signIn(params) {
      const { user, account, profile } = params;
      return true;
    },
    async redirect(params) {
      const { url, baseUrl } = params;
      return baseUrl;
    },
    async session(params) {
      const { session, user } = params;
      return session;
    },
    async jwt(params) {
      const { token, user, account, profile, isNewUser } = params;
      return token;
    },
  },
};
