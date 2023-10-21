import { useState } from "react";
import { RootState } from "@/redux/store";
import { setUser } from "@/redux/userSlice";
import Image from "next/image";
import { useSelector } from "react-redux";
import consultxlogo from "src/assets/images/consultx-logo.png";

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
    <Image src={consultxlogo} alt="ConsultX Logo" width={100} height={20} />

    <div style={{ display: "flex", alignItems: "center", gap: "50px" }}>
      <div style={{ position: "relative" }}>
        <button onMouseEnter={() => setShowConsultants(true)} onMouseLeave={() => setShowConsultants(false)}>
          Find a Consultant
        </button>
        {showConsultants && (
          <div style={{ position: "absolute", top: "100%", left: 0 }}>
            {/* Add your categories here */}
            <p>Doctor</p>
            <p>Lawyer</p>
            <p>Engineer</p>
            {/* ... */}
          </div>
        )}
      </div>

      <button>Upcoming Webinars</button>
      <button>How it Works</button>
      <button>Podcasts</button>
      <button>Blog</button>
      <button>Pricing</button>
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
              style={{ marginRight: "10px" }}
              onClick={() => {
                /* Implement your sign up logic here */
              }}
            >
              Sign up
            </button>
            <button
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
