import { Button, Html } from "@react-email/components";
import * as React from "react";

interface UserSignInEmailProps {
  firstName: string;
}

export const UserSignInEmail: React.FC<Readonly<UserSignInEmailProps>> = ({
  firstName,
}) => {
  return (
    <Html>
      <h1>Welcome back, {firstName}!</h1>
      <p>You have successfully signed in to our platform.</p>
      <Button
        href="https://example.com"
        style={{ background: "#000", color: "#fff", padding: "12px 20px" }}
      >
        Visit our website
      </Button>
    </Html>
  );
};

export default UserSignInEmail;
