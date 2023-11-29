import { useState } from "react";
import { RootState } from "@/redux/store";
import { setUser } from "@/redux/userSlice";
import Image from "next/image";
import { useSelector } from "react-redux";
import consultxlogo from "src/assets/logos/ConsultX-logos/ConsultX-logos_transparent.png";

const Navbar = () => {
  const [showConsultants, setShowConsultants] = useState(false);
  const user = useSelector((state: RootState) => state.user.user);
  const isAnnouncementBarOpen = useSelector(
    (state: RootState) => state.announcement.isAnnouncementBarOpen
  );

  const handleLogout = () => {
    // Implement your logout logic here
    setUser(null);
  };

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
      <button style={{ color: "black" }}>Experts</button>
      <button style={{ color: "black" }}>Webinar</button>
      <button style={{ color: "black" }}>Events</button>
      <button style={{ color: "black" }}>Community</button>
      <button style={{ color: "black" }}>Blog</button>
      {user && <button>Feed</button>}
    </div>

    <div style={{ display: "flex", alignItems: "center" }}>
      {user ? (
        <>
          <Image
            src={user.profilePicture}
            alt="Profile"
            width={100}
            height={20}
          />
          <button onClick={handleLogout}>Sign out</button>
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
              /* Implement your sign in logic here */
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
