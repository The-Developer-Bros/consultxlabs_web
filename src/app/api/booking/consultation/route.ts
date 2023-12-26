// pages/api/consultation/index.js
import { NextApiRequest, NextApiResponse } from "next";
import prisma from "../../../../lib/prisma";

import { v4 } from "uuid";

// POST /api/consultation

export async function POST(
  req: NextApiRequest,
  res: NextApiResponse,
  next: any
): Promise<void> {
  console.log("Hello");
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method Not Allowed", method: req.method });
    console.log(req.method);
    return;
  }

  const {
    consultation_id,
    consultant_phone_number,
    consultee_phone_number,
    start_time,
    end_time,
  } = req.body;

  try {
    const result = await prisma.consultation.create({
      data: {
        consultation_id: v4(),
        consultant_phone_number,
        consultee_phone_number,
        start_time,
        end_time,
      },
      select: {
        consultation_id: true,
        consultant_phone_number: true,
        consultee_phone_number: true,
        start_time: true,
        end_time: true,
      },
    });

    res.status(201).json(result);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Internal Server Error" });
  }
}

// Sample request
// POST /api/consultation
// {
//   "consultation_id": "1",
//   "consultant_phone_number": "1",
//   "consultee_phone_number": "1",
//   "start_time": "2021-09-28T00:00:00.000Z",
//   "end_time": "2021-09-28T00:00:00.000Z"
// }
