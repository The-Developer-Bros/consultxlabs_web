"use client";
import { motion } from "framer-motion";
import micromatch from "micromatch";
import { signOut, useSession } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import consultxlogo from "../public/static/assets/logos/ConsultX-logos/ConsultX-logos_transparent.png";

const Navbar = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isAnnouncementBarOpen, setIsAnnouncementBarOpen] = useState(true);

  const toggleMenu = () => {
    setIsOpen(!isOpen);
  };

  const closeMenu = () => {
    setIsOpen(false);
  };

  const handleClose = () => {
    setIsAnnouncementBarOpen(false);
  };

  useEffect(() => {
    const checkScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };

    window.addEventListener("scroll", checkScroll);

    // Cleanup after the effect:
    return () => {
      window.removeEventListener("scroll", checkScroll);
    };
  }, []); // Empty dependency array ensures this runs once on mount and unmount

  const apiRoutes = ["/api/**"];
  const publicAuthRoutes = ["/auth/**"];
  const formRoutes = ["/form/**"];
  const excludeNavbar =
    micromatch.isMatch(pathname, apiRoutes) ||
    micromatch.isMatch(pathname, publicAuthRoutes) ||
    micromatch.isMatch(pathname, formRoutes);
  if (excludeNavbar) return null;

  return (
    <>
      {isAnnouncementBarOpen && (
        <div
          style={{
            width: "100%",
            backgroundColor: "black",
            color: "white",
            textAlign: "center",
            padding: "10px 0",
            position: "fixed",
            top: 0,
            zIndex: 1000,
            display: "flex",
            justifyContent: "center",
          }}
        >
          🔥 Exciting sale coming soon! Get ready for amazing discounts on
          consultancy sessions! 🔥
          <button
            style={{ color: "white", marginRight: "10px" }}
            onClick={handleClose}
          >
            X
          </button>
        </div>
      )}

      {/* Main Navbar */}
      <nav
        className={`fixed top-0 w-full z-50 py-2 bg-white ${
          isAnnouncementBarOpen ? "pt-12" : "pt-0"
        } px-6 lg:px-0 ${isScrolled ? "shadow-md" : ""}`}
      >
        <div className="flex justify-between items-center">
          <Link href="/">
            <Image src={consultxlogo} alt="ConsultX Logo" height={60} />
          </Link>
          <div className="lg:hidden">
            <button onClick={toggleMenu} aria-label="Toggle Navigation">
              ☰
            </button>
          </div>

          <div className="hidden lg:flex gap-8">
            {session?.user && (
              <Link href="/feed">
                <button>Feed</button>
              </Link>
            )}
            <Link href="/explore/experts">
              <button>Experts</button>
            </Link>
            <Link href="/explore/programs">
              <button>Programs</button>
            </Link>
            <Link href="/explore/community">
              <button>Community</button>
            </Link>
            <Link href="/blog">
              <button>Blog</button>
            </Link>
          </div>

          <div className="flex items-center">
            {session?.user ? (
              <>
                <Link href="/profile">
                  <Image
                    src={session.user.image!}
                    alt="Profile"
                    width={50}
                    height={50}
                    className="rounded-full cursor-pointer"
                  />
                </Link>
                <button
                  onClick={() => {
                    signOut();
                  }}
                  className="ml-2"
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <button
                  className="mr-2 border border-black rounded px-2 py-1"
                  onClick={() => {
                    try {
                      // TODO: Redirect to the sign up page
                      router.push("/auth/signin");
                    } catch (e) {
                      console.log(e);
                    }
                  }}
                >
                  Sign up
                </button>
                <button
                  className="mr-2 bg-black text-white border border-black rounded px-2 py-1"
                  onClick={() => {
                    try {
                      router.push("/auth/signin");
                    } catch (e) {
                      console.log(e);
                    }
                  }}
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Side Drawer */}
      {isOpen && (
        <motion.div
          className="lg:hidden fixed top-0 left-0 h-full w-4/5 bg-white z-50"
          initial={{ x: "-100%" }}
          animate={{ x: 0 }}
          exit={{ x: "-100%" }}
          transition={{ type: "spring", duration: 1 }}
        >
          <div className="flex justify-end p-4">
            <button onClick={closeMenu}>&times;</button>
          </div>
          <div className="flex flex-col gap-4 p-4">
            {session?.user && (
              <Link href="//feed">
                <button>Feed</button>
              </Link>
            )}
            <Link href="/explore/experts">
              <button>Experts</button>
            </Link>
            <Link href="/explore/webinar">
              <button>Webinar</button>
            </Link>
            <Link href="/explore/events">
              <button>Events</button>
            </Link>
            <Link href="/explore/community">
              <button>Community</button>
            </Link>
            <Link href="/blog">
              <button>Blog</button>
            </Link>
          </div>
        </motion.div>
      )}
    </>
  );
};

export default Navbar;
