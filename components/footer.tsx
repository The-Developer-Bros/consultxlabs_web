"use client";
import React from "react";
import Image from "next/image";
import {
  FaFacebook,
  FaInstagram,
  FaYoutube,
  FaLinkedin,
  FaTwitter,
} from "react-icons/fa";
import consultxlogo from "../public/static/assets/logos/ConsultX-logos/ConsultX-logos_white.png";
import Link from "next/link";
import { usePathname } from "next/navigation";
import micromatch from "micromatch";

const apiRoutes = ["/api/**"];
const publicAuthRoutes = ["/auth/**"];
const protectedRoutes = [
  "/form/**",
  "/admin/**",
  "/dashboard/**",
  "/settings/**",
  "/profile/**",
];

const Footer: React.FC = () => {
  const pathname = usePathname();

  // Exclude footer from both API and protected routes
  const excludeFooter =
    micromatch.isMatch(pathname, apiRoutes) ||
    micromatch.isMatch(pathname, protectedRoutes) ||
    micromatch.isMatch(pathname, publicAuthRoutes);
  if (excludeFooter) return null;

  return (
    <footer className="flex flex-col items-center justify-center p-5 bg-black text-white">
      <div className="w-full flex justify-center pb-5">
        {/* Replace with your company logo */}
        <Image src={consultxlogo} alt="Company Logo" width={50} height={60} />
      </div>
      <div className="flex justify-between w-full max-w-6xl">
        <div className="flex flex-col w-1/5">
          <h2 className="mb-2 text-lg font-bold">Explore Areas of Expertise</h2>
          <ul className="list-none p-0 mb-5 space-y-1">
            <li>Doctors</li>
            <li>Lawyers</li>
            <li>Engineers</li>
            <li>Designers</li>
            <li>Higher Education</li>
          </ul>
          <h2 className="mb-2 text-lg font-bold">Follow Us</h2>
          <ul className="list-none p-0 flex space-x-2">
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
        <div className="flex flex-col w-1/5">
          <h2 className="mb-2 text-lg font-bold">Overview</h2>
          <ul className="list-none p-0 mb-5 space-y-1">
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
        <div className="flex flex-col w-1/5">
          <h2 className="mb-2 text-lg font-bold">Community</h2>
          <ul className="list-none p-0 mb-5 space-y-1">
            <li>Community Central</li>
            <li>Support</li>
            <li>Help</li>
            <li>Do not Sell my info</li>
          </ul>
          <h2 className="mb-2 text-lg font-bold">Advertise</h2>
          <ul className="list-none p-0 mb-5 space-y-1">
            <li>Media kit</li>
            <li>Contact</li>
          </ul>
        </div>
        <div className="flex flex-col w-1/5">
          <h2 className="mb-2 text-lg font-bold">ConsultX Apps</h2>
          <p>Stay in touch with us over other platforms</p>
          <h2 className="mb-2 text-lg font-bold">Mobile App</h2>
          <div className="grid grid-cols-3 gap-4">
            {/* Replace with your app logo */}
            {/* Replace with your app store logos */}
          </div>
          <h2 className="mb-2 text-lg font-bold">
            ConsultX Labs Udemy Channel
          </h2>
          {/* Replace with your Udemy logo */}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row py-6 w-full shrink-0 items-center px-4 md:px-6 border-t">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          © ConsultX. All rights reserved.
        </p>
        <nav className="sm:ml-auto flex gap-4 sm:gap-6">
          <Link className="text-xs hover:underline underline-offset-4" href="#">
            Terms of Service
          </Link>
          <Link className="text-xs hover:underline underline-offset-4" href="#">
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
};

export default Footer;
