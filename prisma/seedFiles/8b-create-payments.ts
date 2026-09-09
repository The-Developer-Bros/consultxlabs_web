import { faker } from "@faker-js/faker";
import {
  Currency,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  DiscountType,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import { UserWithProfiles } from "./1a-create-users";
import { config } from "./config";

// Payment volume - configurable via SEED_MODE environment variable
const NUM_PAYMENTS = config.volumes.payments;

export async function createPayments(users: UserWithProfiles[]) {
  console.log(`Creating payments...`);
  const discountCodes = await prisma.discountCode.findMany();
  const appointments = await prisma.appointment.findMany({
    where: {
      payment: {
        none: {},
      },
      OR: [
        { consultation: { status: "APPROVED" } },
        { subscription: { status: "APPROVED" } },
        { webinar: { status: "SCHEDULED" } },
        { class: { status: "SCHEDULED" } },
      ],
    },
    include: {
      consultation: {
        include: {
          consultationPlan: true,
        },
      },
      subscription: {
        include: {
          subscriptionPlan: true,
        },
      },
      webinar: {
        include: {
          webinarPlan: true,
        },
      },
      class: {
        include: {
          classPlan: true,
        },
      },
    },
    take: NUM_PAYMENTS,
  });

  for (let i = 0; i < appointments.length; i++) {
    const user = faker.helpers.arrayElement(users);
    const appointment = appointments[i];

    try {
      // Determine the amount based on the appointment type and plan
      let amount = 0;
      let description = "";

      if (appointment.consultation?.consultationPlan) {
        amount = appointment.consultation.consultationPlan.price;
        description = `Payment for Consultation: ${appointment.consultation.consultationPlan.title}`;
      } else if (appointment.subscription?.subscriptionPlan) {
        amount = appointment.subscription.subscriptionPlan.price;
        description = `Payment for Subscription: ${appointment.subscription.subscriptionPlan.title}`;
      } else if (appointment.webinar?.webinarPlan) {
        amount = appointment.webinar.webinarPlan.price;
        description = `Payment for Webinar: ${appointment.webinar.webinarPlan.title}`;
      } else if (appointment.class?.classPlan) {
        amount = appointment.class.classPlan.price;
        description = `Payment for Class: ${appointment.class.classPlan.title}`;
      }

      // Apply discount if available
      const useDiscount = faker.datatype.boolean() && discountCodes.length > 0;
      const discountCode = useDiscount
        ? faker.helpers.arrayElement(discountCodes)
        : null;

      let finalAmount = amount;
      if (discountCode) {
        switch (discountCode.discountType) {
          case DiscountType.PERCENTAGE:
            finalAmount = Math.round(
              amount * (1 - discountCode.discountValue / 100),
            );
            break;
          case DiscountType.FIXED_AMOUNT:
            finalAmount = Math.max(0, amount - discountCode.discountValue);
            break;
        }
      }

      const paymentData: Prisma.PaymentCreateInput = {
        user: { connect: { id: user.id } },
        amount: finalAmount,
        originalAmount: amount,
        // INR, like every real payment. This used to pick a random foreign
        // currency, which is why 386 of 397 seeded payments were non-INR while
        // no plan has ever been priced in anything but INR. Dashboards then
        // summed EUR + GBP + USD + INR minor units into one figure and labelled
        // it with a single symbol — the operator home page read ₹26,47,683.47
        // for a number that was four currencies added together.
        currency: Currency.INR,
        description,
        receiptUrl: faker.internet.url(),
        paymentMethod: faker.helpers.arrayElement([
          "credit_card",
          "debit_card",
          "bank_transfer",
          "wallet",
        ]),
        paymentIntent: faker.string.uuid(),
        paymentGateway: faker.helpers.arrayElement<PaymentGateway>(
          Object.values(PaymentGateway),
        ),
        paymentStatus: faker.helpers.arrayElement<PaymentStatus>(
          Object.values(PaymentStatus),
        ),
        appointment: { connect: { id: appointment.id } },
        ...(discountCode
          ? { discountCode: { connect: { id: discountCode.id } } }
          : {}),
      };

      const created = await prisma.payment.create({
        data: paymentData,
      });
      // #1319 A9 — stamp the funding payment on the buyer's participant row.
      await prisma.appointmentParticipant.updateMany({
        where: {
          appointmentId: appointment.id,
          userId: user.id,
          paymentId: null,
        },
        data: { paymentId: created.id },
      });
    } catch (error) {
      console.error(
        `Failed to create payment for user ${user.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    if ((i + 1) % 20 === 0 || i === appointments.length - 1) {
      console.log(`Created ${i + 1} payments`);
    }
  }

  console.log(`Finished creating payments`);
}
