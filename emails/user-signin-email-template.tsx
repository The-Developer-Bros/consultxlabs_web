import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
  Link,
} from "@react-email/components";
import * as React from "react";

interface UserSigninEmailProps {
  firstName: string;
}

export const UserSigninEmail: React.FC<Readonly<UserSigninEmailProps>> = ({
  firstName,
}) => (
  <Html>
    <Head />
    <Preview>Explore the Platform</Preview>
    <Body style={main}>
      <Container style={container}>
        <div style={header}>
          <div style={logo}>
            <MountainIcon style={icon} />
            <span style={logoText}>ConsultX</span>
          </div>
          <Text style={headerText}>Explore the Platform</Text>
        </div>
        <div style={{ display: "flex", flexDirection: "row", gap: "10px" }}>
          <Heading style={h2}>
            Discover the Power of ConsultX, {firstName}!
          </Heading>
          <Text style={text}>
            Unlock a world of possibilities with our comprehensive consulting
            platform. Explore the features that can transform your business.
          </Text>
          <div style={grid}>
            <div style={gridItem}>
              <BriefcaseIcon style={gridIcon} />
              <div>
                <Heading style={gridHeading}>Expert Consulting</Heading>
                <Text style={gridText}>
                  Leverage the expertise of our seasoned consultants to tackle
                  your toughest challenges.
                </Text>
              </div>
            </div>
            <div style={gridItem}>
              <ClipboardIcon style={gridIcon} />
              <div>
                <Heading style={gridHeading}>Comprehensive Insights</Heading>
                <Text style={gridText}>
                  Gain in-depth analysis and actionable recommendations to drive
                  your business forward.
                </Text>
              </div>
            </div>
            <div style={gridItem}>
              <RocketIcon style={gridIcon} />
              <div>
                <Heading style={gridHeading}>Accelerated Growth</Heading>
                <Text style={gridText}>
                  Unlock new opportunities and scale your business with our
                  innovative solutions.
                </Text>
              </div>
            </div>
            <div style={gridItem}>
              <ShieldIcon style={gridIcon} />
              <div>
                <Heading style={gridHeading}>Secure and Compliant</Heading>
                <Text style={gridText}>
                  Rest assured that your data and operations are protected with
                  our robust security measures.
                </Text>
              </div>
            </div>
          </div>
          <Text style={footerText}>
            Explore the full range of features and services offered by ConsultX.
            Contact us today to learn more and unlock your business's true
            potential.
          </Text>
          <div style={buttonWrapper}>
            <Link style={button} href="#">
              Explore Website
            </Link>
          </div>
        </div>
      </Container>
    </Body>
  </Html>
);

export default UserSigninEmail;

const MountainIcon = (props) => (
  <svg
    {...props}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m8 3 4 8 5-5 5 15H2L8 3z" />
  </svg>
);

const BriefcaseIcon = (props) => (
  <svg
    {...props}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="20" height="14" x="2" y="7" rx="2" ry="2" />
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
  </svg>
);

const ClipboardIcon = (props) => (
  <svg
    {...props}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
  </svg>
);

const RocketIcon = (props) => (
  <svg
    {...props}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </svg>
);

const ShieldIcon = (props) => (
  <svg
    {...props}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
  </svg>
);

const main = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
};

const container = {
  margin: "auto",
  padding: "24px",
  borderRadius: "8px",
  maxWidth: "600px",
};

const header = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "24px",
};

const logo = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const icon = {
  height: "32px",
  width: "32px",
};

const logoText = {
  fontSize: "24px",
  fontWeight: "600",
};

const headerText = {
  fontSize: "14px",
  color: "#6B7280",
};

const content = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const h2 = {
  fontSize: "24px",
  fontWeight: "700",
  margin: "0",
};

const text = {
  fontSize: "16px",
  color: "#6B7280",
  margin: "0",
};

const grid = {
  display: "grid",
  gap: "16px",
};

const gridItem = {
  display: "flex",
  alignItems: "start",
  gap: "16px",
};

const gridIcon = {
  height: "24px",
  width: "24px",
  color: "#000000",
};

const gridHeading = {
  fontSize: "18px",
  fontWeight: "600",
  margin: "0",
};

const gridText = {
  fontSize: "14px",
  color: "#6B7280",
  margin: "0",
};

const footerText = {
  fontSize: "14px",
  color: "#6B7280",
  margin: "0",
};

const buttonWrapper = {
  display: "flex",
  justifyContent: "center",
};

const button = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "6px",
  backgroundImage: "linear-gradient(to right, #000000, #A9A9A9)",
  padding: "12px 24px",
  fontSize: "14px",
  fontWeight: "600",
  color: "#ffffff",
  textDecoration: "none",
  transition: "background-image 0.3s",
  boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
  ":hover": {
    backgroundImage: "linear-gradient(to right, #A9A9A9, #000000)",
  },
  ":focus": {
    outline: "none",
    boxShadow: "0 0 0 2px #1F2937, 0 0 0 4px rgba(0, 0, 0, 0.2)",
  },
};
