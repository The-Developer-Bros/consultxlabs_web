import { Button } from "@react-email/button";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Hr } from "@react-email/hr";
import { Html } from "@react-email/html";
import { Img } from "@react-email/img";
import { Link } from "@react-email/link";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import { formatCurrencyAmount } from "@/utils/formatting";
import * as React from "react";
import { getAppUrl } from "@/lib/url";

interface PaymentSuccessEmailProps {
  name: string;
  consultantName: string;
  appointmentType: "consultation" | "subscription" | "webinar" | "class";
  amount: number;
  currency: string;
  receiptUrl?: string;
  dashboardUrl?: string;
}

export const PaymentSuccessEmail = ({
  name = "Valued User",
  consultantName = "Expert Consultant",
  appointmentType = "consultation",
  amount = 100,
  currency = "USD",
  receiptUrl,
  dashboardUrl = "https://familiarise.com/dashboard",
}: PaymentSuccessEmailProps) => {
  const previewText = `Payment confirmed! Your ${appointmentType} with ${consultantName} is scheduled`;

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
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
            <Section style={successBanner}>
              <Text style={successIcon}>✓</Text>
              <Text style={successHeading}>Payment Successful!</Text>
            </Section>

            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              Great news! Your payment has been successfully processed. Your{" "}
              {appointmentType} with <strong>{consultantName}</strong> is now
              confirmed.
            </Text>

            <Section style={paymentDetails}>
              <table style={detailsTable}>
                <tbody>
                  <tr>
                    <td style={detailLabel}>Amount Paid:</td>
                    <td style={detailValue}>
                      {formatCurrencyAmount(amount, currency)}
                    </td>
                  </tr>
                  <tr>
                    <td style={detailLabel}>Type:</td>
                    <td style={detailValue}>
                      {appointmentType.charAt(0).toUpperCase() +
                        appointmentType.slice(1)}
                    </td>
                  </tr>
                  <tr>
                    <td style={detailLabel}>Consultant:</td>
                    <td style={detailValue}>{consultantName}</td>
                  </tr>
                </tbody>
              </table>
            </Section>

            <Text style={paragraph}>
              <strong>What's next?</strong>
            </Text>
            <Text style={listItem}>
              • Check your dashboard for appointment details and scheduling
              information
            </Text>
            <Text style={listItem}>
              • You'll receive a separate email with calendar invite and meeting
              link
            </Text>
            <Text style={listItem}>
              • Prepare any questions or materials you'd like to discuss
            </Text>

            <Section style={buttonContainer}>
              <Button style={button} href={dashboardUrl}>
                View Dashboard
              </Button>
            </Section>

            {receiptUrl && (
              <>
                <Hr style={divider} />
                <Text style={paragraph}>
                  <Link href={receiptUrl} style={link}>
                    Download Receipt
                  </Link>
                </Text>
              </>
            )}

            <Hr style={divider} />

            <Text style={paragraph}>
              If you have any questions, please don't hesitate to contact us at{" "}
              <Link href="mailto:support@familiarise.com" style={link}>
                support@familiarise.com
              </Link>
            </Text>

            <Text style={paragraph}>
              Best regards,
              <br />
              The Familiarise Team
            </Text>
          </Section>
          <Section style={footer}>
            <Text style={footerText}>
              © 2023 Familiarise, All Rights Reserved
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

const successBanner = {
  backgroundColor: "#dcfce7",
  padding: "20px",
  borderRadius: "5px",
  textAlign: "center" as const,
  margin: "0 0 30px",
  border: "2px solid #16a34a",
};

const successIcon = {
  fontSize: "48px",
  color: "#16a34a",
  margin: "0 0 10px",
  lineHeight: "1",
};

const successHeading = {
  fontSize: "24px",
  fontWeight: "bold",
  color: "#166534",
  lineHeight: "1.3",
  margin: "0",
};

const paragraph = {
  fontSize: "16px",
  lineHeight: "1.5",
  color: "#444",
  margin: "0 0 20px",
};

const listItem = {
  fontSize: "16px",
  lineHeight: "1.5",
  color: "#444",
  margin: "0 0 10px",
  paddingLeft: "0",
};

const paymentDetails = {
  backgroundColor: "#f9f9f9",
  padding: "20px",
  borderRadius: "5px",
  margin: "20px 0",
  border: "1px solid #e0e0e0",
};

const detailsTable = {
  width: "100%",
  borderCollapse: "collapse" as const,
};

const detailLabel = {
  fontSize: "14px",
  color: "#666",
  padding: "8px 0",
  width: "40%",
};

const detailValue = {
  fontSize: "16px",
  color: "#333",
  fontWeight: "600",
  padding: "8px 0",
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
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "14px 24px",
};

const divider = {
  borderColor: "#e0e0e0",
  margin: "30px 0",
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
