interface User {
  id: string;
  name?: string;
  email?: string;
}

interface SlotOfAppointment {
  id: string;
  startsAt: Date;
  endsAt: Date;
  user: User[];
}

interface Appointment {
  id: string;
  slotsOfAppointment: SlotOfAppointment[];
}

interface ClassPlan {
  id: string;
  title: string;
  maxParticipants: number;
}

export interface ClassEvent {
  id: string;
  /** Per-instance capacity; null inherits the plan's value. */
  maxParticipants: number | null;
  classPlan: ClassPlan;
  appointments: Appointment[];
}

interface WebinarPlan {
  id: string;
  title: string;
  maxParticipants: number;
}

export interface WebinarEvent {
  id: string;
  /** Per-instance capacity; null inherits the plan's value. */
  maxParticipants: number | null;
  webinarPlan: WebinarPlan;
  appointment: Appointment | null;
}
