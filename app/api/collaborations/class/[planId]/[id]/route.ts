import type { NextRequest } from "next/server";
import {
  deleteCollaborator,
  patchCollaborator,
} from "@/lib/api/collaborations/member-handlers";

// Thin wrapper: the bodies are shared with the webinar twin (#1580 C-P2-7).
type Ctx = { params: Promise<{ planId: string; id: string }> };

export const PATCH = (req: NextRequest, ctx: Ctx) =>
  patchCollaborator("class", req, ctx);

export const DELETE = (req: NextRequest, ctx: Ctx) =>
  deleteCollaborator("class", req, ctx);
