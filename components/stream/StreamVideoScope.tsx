"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import {
  getStreamConnectionServerSnapshot,
  getStreamConnectionSnapshot,
  subscribeStreamConnection,
} from "@/lib/stream/connection-store";

/**
 * Mounts the Stream `<StreamVideo>` context around a video surface.
 *
 * Sibling of StreamChatScope — see that file for why these contexts no longer
 * wrap the entire dashboard. Video consumers (`useStreamVideoClient`, `useCall`)
 * are confined to `/meetings` plus the consultee appointments adapter.
 *
 * Renders children unwrapped until the client connects; the existing video
 * consumers already guard a null client.
 */
const VideoProvider = dynamic(
  () =>
    import("@stream-io/video-react-sdk").then((m) => ({
      default: m.StreamVideo,
    })),
  { ssr: false },
);

export function StreamVideoScope({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { clients } = useSyncExternalStore(
    subscribeStreamConnection,
    getStreamConnectionSnapshot,
    getStreamConnectionServerSnapshot,
  );

  if (!clients?.video) return <>{children}</>;
  return <VideoProvider client={clients.video}>{children}</VideoProvider>;
}
