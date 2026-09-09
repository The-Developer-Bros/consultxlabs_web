"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  WifiOff,
  Video,
  MessageSquare,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Activity,
} from "lucide-react";
import { useStreamConnection } from "@/providers/StreamProvider";
import { useChatContext } from "stream-chat-react";
import type { Event } from "stream-chat";

interface DebugDialogProps {
  userId: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
  className?: string;
}

interface DebugUser {
  id: string;
  role: string;
  name?: string;
  [key: string]: unknown;
}

interface DebugChannel {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface DebugData {
  success: boolean;
  user: DebugUser;
  stream: {
    channelCount: number;
    channels: DebugChannel[];
  };
  database: {
    consultations: number;
    subscriptions: number;
    webinars: number;
    classes: number;
  };
}

interface DebugSectionProps {
  title: string;
  data: unknown;
}

export const DebugDialog = ({
  userId,
  variant = "outline",
  className = "w-full",
}: DebugDialogProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [debugData, setDebugData] = useState<DebugData | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const { toast } = useToast();

  // Get real-time connection state
  const streamConnection = useStreamConnection();
  const { client: chatClient } = useChatContext();

  // Real-time monitoring state
  const [connectionStats, setConnectionStats] = useState({
    latency: 0,
    reconnectCount: 0,
    messagesReceived: 0,
    lastActivity: new Date(),
  });

  const handleDebug = useCallback(async () => {
    setIsLoading(true);
    const startTime = Date.now();

    try {
      const response = await fetch(`/api/stream/debug?userId=${userId}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();
      const latency = Date.now() - startTime;

      if (data.success) {
        setDebugData(data);
        setLastUpdated(new Date());
        setConnectionStats((prev) => ({ ...prev, latency }));
        setIsOpen(true);
        toast({
          title: "Debug data fetched successfully",
          description: `Found ${data.stream?.channelCount || 0} channels, ${data.database?.consultations || 0} consultations, ${data.database?.subscriptions || 0} subscriptions, ${data.database?.webinars || 0} webinars, and ${data.database?.classes || 0} classes.`,
        });
      } else {
        toast({
          title: "Error fetching debug data",
          description: data.error || "An error occurred",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error fetching debug data:", error);
      toast({
        title: "Error fetching debug data",
        description: (error as Error).message || "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [userId, toast]);

  // Auto-refresh effect
  useEffect(() => {
    if (!autoRefresh || !isOpen) return;

    const interval = setInterval(() => {
      if (!isLoading) {
        handleDebug();
      }
    }, 5000); // Refresh every 5 seconds

    return () => clearInterval(interval);
  }, [autoRefresh, isOpen, isLoading, handleDebug]);

  // Monitor chat client events for real-time stats
  useEffect(() => {
    if (!chatClient) return;

    const handleEvent = (event: Event) => {
      if (event.type === "message.new") {
        setConnectionStats((prev) => ({
          ...prev,
          messagesReceived: prev.messagesReceived + 1,
          lastActivity: new Date(),
        }));
      }
      if (event.type === "connection.recovered") {
        setConnectionStats((prev) => ({
          ...prev,
          reconnectCount: prev.reconnectCount + 1,
        }));
      }
    };

    // #1280 2.6 — single-argument form. `on("*.**", h)` registers under the
    // literal string, which no event ever matches, so every counter in this
    // panel read zero for as long as it has existed.
    chatClient.on(handleEvent);
    return () => chatClient.off(handleEvent);
  }, [chatClient]);

  // Enhanced debug components
  const ConnectionStatusCard = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="p-4 border rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare className="h-4 w-4" />
          <span className="font-medium">Chat Connection</span>
          {streamConnection?.chatConnected ? (
            <Badge variant="default" className="bg-green-500">
              <CheckCircle className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          ) : (
            <Badge variant="destructive">
              <WifiOff className="h-3 w-3 mr-1" />
              Disconnected
            </Badge>
          )}
        </div>
        <div className="text-sm text-muted-foreground">
          Latency: {connectionStats.latency}ms
        </div>
      </div>

      <div className="p-4 border rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <Video className="h-4 w-4" />
          <span className="font-medium">Video Connection</span>
          {streamConnection?.videoConnected ? (
            <Badge variant="default" className="bg-green-500">
              <CheckCircle className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          ) : (
            <Badge variant="destructive">
              <WifiOff className="h-3 w-3 mr-1" />
              Disconnected
            </Badge>
          )}
        </div>
        <div className="text-sm text-muted-foreground">
          Status: {streamConnection?.isConnecting ? "Connecting..." : "Ready"}
        </div>
      </div>
    </div>
  );

  const ActivityStats = () => (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div className="p-3 border rounded-lg text-center">
        <div className="text-2xl font-bold text-blue-600">
          {connectionStats.messagesReceived}
        </div>
        <div className="text-sm text-muted-foreground">Messages</div>
      </div>
      <div className="p-3 border rounded-lg text-center">
        <div className="text-2xl font-bold text-green-600">
          {connectionStats.reconnectCount}
        </div>
        <div className="text-sm text-muted-foreground">Reconnects</div>
      </div>
      <div className="p-3 border rounded-lg text-center">
        <div className="text-2xl font-bold text-purple-600">
          {connectionStats.latency}ms
        </div>
        <div className="text-sm text-muted-foreground">Latency</div>
      </div>
      <div className="p-3 border rounded-lg text-center">
        <div className="text-2xl font-bold text-orange-600">
          {Math.floor(
            (Date.now() - connectionStats.lastActivity.getTime()) / 1000,
          )}
          s
        </div>
        <div className="text-sm text-muted-foreground">Since Activity</div>
      </div>
    </div>
  );

  const DebugSection = ({ title, data }: DebugSectionProps) => (
    <div className="space-y-2">
      <h4 className="font-semibold text-gray-900 dark:text-gray-100">
        {title}
      </h4>
      <div className="h-40 w-full rounded-md border bg-slate-50 dark:bg-slate-900 overflow-auto">
        <pre className="p-3 text-xs text-gray-800 dark:text-gray-200 font-mono">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          onClick={handleDebug}
          disabled={isLoading}
          className={className}
          variant={variant}
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Debugging...
            </>
          ) : (
            "Debug Stream Chat"
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-6xl max-h-[80vh] overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Stream Debug Console
              </DialogTitle>
              <DialogDescription>
                Real-time monitoring for user: {userId}
                {lastUpdated && (
                  <span className="ml-2 text-xs">
                    • Last updated: {lastUpdated.toLocaleTimeString()}
                  </span>
                )}
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAutoRefresh(!autoRefresh)}
                className={autoRefresh ? "bg-green-50 border-green-200" : ""}
              >
                <RefreshCw
                  className={`h-4 w-4 mr-1 ${autoRefresh ? "animate-spin" : ""}`}
                />
                Auto Refresh {autoRefresh ? "ON" : "OFF"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDebug}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-1" />
                )}
                Refresh
              </Button>
            </div>
          </div>
        </DialogHeader>

        <Tabs defaultValue="overview" className="h-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="connection">Connection</TabsTrigger>
            <TabsTrigger value="data">Raw Data</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent
            value="overview"
            className="space-y-4 h-[60vh] overflow-auto"
          >
            {debugData && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                  <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg">
                    <div className="font-medium text-blue-900 dark:text-blue-100">
                      Channels
                    </div>
                    <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                      {debugData.stream?.channelCount || 0}
                    </div>
                  </div>
                  <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded-lg">
                    <div className="font-medium text-green-900 dark:text-green-100">
                      Consultations
                    </div>
                    <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                      {debugData.database?.consultations || 0}
                    </div>
                  </div>
                  <div className="bg-purple-50 dark:bg-purple-900/20 p-3 rounded-lg">
                    <div className="font-medium text-purple-900 dark:text-purple-100">
                      Subscriptions
                    </div>
                    <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                      {debugData.database?.subscriptions || 0}
                    </div>
                  </div>
                  <div className="bg-orange-50 dark:bg-orange-900/20 p-3 rounded-lg">
                    <div className="font-medium text-orange-900 dark:text-orange-100">
                      Webinars
                    </div>
                    <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">
                      {debugData.database?.webinars || 0}
                    </div>
                  </div>
                  <div className="bg-pink-50 dark:bg-pink-900/20 p-3 rounded-lg">
                    <div className="font-medium text-pink-900 dark:text-pink-100">
                      Classes
                    </div>
                    <div className="text-2xl font-bold text-pink-600 dark:text-pink-400">
                      {debugData.database?.classes || 0}
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className="text-lg font-semibold">Connection Status</h3>
                  <ConnectionStatusCard />
                </div>

                <div className="space-y-4">
                  <h3 className="text-lg font-semibold">User Information</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                    <div className="p-3 border rounded-lg">
                      <div className="font-medium">User ID</div>
                      <div className="text-muted-foreground">
                        {debugData.user.id}
                      </div>
                    </div>
                    <div className="p-3 border rounded-lg">
                      <div className="font-medium">Role</div>
                      <div className="text-muted-foreground">
                        {debugData.user.role}
                      </div>
                    </div>
                    <div className="p-3 border rounded-lg">
                      <div className="font-medium">Name</div>
                      <div className="text-muted-foreground">
                        {debugData.user.name || "N/A"}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent
            value="connection"
            className="space-y-4 h-[60vh] overflow-auto"
          >
            <ConnectionStatusCard />
            <ActivityStats />

            {streamConnection?.error && (
              <div className="p-4 border border-red-200 bg-red-50 rounded-lg">
                <div className="flex items-center gap-2 text-red-700">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="font-medium">Connection Error</span>
                </div>
                <div className="text-sm text-red-600 mt-1">
                  {streamConnection.error}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={streamConnection.retryConnection}
                  className="mt-2"
                >
                  Retry Connection
                </Button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="data" className="h-[60vh] overflow-auto">
            {debugData && (
              <div className="space-y-6 pr-4">
                <DebugSection title="User Information" data={debugData.user} />
                <DebugSection
                  title={`Channels (${debugData.stream?.channelCount || 0})`}
                  data={debugData.stream?.channels || []}
                />
                <DebugSection
                  title="Database Counts"
                  data={debugData.database}
                />
              </div>
            )}
          </TabsContent>

          <TabsContent
            value="activity"
            className="space-y-4 h-[60vh] overflow-auto"
          >
            <ActivityStats />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 border rounded-lg">
                <h4 className="font-medium mb-2">Performance Metrics</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>API Latency:</span>
                    <span
                      className={
                        connectionStats.latency > 1000
                          ? "text-red-500"
                          : "text-green-500"
                      }
                    >
                      {connectionStats.latency}ms
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Connection Health:</span>
                    <span
                      className={
                        streamConnection?.chatConnected &&
                        streamConnection?.videoConnected
                          ? "text-green-500"
                          : "text-orange-500"
                      }
                    >
                      {streamConnection?.chatConnected &&
                      streamConnection?.videoConnected
                        ? "Excellent"
                        : streamConnection?.chatConnected ||
                            streamConnection?.videoConnected
                          ? "Partial"
                          : "Poor"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-4 border rounded-lg">
                <h4 className="font-medium mb-2">Recent Activity</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>Last Message:</span>
                    <span>
                      {Math.floor(
                        (Date.now() - connectionStats.lastActivity.getTime()) /
                          1000,
                      )}
                      s ago
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Messages Today:</span>
                    <span>{connectionStats.messagesReceived}</span>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
