import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getStorage } from "firebase/storage";

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
// const firebaseAuth = getAuth(firebaseApp);
const firebaseFunctions = getFunctions(firebaseApp);
const firebaseStorage = getStorage(firebaseApp);

export {
  firebaseApp,
  //  firebaseAuth, // TODO: Slowing down the build process
  firebaseFunctions,
  firebaseStorage,
  firestore,
};
