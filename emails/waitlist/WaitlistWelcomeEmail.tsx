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

interface WaitlistWelcomeEmailProps {
  name?: string | null;
  unsubscribeLink: string;
}

export const WaitlistWelcomeEmail = ({
  name,
  unsubscribeLink = "https://familiarise.com/api/waitlist/unsubscribe",
}: WaitlistWelcomeEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>You are on the Familiarise waitlist</Preview>
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
            <Text style={heading}>You are on the list</Text>
            <Text style={paragraph}>Hi{name ? ` ${name}` : ""},</Text>
            <Text style={paragraph}>
              Thanks for confirming. You will hear from us when there is
              something genuinely worth your attention — new experts joining the
              platform, programs opening up, and the occasional note on what we
              are building. No noise.
            </Text>
            <Text style={paragraph}>
              In the meantime, you can browse who is already on Familiarise.
            </Text>
            <Text style={paragraph}>
              <Link href={`${getAppUrl()}/explore/experts`} style={inlineLink}>
                Explore experts
              </Link>
            </Text>
          </Section>
          <Section style={footer}>
            <Text style={footerText}>
              © {new Date().getFullYear()} Familiarise, All Rights Reserved
            </Text>
            <Text style={footerLinks}>
              <Link href={unsubscribeLink} style={link}>
                Unsubscribe
              </Link>{" "}
              •{" "}
              <Link href={`${getAppUrl()}/privacy`} style={link}>
                Privacy Policy
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

const inlineLink = {
  color: "#000",
  fontSize: "16px",
  textDecoration: "underline",
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
