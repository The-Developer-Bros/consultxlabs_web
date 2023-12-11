import { setIsAnnouncementBarOpen } from "@/redux/announcementSlice";
import { RootState } from "@/redux/store";
import { useDispatch, useSelector } from "react-redux";

const AnnouncementBar = () => {
  const dispatch = useDispatch();
  const isAnnouncementBarOpen = useSelector(
    (state: RootState) => state.announcement.isAnnouncementBarOpen
  );

  const handleClose = () => {
    dispatch(setIsAnnouncementBarOpen(false));
  };

  if (!isAnnouncementBarOpen) {
    return null;
  }

  return (
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
  );
};

export default AnnouncementBar;
