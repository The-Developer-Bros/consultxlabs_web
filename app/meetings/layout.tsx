import "@stream-io/video-react-sdk/dist/css/styles.css";
import StreamProvider from "@/providers/StreamProvider";
import { StreamVideoScope } from "@/components/stream/StreamVideoScope";
import { requireOnboarded } from "@/lib/auth-guard";

export default async function MeetingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Ensure user is authenticated and onboarded for meetings
  const session = await requireOnboarded();

  return (
    <StreamProvider
      userId={session.user.id}
      enableChat={false}
      enableVideo={true}
    >
      {/* /meetings is the video surface, so the SDK context is mounted for the
          whole route rather than per-page. StreamProvider no longer supplies it
          — see components/stream/StreamVideoScope. */}
      <StreamVideoScope>{children}</StreamVideoScope>
    </StreamProvider>
  );
}
