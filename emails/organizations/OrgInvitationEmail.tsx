import { Button } from "@react-email/button";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Html } from "@react-email/html";
import { Link } from "@react-email/link";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import * as React from "react";
import { getAppUrl } from "@/lib/url";

interface OrgInvitationEmailProps {
  inviterName: string;
  orgName: string;
  role: string;
  inviteUrl: string;
  expiresAt?: string;
}

export const OrgInvitationEmail = ({
  inviterName = "An administrator",
  orgName = "an organization",
  role = "member",
  inviteUrl = "https://familiarise.com",
  expiresAt,
}: OrgInvitationEmailProps) => {
  const roleLabel = role.replace("ORG_", "").toLowerCase();
  const expiryText = expiresAt
    ? `This invitation expires on ${new Date(expiresAt).toLocaleDateString("en-IN", { dateStyle: "long" })}.`
    : "This invitation expires in 14 days.";

  return (
    <Html>
      <Head />
      <Preview>
        You have been invited to join {orgName} on Familiarise
      </Preview>
      <Section style={main}>
        <Container style={container}>
          <Section style={content}>
            <Text style={heading}>
              You&apos;re invited to join {orgName}
            </Text>
            <Text style={paragraph}>
              {inviterName} has invited you to join <strong>{orgName}</strong> on
              Familiarise as a <strong>{roleLabel}</strong>.
            </Text>
            <Text style={paragraph}>
              Familiarise is an expert services marketplace where you can
              connect with consultants, join webinars, attend classes, and
              grow your skills.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={inviteUrl}>
                Accept Invitation
              </Button>
            </Section>
            <Text style={smallText}>{expiryText}</Text>
            <Text style={paragraph}>
              If you did not expect this invitation, you can safely ignore
              this email.
            </Text>
            <Text style={paragraph}>
              Best regards,
              <br />
              The Familiarise Team
            </Text>
          </Section>
          <Section style={footer}>
            <Text style={footerText}>
              © {new Date().getFullYear()} Familiarise, All Rights Reserved
            </Text>
            <Text style={footerLinks}>
              <Link href={`${getAppUrl()}/privacy`} style={link}>
                Privacy Policy
              </Link>{" "}
              &bull;{" "}
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

const main = {
  backgroundColor: "#f5f5f5",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif',
};
const container = { margin: "0 auto", padding: "20px 0", maxWidth: "600px" };
const content = {
  backgroundColor: "#ffffff",
  padding: "30px",
  borderRadius: "5px",
};
const heading = {
  fontSize: "24px",
  fontWeight: "bold" as const,
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
const smallText = {
  fontSize: "13px",
  lineHeight: "1.5",
  color: "#888",
  margin: "0 0 20px",
};
const buttonContainer = { textAlign: "center" as const, margin: "30px 0" };
const button = {
  backgroundColor: "#000000",
  borderRadius: "5px",
  color: "#fff",
  fontSize: "16px",
  fontWeight: "normal" as const,
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "12px 20px",
};
const footer = { textAlign: "center" as const, margin: "20px 0" };
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
const link = { color: "#666", textDecoration: "underline" };
