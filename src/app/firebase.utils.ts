"use server";
import { ref, getDownloadURL } from "firebase/storage";
import { firebaseStorage } from "./firebase.config";

export async function fetchFirebaseImage(imageRelativePath: string) {
  try {
    const imageAbsolutePath =
      "gs://" + process.env.FIREBASE_STORAGE_BUCKET + "/" + imageRelativePath;
    const storageRef = ref(firebaseStorage, imageAbsolutePath);
    return await getDownloadURL(storageRef);
  } catch (error) {
    console.log("Error fetching image from Firebase: ", error);
  }
}
