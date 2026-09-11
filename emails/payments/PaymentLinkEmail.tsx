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

interface PaymentLinkEmailProps {
  name: string;
  consultantName: string;
  appointmentType: "consultation" | "subscription" | "webinar" | "class";
  amount: number;
  currency: string;
  paymentUrl: string;
  expiresAt: string; // ISO date string
}

export const PaymentLinkEmail = ({
  name = "Valued User",
  consultantName = "Expert Consultant",
  appointmentType = "consultation",
  amount = 100,
  currency = "USD",
  paymentUrl = "https://familiarise.com/payment",
  expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
}: PaymentLinkEmailProps) => {
  const previewText = `Payment required for your ${appointmentType} with ${consultantName}`;
  const expiryDate = new Date(expiresAt).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

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
            <Text style={heading}>Payment Required</Text>
            <Text style={paragraph}>Hi {name},</Text>
            <Text style={paragraph}>
              Great news! <strong>{consultantName}</strong> has approved your{" "}
              {appointmentType} request. To confirm your booking, please
              complete the payment.
            </Text>

            <Section style={paymentDetails}>
              <table style={detailsTable}>
                <tbody>
                  <tr>
                    <td style={detailLabel}>Amount Due:</td>
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
                    <td style={detailLabel}>Expires:</td>
                    <td style={detailValue}>{expiryDate}</td>
                  </tr>
                </tbody>
              </table>
            </Section>

            <Section style={buttonContainer}>
              <Button style={button} href={paymentUrl}>
                Complete Payment
              </Button>
            </Section>

            <Hr style={divider} />

            <Text style={warningText}>
              ⏰ <strong>Important:</strong> This payment link will expire in 48
              hours. If you don't complete the payment, your request will be
              reverted to pending status and you'll need to reapply.
            </Text>

            <Text style={paragraph}>
              If you have any questions or need assistance, please contact us at{" "}
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
  backgroundColor: "#16a34a",
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

const warningText = {
  fontSize: "14px",
  lineHeight: "1.5",
  color: "#d97706",
  backgroundColor: "#fef3c7",
  padding: "12px",
  borderRadius: "5px",
  margin: "20px 0",
  border: "1px solid #fde68a",
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
