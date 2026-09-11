"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlanDetailBody } from "../../../components/PlanDetailBody";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Calendar,
  Clock,
  Users,
  Video,
  Globe,
  GraduationCap,
} from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { ClientWebinarRegistration } from "./ClientWebinarRegistration";
import { generateProgramImageUrl } from "@/lib/explore/programs";
import { useCurrency } from "@/hooks/useCurrency";
import { FeatureItem } from "@/app/explore/programs/plans/components/FeatureItem";
import type { TWebinarPlanData, TSessionStatus } from "../types";

interface WebinarDetailsProps {
  readonly plan: TWebinarPlanData;
  readonly nextSession: Date | string | undefined;
  readonly webinarId?: string;
}

export function WebinarDetails({
  plan,
  nextSession,
  webinarId,
}: WebinarDetailsProps) {
  const { formatPrice } = useCurrency();
  const [timeZone, setTimeZone] = useState("UTC");
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  let sessionStatus: TSessionStatus = "To be announced";
  let formattedNextSessionDisplay = "To be announced";

  if (
    nextSession &&
    plan.durationInHours !== null &&
    plan.durationInHours !== undefined
  ) {
    const sessionStart = new Date(nextSession);
    const durationInMilliseconds = plan.durationInHours * 60 * 60 * 1000;
    const sessionEnd = new Date(
      sessionStart.getTime() + durationInMilliseconds,
    );
    const now = new Date();

    if (now > sessionEnd) {
      sessionStatus = "Completed";
      formattedNextSessionDisplay = `Ended on ${formatInTimeZone(sessionEnd, timeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`;
    } else if (now >= sessionStart && now <= sessionEnd) {
      sessionStatus = "Happening Now";
      formattedNextSessionDisplay = `Ends at ${formatInTimeZone(sessionEnd, timeZone, "h:mm a zzz")}`;
    } else if (now < sessionStart) {
      sessionStatus = "Upcoming";
      formattedNextSessionDisplay = formatInTimeZone(
        sessionStart,
        timeZone,
        "MMMM d, yyyy 'at' h:mm a zzz",
      );
    }
  } else if (nextSession) {
    sessionStatus = "Upcoming";
    formattedNextSessionDisplay = formatInTimeZone(
      new Date(nextSession),
      timeZone,
      "MMMM d, yyyy 'at' h:mm a zzz",
    );
  }

  const getStatusBadgeClass = (status: TSessionStatus) => {
    switch (status) {
      case "Happening Now":
        return "bg-emerald-500 text-white";
      case "Completed":
        return "bg-muted text-muted-foreground";
      case "Upcoming":
        return "bg-primary text-primary-foreground";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  return (
    <main className="min-h-screen bg-muted">
      {/* Hero Banner */}
      <div className="relative h-[350px] md:h-[400px] w-full overflow-hidden">
        <Image
          src={generateProgramImageUrl(plan.id, 1200, 400, plan.imageUrl)}
          alt="Webinar cover"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />

        {/* Back Navigation */}
        <div className="absolute top-0 left-0 right-0 z-10">
          <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 py-6">
            <Link
              href="/explore/programs"
              className="inline-flex items-center gap-2 text-sm text-white/80 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Programs
            </Link>
          </div>
        </div>

        {/* Title Overlay */}
        <div className="absolute bottom-0 left-0 right-0 z-10">
          <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 pb-8">
            <div className="flex items-center gap-3 mb-4">
              <Badge className="bg-background text-foreground">Webinar</Badge>
              <Badge className={getStatusBadgeClass(sessionStatus)}>
                {sessionStatus}
              </Badge>
            </div>
            <h1 className="text-fluid-4xl tracking-tight font-bold text-white mb-2">
              {plan.title}
            </h1>
            <div className="flex items-center gap-4 text-white/80">
              <span className="text-2xl md:text-3xl font-bold text-white">
                {formatPrice(plan.price)}
              </span>
              <span className="text-white/60">•</span>
              <span>{plan.durationInHours} hours</span>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="w-full max-w-[92%] xl:max-w-[88%] 2xl:max-w-[1600px] mx-auto py-8 md:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-12">
          {/* Main Content */}
          <motion.div
            className="lg:col-span-2 space-y-8"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            {/* Features Grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <FeatureItem
                icon={<Calendar className="h-5 w-5" />}
                label={
                  sessionStatus === "Happening Now" ||
                  sessionStatus === "Completed"
                    ? "Status"
                    : "Next Session"
                }
                value={formattedNextSessionDisplay}
              />
              <FeatureItem
                icon={<Clock className="h-5 w-5" />}
                label="Duration"
                value={`${plan.durationInHours} hours`}
              />
              <FeatureItem
                icon={<Users className="h-5 w-5" />}
                label="Participants"
                value={`${plan.maxParticipants} max`}
              />
              <FeatureItem
                icon={<Video className="h-5 w-5" />}
                label="Platform"
                value={plan.materialProvided ?? "Zoom"}
              />
              <FeatureItem
                icon={<Globe className="h-5 w-5" />}
                label="Language"
                value={plan.language ?? "English"}
              />
              <FeatureItem
                icon={<GraduationCap className="h-5 w-5" />}
                label="Level"
                value={planLevelLabel(plan.level)}
              />
            </div>

            {/* Shared with the other three plan pages — see PlanDetailBody. */}
            <PlanDetailBody
              aboutHeading="About this webinar"
              description={plan.description}
              learningOutcomes={plan.learningOutcomes}
              targetAudience={plan.targetAudience}
              whatsIncluded={plan.whatsIncluded}
              prerequisites={plan.prerequisites}
              materialProvided={plan.materialProvided}
              faqs={plan.faqs}
              topics={plan.topics}
            />
          </motion.div>

          {/* Sidebar */}
          <motion.div
            className="lg:col-span-1"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <div className="sticky top-24 space-y-6">
              {/* Instructor Card */}
              <Card className="border-border shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">Your Host</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="relative h-16 w-16 rounded-full overflow-hidden ring-2 ring-border">
                      <Image
                        src={
                          plan.consultantProfile?.user?.image ??
                          "/placeholder-user.jpg"
                        }
                        alt={plan.consultantProfile?.user?.name ?? "Instructor"}
                        fill
                        className="object-cover"
                      />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-foreground">
                        {plan.consultantProfile?.user?.name}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        Expert Host
                      </p>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    An experienced professional dedicated to sharing knowledge
                    and expertise.
                  </p>
                  <Link
                    href={`/explore/experts/${plan.consultantProfile?.id}`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-muted-foreground mt-3"
                  >
                    View Full Profile
                    <ArrowLeft className="w-4 h-4 rotate-180" />
                  </Link>
                </CardContent>
              </Card>

              {/* Collaborators */}
              {plan.collaborators && plan.collaborators.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Users className="w-4 h-4" />
                      Co-Hosts
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {plan.collaborators.map((collab) => (
                      <Link
                        key={collab.id}
                        href={`/explore/experts/${collab.consultantProfile.id}`}
                        className="flex items-center gap-3 hover:bg-muted rounded-lg p-2 -mx-2 transition-colors"
                      >
                        <div className="relative h-10 w-10 rounded-full overflow-hidden ring-2 ring-border flex-shrink-0">
                          <Image
                            src={
                              collab.consultantProfile.user.image ??
                              "/placeholder-user.jpg"
                            }
                            alt={
                              collab.consultantProfile.user.name ?? "Co-host"
                            }
                            fill
                            className="object-cover"
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {collab.consultantProfile.user.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {collab.role.replace(/_/g, " ")}
                          </p>
                        </div>
                      </Link>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Registration Card */}
              <ClientWebinarRegistration
                webinarPlanId={plan.id}
                webinarId={webinarId}
                price={plan.price}
                currency={plan.priceCurrency}
                nextSessionDate={
                  nextSession ? new Date(nextSession) : undefined
                }
                sessionStatus={sessionStatus}
                appointment={plan.webinars?.[0]?.appointment}
                maxParticipants={plan.maxParticipants ?? 100}
                instanceMaxParticipants={
                  plan.webinars?.[0]?.maxParticipants ?? null
                }
                consultantUserId={plan.consultantProfile?.user?.id}
              />
            </div>
          </motion.div>
        </div>
      </div>
    </main>
  );
}
