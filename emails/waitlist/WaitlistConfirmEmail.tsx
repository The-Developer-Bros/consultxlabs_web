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

interface WaitlistConfirmEmailProps {
  name?: string | null;
  confirmLink: string;
}

export const WaitlistConfirmEmail = ({
  name,
  confirmLink = "https://familiarise.com/api/waitlist/confirm",
}: WaitlistConfirmEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Confirm your Familiarise subscription</Preview>
      <Section style={main}>
        <Container style={container}>
          <Section>
            <Img
              src={`${getAppUrl()}/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif`}
              width="130"
              height="50"
              alt="Familiarise"
              style={logo}
            />
          </Section>
          <Section style={content}>
            <Text style={heading}>One click to confirm</Text>
            <Text style={paragraph}>Hi{name ? ` ${name}` : ""},</Text>
            <Text style={paragraph}>
              You asked to join the Familiarise waitlist. Confirm that this is
              your email address and we will let you know what we are building,
              who is joining, and when you can get in.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={confirmLink}>
                Confirm subscription
              </Button>
            </Section>
            <Text style={paragraph}>
              This link is valid for the next 48 hours. If you did not sign up,
              you can safely ignore this email — we will not add you to anything
              until you click.
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
