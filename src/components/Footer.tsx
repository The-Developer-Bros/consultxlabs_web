import React from "react";
import Image from "next/image";
import {
  FaFacebook,
  FaInstagram,
  FaYoutube,
  FaLinkedin,
  FaTwitter,
} from "react-icons/fa";
import "../styles/Footer.css";

const Footer: React.FC = () => {
  return (
    <footer>
      <div className="logo">
        {/* Replace with your company logo */}
        <Image
          src="/path-to-your-logo.png"
          alt="Company Logo"
          width={500}
          height={100}
        />
      </div>
      <div className="columns">
        <div className="column">
          <h2>Explore Areas of Expertise</h2>
          <ul>
            <li>Doctors</li>
            <li>Lawyers</li>
            <li>Engineers</li>
            <li>Designers</li>
            <li>Higher Education</li>
          </ul>
          <h2>Follow Us</h2>
          <ul className="social-icons">
            <li>
              <FaFacebook />
            </li>
            <li>
              <FaInstagram />
            </li>
            <li>
              <FaYoutube />
            </li>
            <li>
              <FaLinkedin />
            </li>
            <li>
              <FaTwitter />
            </li>
          </ul>
        </div>
        <div className="column">
          <h2>Overview</h2>
          <ul>
            <li>About</li>
            <li>Career</li>
            <li>Press</li>
            <li>Contact</li>
            <li>Term of Service</li>
            <li>Privacy Policy</li>
            <li>Global Sitemap</li>
            <li>Local Sitemap</li>
          </ul>
        </div>
        <div className="column">
          <h2>Community</h2>
          <ul>
            <li>Community Central</li>
            <li>Support</li>
            <li>Help</li>
            <li>Do not Sell my info</li>
          </ul>
          <h2>Advertise</h2>
          <ul>
            <li>Media kit</li>
            <li>Contact</li>
          </ul>
        </div>
        <div className="column">
          <h2>ConsultX Apps</h2>
          <p>Stay in touch with us over other platforms</p>
          <h2>Mobile App</h2>
          <div className="mobile-app">
            {/* Replace with your app logo */}
            <Image
              className="logo"
              src="/path-to-your-app-logo.png"
              alt="App Logo"
              width={100}
              height={100}
            />
            <Image
              className="apple-store"
              src="/path-to-apple-store-logo.png"
              alt="Apple Store"
              width={100}
              height={100}
            />
            <Image
              className="android-store"
              src="/path-to-android-store-logo.png"
              alt="Android Store"
              width={100}
              height={100}
            />
          </div>
          <h2>ConsultX Labs Udemy Channel</h2>
          {/* Replace with your Udemy logo */}
          <Image
            src="/path-to-udemy-logo.png"
            alt="Udemy Logo"
            width={100}
            height={100}
          />
        </div>
      </div>
    </footer>
  );
};

export default Footer;
