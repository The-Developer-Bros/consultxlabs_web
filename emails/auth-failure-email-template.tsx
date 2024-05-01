import * as React from "react";
import { Html, Button } from "@react-email/components";

interface AuthFailureEmailProps {
  firstName: string;
  reason: string;
}

export const AuthFailureEmail: React.FC<Readonly<AuthFailureEmailProps>> = ({
  firstName,
  reason,
}) => {
  return (
    <Html>
      <h1>Authentication Failed for {firstName}</h1>
      <p>
        We're sorry, but we couldn't process your sign-in or sign-up request.
      </p>
      <p>Reason: {reason}</p>
      <p>Please review your information and try again.</p>
      <Button
        href="https://example.com"
        style={{ background: "#000", color: "#fff", padding: "12px 20px" }}
      >
        Try Again
      </Button>
    </Html>
  );
};

export default AuthFailureEmail;
