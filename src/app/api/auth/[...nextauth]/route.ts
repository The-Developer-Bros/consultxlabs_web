import {
  firebaseAdminAuth,
  firebaseAdminDb,
} from "@/app/firebase-admin.config";
import { firebaseAuth } from "@/app/firebase.config";
import { FirestoreAdapter } from "@next-auth/firebase-adapter";
import { signInWithCustomToken } from "firebase/auth";
import { Account, NextAuthOptions, Profile, Session, User } from "next-auth";
import { AdapterUser } from "next-auth/adapters";
import { JWT } from "next-auth/jwt";
import NextAuth from "next-auth/next";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";

// DONT EXPORT authOptions if using Docker
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

            // Update the user document with custom token information
            await userRef.set(
              {
                firebaseToken: "", // Set an initial value or leave it empty
                // Add other user data as needed
              },
              { merge: true }
            );
          } catch (error) {
            console.error("Error creating new user in Firebase:", error);
            return false;
          }
        } else {
          console.log("User already exists in Firebase:", user.id);

          // Check if the user document already has a custom token
          const existingToken = userDoc.data()?.firebaseToken;

          if (!existingToken) {
            // Update the user document with custom token information
            try {
              const firebaseToken = await firebaseAdminAuth.createCustomToken(
                user.id
              );
              await userRef.set(
                {
                  firebaseToken: firebaseToken,
                  // Add other user data as needed
                },
                { merge: true }
              );

              console.log(
                "Custom token added to user document:",
                firebaseToken
              );
            } catch (error) {
              console.error("Error creating custom token:", error);
              return false;
            }
          } else {
            console.log(
              "User document already has a custom token:",
              existingToken
            );
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
      // Check if the session has user data and a Firebase token is not present
      if (session?.user && !session.firebaseToken && token.sub) {
        // Update the session with the user's ID from the JWT token
        session.user.id = token.sub;

        if (!firebaseAdminAuth) {
          console.error("No Firebase Admin Auth was initialized.");
          return session;
        }

        const userRef = firebaseAdminDb.collection("users").doc(token.sub);
        const userDoc = await userRef.get();
        const firebaseToken = userDoc.data()?.firebaseToken;

        if (firebaseToken) {
          // If the user document has a custom token, use it in the session
          session.firebaseToken = firebaseToken;
          console.log(
            "Firebase token retrieved from user document:",
            firebaseToken
          );

          // Try signing in with the custom token
          try {
            await signInWithCustomToken(firebaseAuth, firebaseToken);
            console.log("Firebase token signed in:", firebaseToken);
          } catch (error) {
            console.error("Error signing in with custom token:", error);
          }
        } else {
          console.warn("User document does not have a custom token.");
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

//////////////////////////// INTIAL STABLE STATE ////////////////////////////

// async signIn({
//   user,
//   account,
//   profile,
//   email,
//   credentials,
// }: {
//   user: User | AdapterUser;
//   account: Account | null;
//   profile?: Profile;
//   email?: string | { verificationRequest?: boolean };
//   credentials?: any;
// }): Promise<boolean | string> {
//   if (account?.provider === "google" || account?.provider === "github") {
//     // Check if user is in your database
//     const userRef = firebaseAdminDb.collection("users").doc(user.id);
//     const userDoc = await userRef.get();
//     if (!userDoc.exists) {
//       // If the user is not in the database, create a new user in Firebase
//       try {
//         const newUser = await firebaseAdminAuth.createUser({
//           uid: user.id,
//           email: user.email as string,
//           displayName: user.name as string,
//         });
//         console.log("New user created in Firebase:", newUser.uid);
//       } catch (error) {
//         console.error("Error creating new user in Firebase:", error);
//         return false;
//       }
//     }
//     return true;
//   }
//   return false;
// },

// async jwt({
//   token,
//   user,
//   account,
//   profile,
//   isNewUser,
// }: {
//   token: JWT;
//   user: User | AdapterUser;
//   account: Account | null;
//   profile?: Profile;
//   isNewUser?: boolean;
// }): Promise<any> {
//   if (user) {
//     token.sub = user.id;
//   }
//   return token;
// },

// async session({
//   session,
//   token,
//   user,
// }: {
//   session: Session;
//   token: JWT;
//   user: User | AdapterUser;
// }): Promise<any> {
//   //////////////////////////// DO NOT REMOVE ////////////////////////////

//   if (session?.user && !session.firebaseToken && token.sub) {
//     session.user.id = token.sub;

//     // if (!firebaseAdminAuth) {
//     //   console.error("No Firebase Admin Auth was initialized.");
//     //   return session;
//     // }

//     // try {
//     //   const firebaseToken = await firebaseAdminAuth.createCustomToken(
//     //     token.sub
//     //   );
//     //   session.firebaseToken = firebaseToken;
//     //   console.log(
//     //     "Firebase token created and integrated in session:",
//     //     session.firebaseToken
//     //   );
//     // } catch (error) {
//     //   console.error("Error creating custom token:", error);
//     //   return session;
//     // }

//     // try {
//     //   await signInWithCustomToken(firebaseAuth, session.firebaseToken);
//     //   console.log("Firebase token signed in:", session.firebaseToken);
//     // } catch (error) {
//     //   console.error("Error signing in with custom token:", error);
//     // }
//   }

//   return session;
// },
