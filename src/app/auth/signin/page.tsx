"use client";
import React from "react";
import { signIn, signOut, useSession } from "next-auth/react";

export default function SignIn() {
  const { data: session } = useSession();

  return (
    <div>
      {session && session.user ? (
        <div>
          Signed in as {session.user.name} <br />
          has email {session.user.email} <br />
          <img src={session.user.image!} alt={session.user.name!} /> <br />
          <button onClick={() => signOut()}>Sign out</button>
        </div>
      ) : (
        <div>
          Not signed in <br />
          <button onClick={() => signIn('google')}>Sign in</button>
        </div>
      )}
    </div>
  );
}
