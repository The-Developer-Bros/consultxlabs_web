"use client";
import { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";

interface Props {
  children: React.ReactNode;
  session: Session | null;
}

export default function NextAuthProvider({
  children,
  session,
}: Readonly<Props>) {
  return <SessionProvider session={session}>{children}</SessionProvider>;
}
