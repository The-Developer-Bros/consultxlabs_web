import { RootState } from "@/redux/store";
import { signOut, useSession } from "next-auth/react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useSelector } from "react-redux";

import consultxlogo from "../../public/static/assets/logos/ConsultX-logos/ConsultX-logos_transparent.png";

const Navbar = () => {
  const isAnnouncementBarOpen = useSelector(
    (state: RootState) => state.announcement.isAnnouncementBarOpen
  );

  const { data: session } = useSession();

  const router = useRouter();

  return (
    <nav
      style={{
        position: "fixed",
        top: isAnnouncementBarOpen ? "40px" : "0",
        width: "100%",
        display: "flex",
        justifyContent: "space-between",
        padding: "1em",
        background: "white",
        alignItems: "center",
        zIndex: 2,
      }}
    >
      <Image src={consultxlogo} alt="ConsultX Logo" height={60} />

      <div style={{ display: "flex", alignItems: "center", gap: "50px" }}>
        {session?.user && <button>Feed</button>}
        <button style={{ color: "black" }}>Experts</button>
        <button style={{ color: "black" }}>Webinar</button>
        <button style={{ color: "black" }}>Events</button>
        <button style={{ color: "black" }}>Community</button>
        <button style={{ color: "black" }}>Blog</button>
      </div>

      <div style={{ display: "flex", alignItems: "center" }}>
        {session?.user ? (
          <>
            <Image
              src={session?.user ? session.user.image! : ""}
              alt="Profile"
              width={50}
              height={10}
              className="rounded-full cursor-pointer"
            />
            <button
              onClick={() => signOut()}
              style={{ marginLeft: "10px", color: "black" }}
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <button
              style={{
                marginRight: "10px",
                color: "black",
                border: "1px solid black",
                borderRadius: "5px",
                padding: "5px 10px",
              }}
              onClick={() => {
                /* Implement your sign up logic here */
              }}
            >
              Sign up
            </button>
            <button
              style={{
                marginRight: "10px",
                color: "white",
                background: "black",
                border: "1px solid black",
                borderRadius: "5px",
                padding: "5px 10px",
              }}
              onClick={() => {
                router.replace("/auth/signin");
              }}
            >
              Sign in
            </button>
          </>
        )}
      </div>
    </nav>
  );
};

export default Navbar;
