import { ref, getDownloadURL } from "firebase/storage";
import { firebaseStorage } from "./firebase.config";

export async function fetchFirebaseImage(imageRelativePath: string) {
  try {
    const imageAbsolutePath =
      "gs://" + process.env.FIREBASE_STORAGE_BUCKET + "/" + imageRelativePath;
    const storageRef = ref(firebaseStorage, imageAbsolutePath);
    return getDownloadURL(storageRef);
  } catch (error) {
    console.log(error);
  }
}
