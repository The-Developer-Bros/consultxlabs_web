import { helloWorldJob } from "@/jobs/hello-world";
import { sendEmailOnUserSignInJob } from "@/jobs/send-email-on-user-signin";
import { sendEmailOnUserSignUpJob } from "@/jobs/send-email-on-user-signup";
import { inngestClient } from "@/lib/inngest";
import { serve } from "inngest/next";

// Create an API that serves zero functions
export const { GET, POST, PUT } = serve({
  client: inngestClient,
  functions: [
    helloWorldJob,
    sendEmailOnUserSignInJob,
    sendEmailOnUserSignUpJob,
  ],
});
