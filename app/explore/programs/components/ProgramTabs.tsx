"use client";

import { memo } from "react";
import { GraduationCap, Layers, Video } from "lucide-react";
import SegmentedControl from "@/app/explore/components/SegmentedControl";
import { ProgramType } from "@/lib/explore/programs";

interface ProgramTabsProps {
  activeTab: ProgramType;
  onTabChange: (tab: ProgramType) => void;
}

const tabs = [
  { value: "all", label: "All", icon: Layers },
  { value: "class", label: "Classes", icon: GraduationCap },
  { value: "webinar", label: "Webinars", icon: Video },
];

function ProgramTabsImpl({ activeTab, onTabChange }: ProgramTabsProps) {
  return (
    <SegmentedControl
      value={activeTab}
      onChange={(value) => onTabChange(value as ProgramType)}
      options={tabs}
      ariaLabel="Filter programs by type"
    />
  );
}

const ProgramTabs = memo(ProgramTabsImpl);
export default ProgramTabs;
