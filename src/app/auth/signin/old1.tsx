"use client";
import React from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import consultxlogo from "../../../../public/static/assets/logos/ConsultX-logos/ConsultX-logos_white.png";
import spotlights from "../../../../public/static/assets/images/spotlight.webp";
import Image from "next/image";
import { FaGoogle, FaGithub, FaFacebook } from "react-icons/fa";
import { useRouter } from "next/navigation";

export default function SignIn() {
  const { data: session } = useSession();

  const router = useRouter();
  if (session) {
    router.push("/");
  }

  return (
    <div className="flex h-screen">
      <div className="w-1/2 bg-black flex items-center justify-center">
        {/* Replace with your company logo */}
        <Image src={consultxlogo} alt="ConsultX Logo" className="h-3/4" />
      </div>
      <div
        className="w-1/2 bg-cover bg-center flex items-center justify-center"
        style={{ backgroundImage: `url("/assets/images/spotlight.webp")` }}
      >
        <div className="bg-white p-10 rounded-lg w-96">
          {session?.user ? (
            <div>
              Signed in as {session.user.name} <br />
              has email {session.user.email} <br />
              {/* <img src={session.user.image!} alt={session.user.name!} />  */}
              <Image
                src={session.user.image!}
                alt={session.user.name!}
                width={50}
                height={50}
                className="rounded-full cursor-pointer"
              />
              <br />
              <button
                onClick={() => signOut({ callbackUrl: "/" })}
                className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"
              >
                Sign out
              </button>
            </div>
          ) : (
            <div>
              Not signed in <br />
              <button
                onClick={() => signIn("google")}
                className="mt-4 px-4 py-2 bg-red-600 text-white rounded flex items-center"
              >
                <FaGoogle className="mr-2" /> Sign in with Google
              </button>
              <button
                onClick={() => signIn("github")}
                className="mt-4 px-4 py-2 bg-gray-900 text-white rounded flex items-center"
              >
                <FaGithub className="mr-2" /> Sign in with GitHub
              </button>
              <button
                onClick={() => signIn("facebook")}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded flex items-center"
              >
                <FaFacebook className="mr-2" /> Sign in with Facebook
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
