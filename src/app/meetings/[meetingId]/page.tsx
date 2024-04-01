import { redirect, usePathname, useRouter } from "next/navigation";
import { ZegoExpressEngine } from "zego-express-engine-webrtc";
import { useEffect, useRef } from "react";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MeetingPage = ({
  params,
}: {
  readonly params: { meetingId: string };
}) => {
  const router = useRouter();
  const pathname = usePathname();

  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const joinMeeting = async () => {
      if (!params.meetingId) return;

      // Call the API to join the meeting and retrieve the room details
      const response = await fetch("/api/meetings/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingId: Number(params.meetingId),
          userId: "participant",
        }),
      });

      const { meeting, roomId, token } = await response.json();

      // Redirect to the meeting room URL
      redirect(`/meetings/${meeting.id}/room`);
    };

    joinMeeting();
  }, [params.meetingId, router]);

  return <div>{/* Render meeting details and UI */}</div>;
};

export default MeetingPage;
