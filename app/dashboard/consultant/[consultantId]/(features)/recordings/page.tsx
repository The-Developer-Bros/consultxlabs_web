"use client";

import { use, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Video, Play, GraduationCap } from "lucide-react";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { RecordingsList } from "./components/RecordingsList";

interface RecordingsPageProps {
  params: Promise<{
    consultantId: string;
  }>;
}

export default function RecordingsPage({ params }: RecordingsPageProps) {
  const { consultantId } = use(params);
  const [activeTab, setActiveTab] = useState<"all" | "webinar" | "class">(
    "all",
  );

  return (
    <>
      <DashboardHeader
        title="Recordings"
        subtitle="Manage your webinar and class recordings"
      />
      <DashboardContent>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "all" | "webinar" | "class")}
        className="space-y-6"
      >
        <TabsList className="grid w-full max-w-full grid-cols-3 sm:max-w-[400px]">
          <TabsTrigger value="all" className="flex items-center gap-2">
            <Video className="w-4 h-4" />
            <span>All</span>
          </TabsTrigger>
          <TabsTrigger value="webinar" className="flex items-center gap-2">
            <Play className="w-4 h-4" />
            <span>Webinars</span>
          </TabsTrigger>
          <TabsTrigger value="class" className="flex items-center gap-2">
            <GraduationCap className="w-4 h-4" />
            <span>Classes</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-6">
          <RecordingsList consultantId={consultantId} />
        </TabsContent>

        <TabsContent value="webinar" className="mt-6">
          <RecordingsList consultantId={consultantId} type="webinar" />
        </TabsContent>

        <TabsContent value="class" className="mt-6">
          <RecordingsList consultantId={consultantId} type="class" />
        </TabsContent>
        </Tabs>
      </DashboardContent>
    </>
  );
}
