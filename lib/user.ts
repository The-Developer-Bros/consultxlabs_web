import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getServerSession } from "next-auth";
import prisma from "./prisma";
import { User } from "@prisma/client";

// NOT WORKING
export const getCurrentUser = async (): Promise<User | undefined> => {
  try {
    const session = await getServerSession(authOptions);
    console.log("Session is", session);

    // Since email is not available in the session object,
    // we need to fetch the user from the database using the user ID.
    if (!session?.user?.id) return;

    const currentUser = await prisma.user.findUnique({
      where: { id: session.user.id },
    });

    if (!currentUser) return;

    return currentUser;
  } catch (error: any) {
    console.error(error);
    return;
  }
};
