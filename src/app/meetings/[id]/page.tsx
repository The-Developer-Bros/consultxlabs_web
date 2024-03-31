import { useRouter } from 'next/router';
import { ZegoExpressEngine } from 'zego-express-engine-webrtc';
import { useEffect, useRef } from 'react';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MeetingPage = () => {
  const router = useRouter();
  const { id } = router.query;
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const joinMeeting = async () => {
      if (!id) return;

      // Call the API to join the meeting and retrieve the room details
      const response = await fetch('/api/meetings/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId: Number(id), userId: 'participant' }),
      });

      const { meeting, roomId, token } = await response.json();

      // Initialize Zegocloud engine and join the meeting
      const zegoEngine = new ZegoExpressEngine(process.env.NEXT_PUBLIC_ZEGO_APP_ID);
      await zegoEngine.joinRoom({
        roomID: roomId,
        token,
        userID: 'participant',
        userName: 'Participant',
      });

      // Publish local video stream
      const localStream = await zegoEngine.createStream({
        camera: {
          video: true,
          audio: true,
        },
      });
      await localStream.startPublishing();

      // Play the local video stream
      if (videoRef.current) {
        videoRef.current.srcObject = localStream.stream;
      }

      // Start recording the meeting
      await zegoEngine.startRecordingRoom({
        roomID: roomId,
        config: {
          recordingConfig: {
            channelLayout: 2,
            subscribeAudioList: [],
            subscribeVideoList: [],
          },
          storageConfig: {
            vendor: 1,
            region: 0,
            bucket: process.env.NEXT_PUBLIC_GCP_BUCKET,
            accessKey: process.env.NEXT_PUBLIC_GCP_ACCESS_KEY,
            secretKey: process.env.NEXT_PUBLIC_GCP_SECRET_KEY,
            fileNamePrefix: `meeting-${id}`,
          },
        },
      });
    };

    joinMeeting();

    return () => {
      // Leave the meeting and stop publishing when component unmounts
      zegoEngine.leaveRoom();
      localStream.stopPublishing();
    };
  }, [id]);

  return (
    <div>
      <video ref={videoRef} autoPlay playsInline />
    </div>
  );
};

export default MeetingPage;