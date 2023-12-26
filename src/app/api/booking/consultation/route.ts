import { v4 } from "uuid";
import prisma from "../../../../lib/prisma";

export async function POST(request: Request) {
  const {
    consultantId,
    consulteeId,
    start_time,
    end_time,
    price,
    consultant,
    consultee,
  } = await request.json();

  const consultation = await prisma.consultation.create({
    data: {
      id: v4(),
      consultantId,
      consulteeId,
      start_time,
      end_time,
      price,
      consultant: {
        connect: { id: consultant.id },
      },
      consultee: {
        connect: { id: consultee.id },
      },
    },
  });

  return consultation;
}
