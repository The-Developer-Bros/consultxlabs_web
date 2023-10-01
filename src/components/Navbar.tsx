import { RootState } from "@/redux/store";
import { setUser } from "@/redux/userSlice";
import Image from "next/image";
import { useSelector } from "react-redux";
import consultxlogo from "src/assets/images/consultx-logo.png";

const Navbar = () => {
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
        top: isAnnouncementBarOpen ? "40px" : "0", // Adjust this value based on the state of the AnnouncementBar
        width: "100%",
        display: "flex",
        justifyContent: "space-between",
        padding: "1em",
        background: "lightgray",
        alignItems: "center",
      }}
    >
      <Image src={consultxlogo} alt="ConsultX Logo" width={100} height={20} />
      <input
        type="text"
        placeholder="Search Consultants, Area of expertise and Ongoing Webinars "
        style={{
          borderRadius: "25px",
          padding: "10px",
          width: "50%",
          margin: "auto",
        }}
      />

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
