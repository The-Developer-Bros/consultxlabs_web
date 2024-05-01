// FOR LATER REFERENCE:
// import {
//   Body,
//   Button,
//   Container,
//   Head,
//   Heading,
//   Html,
//   Preview,
//   Text,
// } from "@react-email/components";

import { Button, Html } from "@react-email/components";
import * as React from "react";

interface UserSignupEmailProps {
  firstName: string;
}

export const UserSignupEmail: React.FC<Readonly<UserSignupEmailProps>> = ({
  firstName,
}) => {
  return (
    <Html>
      <h1>Welcome, {firstName}!</h1>
      <Button
        href="https://example.com"
        style={{ background: "#000", color: "#fff", padding: "12px 20px" }}
      >
        Confirm your email
      </Button>
    </Html>
  );
};

export default UserSignupEmail;
