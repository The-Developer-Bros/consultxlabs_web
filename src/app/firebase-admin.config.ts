import { initFirestore } from "@next-auth/firebase-adapter";
import admin from "firebase-admin";

let app;

if (!admin.apps.length) {
  app = admin.initializeApp({
    credential: admin.credential.cert({
      privateKey: process.env.FIREBASE_PRIVATE_KEY,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      projectId: process.env.FIREBASE_PROJECT_ID,
    }),
  });
}

const firebaseAdminDb = initFirestore(app);
const firebaseAdminAuth = app?.auth();

export { firebaseAdminDb, firebaseAdminAuth };
