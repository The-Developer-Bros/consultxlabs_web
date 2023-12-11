import { useState, useEffect } from "react";
import { useSelector } from "react-redux";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useSession, signOut } from "next-auth/react";
import { RootState } from "@/redux/store";
import consultxlogo from "../../public/static/assets/logos/ConsultX-logos/ConsultX-logos_transparent.png";
import { motion } from "framer-motion";
import Link from "next/link";

const Navbar = () => {
  const router = useRouter();
  const isAnnouncementBarOpen = useSelector(
    (state: RootState) => state.announcement.isAnnouncementBarOpen
  );
  const { data: session } = useSession();
  const [isOpen, setIsOpen] = useState(false);

  const toggleMenu = () => {
    setIsOpen(!isOpen);
  };

  const closeMenu = () => {
    setIsOpen(false);
  };

  const [isScrolled, setIsScrolled] = useState(false);

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

  return (
    <>
      {/* Main Navbar */}
      <nav
        className={`fixed top-0 w-full z-50 py-2 bg-white ${
          isAnnouncementBarOpen ? "pt-12" : "pt-0"
        } px-6 lg:px-0 ${isScrolled ? "shadow-md" : ""}`}
      >
        <div className="flex justify-between items-center">
          <Image src={consultxlogo} alt="ConsultX Logo" height={60} />

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

          <div className="flex items-center">
            {session?.user ? (
              <>
                <Image
                  src={session.user.image!}
                  alt="Profile"
                  width={50}
                  height={50}
                  className="rounded-full cursor-pointer"
                />
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
                    /* Implement your sign-up logic here */
                  }}
                >
                  Sign up
                </button>
                <button
                  className="mr-2 bg-black text-white border border-black rounded px-2 py-1"
                  onClick={() => {
                    router.replace("/auth/signin");
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
