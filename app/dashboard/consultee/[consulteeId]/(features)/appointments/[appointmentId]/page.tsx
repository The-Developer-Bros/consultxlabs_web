import { notFound } from "next/navigation";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import prisma from "@/lib/prisma";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import DetailPageClient from "./DetailPageClient";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

type PageProps = {
  params: Promise<{ consulteeId: string; appointmentId: string }>;
};

export default async function AppointmentDetailPage({
  params,
}: Readonly<PageProps>) {
  const { consulteeId, appointmentId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  await requirePersonalProfileAccess("consultee", consulteeId);

  const [detail, profile] = await Promise.all([
    readAppointmentDetail(appointmentId),
    prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { userId: true },
    }),
  ]);
  if (!detail || !profile) notFound();

  // Ownership: the route's consultee must be a party to this appointment
  // (requester, trial consultee, or slot participant). This binds the
  // appointment to the URL's consultee; binding that consultee to the SESSION
  // is the guard above — it used to cite the dashboard layout, which is a
  // client component and so had already been overtaken by this render.
  const { appointment } = detail;
  const owns =
    appointment.consultation?.requestedBy?.id === consulteeId ||
    appointment.subscription?.requestedBy?.id === consulteeId ||
    appointment.trialSession?.consulteeProfile?.id === consulteeId ||
    appointment.slotsOfAppointment.some((slot) =>
      slot.user.some((u) => u.id === profile.userId),
    );
  if (!owns) notFound();

  const queryClient = new QueryClient();
  queryClient.setQueryData(["appointment-detail", appointmentId], detail);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DetailPageClient
        consulteeId={consulteeId}
        appointmentId={appointmentId}
      />
    </HydrationBoundary>
  );
}
