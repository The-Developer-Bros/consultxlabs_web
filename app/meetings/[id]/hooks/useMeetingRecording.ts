"use client";

import { useState, useEffect } from "react";

interface MeetingRecordingData {
  meetingSessionId: string | null;
  recordingEnabled: boolean;
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook to fetch meeting session data for recording controls
 * @param streamCallId The Stream call ID
 */
export function useMeetingRecording(
  streamCallId: string | undefined,
): MeetingRecordingData {
  const [data, setData] = useState<MeetingRecordingData>({
    meetingSessionId: null,
    recordingEnabled: false,
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    if (!streamCallId) {
      setData((prev) => ({ ...prev, isLoading: false }));
      return;
    }

    const fetchMeetingSession = async () => {
      try {
        const response = await fetch(
          `/api/stream/meetings/${encodeURIComponent(streamCallId)}/recording-info`,
        );

        if (!response.ok) {
          if (response.status === 404) {
            // Meeting session not found - recording not available
            setData({
              meetingSessionId: null,
              recordingEnabled: false,
              isLoading: false,
              error: null,
            });
            return;
          }
          throw new Error("Failed to fetch meeting recording info");
        }

        const result = await response.json();

        setData({
          meetingSessionId: result.meetingSessionId,
          recordingEnabled: result.recordingEnabled,
          isLoading: false,
          error: null,
        });
      } catch (error) {
        console.error("Error fetching meeting recording info:", error);
        setData({
          meetingSessionId: null,
          recordingEnabled: false,
          isLoading: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch recording info",
        });
      }
    };

    fetchMeetingSession();
  }, [streamCallId]);

  return data;
}
