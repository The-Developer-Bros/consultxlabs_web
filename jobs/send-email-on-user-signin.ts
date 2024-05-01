import { inngestClient } from "@/lib/inngest";
import resendClient from "@/lib/resend";
import { UserSignInEmail } from "@/emails/user-signin-email-template";
import AuthFailureEmail from "@/emails/auth-failure-email-template";
import prisma from "@/lib/prisma";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

export const sendEmailOnUserSignInJob = inngestClient.createFunction(
  { id: "handle-sign-in" },
  { event: "user/signed-in" },
  async ({ event, step }) => {
    try {
      const user = await prisma.user.findUnique({
        where: {
          email: event.data.user_email,
        },
      });

      if (user) {
        await step.run("send-welcome-back-email", async () => {
          await resendClient.emails.send({
            from: "notifications@resend.dev",
            to: event.data.user_email,
            subject: "Welcome back to Inngest!",
            html: "<p>Thanks for signing in again!</p>",
            react: UserSignInEmail({ firstName: event.data.user_first_name }),
          });
        });
      }
    } catch (error: any) {
      console.error("Error sending email on user sign-in", error);
      await resendClient.emails.send({
        from: "notifications@resend.dev",
        to: event.data.user_email,
        subject: "Sign-in failed",
        html: "<p>Sorry, we couldn't sign you in. Please check your credentials and try again.</p>",
        react: AuthFailureEmail({
          firstName: event.data.user_first_name,
          reason: error.message,
        }),
      });
    }
  }
);
