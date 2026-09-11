"use client";

import type { RecordingData } from "@/types/recording";

import { useState } from "react";
import Image from "next/image";
import { formatDistanceToNow, format } from "date-fns";
import {
  Play,
  Clock,
  Calendar,
  AlertCircle,
  Loader2,
  Download,
  ExternalLink,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { recordingStatusBadge } from "@/lib/labels/session-labels";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/utils/tailwind";


function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface RecordingCardProps {
  recording: RecordingData;
  onTransfer?: (recordingId: string) => Promise<void>;
}

export function RecordingCard({ recording, onTransfer }: RecordingCardProps) {
  const { toast } = useToast();
  const [isTransferring, setIsTransferring] = useState(false);

  const formatDuration = (minutes: number) => {
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hrs > 0) {
      return `${hrs}h ${mins}m`;
    }
    return `${mins}m`;
  };

  const handleTransfer = async () => {
    if (!onTransfer) return;

    setIsTransferring(true);
    try {
      await onTransfer(recording.id);
      toast({
        title: "Transfer Started",
        description: "Recording is being transferred to permanent storage.",
      });
    } catch (error) {
      toast({
        title: "Transfer Failed",
        description:
          error instanceof Error
            ? error.message
            : "Failed to transfer recording",
        variant: "destructive",
      });
    } finally {
      setIsTransferring(false);
    }
  };

  const canTransfer =
    recording.status === "READY" && recording.storageType === "STREAM_S3";

  const isExpiringSoon =
    recording.streamUrlExpiresAt &&
    new Date(recording.streamUrlExpiresAt).getTime() - Date.now() <
      3 * 24 * 60 * 60 * 1000; // 3 days

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-lg truncate">
              {recording.title}
            </CardTitle>
            {recording.planTitle && (
              <p className="text-sm text-muted-foreground mt-1">
                {recording.planTitle}
              </p>
            )}
          </div>
          <StatusBadge {...recordingStatusBadge(recording.status)} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Thumbnail or placeholder */}
        <div className="relative aspect-video bg-muted rounded-lg overflow-hidden">
          {recording.thumbnailUrl ? (
            <Image
              src={recording.thumbnailUrl}
              alt={recording.title}
              fill
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900">
              <Play className="w-12 h-12 text-zinc-600" />
            </div>
          )}
          {/* Duration overlay */}
          <div className="absolute bottom-2 right-2 px-2 py-1 bg-black/80 rounded text-xs text-white font-medium">
            {formatDuration(recording.durationInMinutes)}
          </div>
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
          {recording.participantCount > 0 && (
            <div className="flex items-center gap-1 basis-full">
              <Users className="w-4 h-4 flex-shrink-0" />
              <span>
                {recording.participantNames.join(", ")}
                {recording.participantCount > 3 &&
                  ` +${recording.participantCount - 3} more`}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1">
            <Calendar className="w-4 h-4" />
            <span>{format(new Date(recording.appointmentDate ?? recording.recordedAt), "MMM d, yyyy")}</span>
          </div>
          <div className="flex items-center gap-1">
            <Clock className="w-4 h-4" />
            <span>{format(new Date(recording.recordedAt), "h:mm a")}</span>
          </div>
          {recording.resolution && (
            <span className="text-xs bg-muted px-2 py-0.5 rounded">
              {recording.resolution}
            </span>
          )}
          {recording.fileSize && (
            <span className="text-xs bg-muted px-2 py-0.5 rounded">
              {formatFileSize(recording.fileSize)}
            </span>
          )}
        </div>

        {/* Expiration warning */}
        {isExpiringSoon && recording.status === "READY" && (
          <div className="flex items-center gap-2 p-2 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm text-yellow-600">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>
              Expires{" "}
              {formatDistanceToNow(new Date(recording.streamUrlExpiresAt!), {
                addSuffix: true,
              })}
            </span>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          {recording.playbackUrl && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    className="flex-1"
                    onClick={() =>
                      window.open(recording.playbackUrl!, "_blank")
                    }
                  >
                    <Play className="w-4 h-4 mr-2" />
                    Watch
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Open recording in new tab</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {canTransfer && onTransfer && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={handleTransfer}
                    disabled={isTransferring}
                    className={cn(isExpiringSoon && "border-yellow-500/50")}
                  >
                    {isTransferring ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Transfer to permanent storage</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {recording.status === "AVAILABLE" && recording.playbackUrl && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      navigator.clipboard.writeText(recording.playbackUrl!);
                      toast({
                        title: "Copied",
                        description: "Recording URL copied to clipboard",
                      });
                    }}
                  >
                    <ExternalLink className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Copy URL</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

        </div>
      </CardContent>
    </Card>
  );
}
