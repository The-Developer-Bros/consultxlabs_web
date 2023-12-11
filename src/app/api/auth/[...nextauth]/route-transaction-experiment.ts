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
          try {
            await firebaseAdminDb.runTransaction(async (transaction) => {
              const userRef = firebaseAdminDb.collection("users").doc(user.id);
              const userDoc = await transaction.get(userRef);
  
              if (!userDoc.exists) {
                const newUser = await firebaseAdminAuth.createUser({
                  uid: user.id,
                  email: user.email as string,
                  displayName: user.name as string,
                });
                console.log("New user created in Firebase:", newUser.uid);
  
                transaction.set(userRef, {
                  firebaseToken: "",
                });
              } else {
                console.log("User already exists in Firebase:", user.id);
  
                const existingToken = userDoc.data()?.firebaseToken;
  
                if (!existingToken) {
                  const firebaseToken = await firebaseAdminAuth.createCustomToken(
                    user.id
                  );
                  transaction.set(
                    userRef,
                    {
                      firebaseToken: firebaseToken,
                    },
                    { merge: true }
                  );
  
                  console.log(
                    "Custom token added to user document:",
                    firebaseToken
                  );
                } else {
                  console.log(
                    "User document already has a custom token:",
                    existingToken
                  );
                }
              }
            });
  
            return true;
          } catch (error) {
            console.error("Error in transaction:", error);
            return false;
          }
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
        if (session?.user && !session.firebaseToken && token.sub) {
          session.user.id = token.sub;
  
          const userRef = firebaseAdminDb.collection("users").doc(token.sub);
          const userDoc = await userRef.get();
          const firebaseToken = userDoc.data()?.firebaseToken;
  
          if (firebaseToken) {
            session.firebaseToken = firebaseToken;
  
            try {
              const decodedToken = await firebaseAdminAuth.verifyIdToken(
                firebaseToken,
                true
              );
              const timeDiff = Date.now() / 1000 - decodedToken.auth_time;
              if (timeDiff > 60 * 60 * 24) {
                // Token is more than 24 hours old
                const newToken = await firebaseAdminAuth.createCustomToken(
                  token.sub
                );
                await userRef.set({ firebaseToken: newToken }, { merge: true });
                session.firebaseToken = newToken;
              }
            } catch (error) {
              console.error("Error verifying ID token:", error);
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
  