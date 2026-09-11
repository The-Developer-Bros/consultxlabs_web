import { Button } from "@react-email/button";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Html } from "@react-email/html";
import { Img } from "@react-email/img";
import { Link } from "@react-email/link";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import * as React from "react";
import { getAppUrl } from "@/lib/url";

interface PasswordResetEmailProps {
  name: string;
  resetLink: string;
}

export const PasswordResetEmail = ({
  name = "Valued User",
  resetLink = "https://familiarise.com/auth/reset-password?token=123",
}: PasswordResetEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Reset your Familiarise password</Preview>
      <Section style={main}>
        <Container style={container}>
          <Section>
            <Img
              src={`../public/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif`}
              width="130"
              height="50"
              alt="Familiarise"
              style={logo}
            />
          </Section>
          <Section style={content}>
            <Text style={heading}>Password Reset Request</Text>
            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              We received a request to reset your Familiarise account password.
              To reset your password, click the button below:
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={resetLink}>
                Reset Your Password
              </Button>
            </Section>
            <Text style={paragraph}>
              This link is valid for the next 30 minutes. If you didn't request
              a password reset, you can ignore this email.
            </Text>
            <Text style={paragraph}>
              For security reasons, this link can only be used once. If you need
              to reset your password again, please request a new link.
            </Text>
            <Text style={paragraph}>
              Best regards,
              <br />
              The Familiarise Security Team
            </Text>
          </Section>
          <Section style={footer}>
            <Text style={footerText}>
              © 2023 Familiarise, All Rights Reserved
            </Text>
            <Text style={footerText}>
              Our mailing address:
              <br />
              123 Familiarise Way, Innovation District, Techville
            </Text>
            <Text style={footerLinks}>
              <Link href={`${getAppUrl()}/privacy`} style={link}>
                Privacy Policy
              </Link>{" "}
              •{" "}
              <Link href={`${getAppUrl()}/terms`} style={link}>
                Terms of Service
              </Link>
            </Text>
          </Section>
        </Container>
      </Section>
    </Html>
  );
};

// Styles
const main = {
  backgroundColor: "#f5f5f5",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif',
};

const container = {
  margin: "0 auto",
  padding: "20px 0",
  maxWidth: "600px",
};

const logo = {
  margin: "0 auto",
  display: "block",
};

const content = {
  backgroundColor: "#ffffff",
  padding: "30px",
  borderRadius: "5px",
};

const heading = {
  fontSize: "28px",
  fontWeight: "bold",
  color: "#333",
  lineHeight: "1.3",
  margin: "0 0 20px",
};

const paragraph = {
  fontSize: "16px",
  lineHeight: "1.5",
  color: "#444",
  margin: "0 0 20px",
};

const buttonContainer = {
  textAlign: "center" as const,
  margin: "30px 0",
};

const button = {
  backgroundColor: "#000000",
  borderRadius: "5px",
  color: "#fff",
  fontSize: "16px",
  fontWeight: "normal",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "12px 20px",
};

const footer = {
  textAlign: "center" as const,
  margin: "20px 0",
};

const footerText = {
  fontSize: "12px",
  color: "#666",
  margin: "10px 0",
  lineHeight: "1.5",
};

const footerLinks = {
  fontSize: "12px",
  color: "#666",
  margin: "10px 0",
  lineHeight: "1.5",
};

const link = {
  color: "#666",
  textDecoration: "underline",
};
