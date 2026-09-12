import type { NextRequest } from "next/server";
import {
  deleteCollaborator,
  patchCollaborator,
} from "@/lib/api/collaborations/member-handlers";

// Thin wrapper: the bodies are shared with the class twin (#1580 C-P2-7).
type Ctx = { params: Promise<{ planId: string; id: string }> };

export const PATCH = (req: NextRequest, ctx: Ctx) =>
  patchCollaborator("webinar", req, ctx);

export const DELETE = (req: NextRequest, ctx: Ctx) =>
  deleteCollaborator("webinar", req, ctx);
