import { useState } from "react";
import { useSelector } from "react-redux";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useSession, signOut } from "next-auth/react";
import { RootState } from "@/redux/store";
import consultxlogo from "../../public/static/assets/logos/ConsultX-logos/ConsultX-logos_transparent.png";

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

  return (
    <>
      {/* Main Navbar */}
      <nav
        className={`fixed top-0 w-full z-50 bg-white ${
          isAnnouncementBarOpen ? "pt-12" : "pt-0"
        } px-6 lg:px-0`}
      >
        <div className="flex justify-between items-center">
          <Image src={consultxlogo} alt="ConsultX Logo" height={60} />

          <div className="lg:hidden">
            <button onClick={toggleMenu} aria-label="Toggle Navigation">
              ☰
            </button>
          </div>

          <div className="hidden lg:flex gap-8">
            {session?.user && <button>Feed</button>}
            <button>Experts</button>
            <button>Webinar</button>
            <button>Events</button>
            <button>Community</button>
            <button>Blog</button>
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
        <div className="lg:hidden fixed top-0 left-0 h-full w-4/5 bg-white z-50 transition-transform duration-500 ease-in-out transform translate-x-0">
          <div className="flex justify-end p-4">
            <button onClick={closeMenu}>&times;</button>
          </div>
          <div className="flex flex-col gap-4 p-4">
            {session?.user && <button>Feed</button>}
            <button>Experts</button>
            <button>Webinar</button>
            <button>Events</button>
            <button>Community</button>
            <button>Blog</button>
          </div>
        </div>
      )}
    </>
  );
};

export default Navbar;
