import AuthFailureEmail from "@/emails/auth-failure-email-template";
import UserSignupEmail from "@/emails/user-signup-email-template";
import resendClient from "@/lib/resend";
import { inngestClient } from "../lib/inngest";

export const sendEmailOnUserSignUpJob = inngestClient.createFunction(
  { id: "send-signup-email" },
  { event: "user/created" }, // Trigger
  async ({ event, step }) => {
    try {
      // This runs in the background any time the `user/created` event is
      // sent to Inngest.
      //
      // Whatever event data you send is accessible within `event`.

      await step.run("send-the-user-a-signup-email", async () => {
        // Reliably send an email.  Anything in `step.run` automatically retries
        await resendClient.emails.send({
          from: "onboarding@resend.dev",
          to: event.data.user_email,
          subject: "Welcome to Inngest!",
          text: `Welcome, ${event.data.user_first_name}! Confirm your email at https://example.com`,
          react: UserSignupEmail({ firstName: event.data.user_first_name }),
        });
      });

      // // You can schedule work for the future by sleeping within functions.
      // // NOTE: This actually *****stops***** functions and continues execution automatically,
      // // across server restarts or serverless functions.  You don't have to worry about
      // // scale, memory leaks, connections, or restarts.
      // await step.sleepUntil("wait-for-the-future", "2023-02-01T16:30:00");

      // await step.run("do-some-work-in-the-future", async () => {
      //   // Code here runs in the future automatically.
      // });
    } catch (error: any) {
      console.error("Error sending email on user sign-up", error);
      await resendClient.emails.send({
        from: "notifications@resend.dev",
        to: event.data.user_email,
        subject: "Sign-up failed",
        html: "<p>Sorry, we couldn't sign you up. Please try again later.</p>",
        react: AuthFailureEmail({
          firstName: event.data.user_first_name,
          reason: error.message,
        }),
      });
    }
  }
);
