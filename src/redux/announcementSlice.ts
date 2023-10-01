// announcementSlice.ts
import { createSlice, PayloadAction } from "@reduxjs/toolkit";

interface AnnouncementState {
  isAnnouncementBarOpen: boolean;
}

const initialState: AnnouncementState = {
  isAnnouncementBarOpen: true,
};

const announcementSlice = createSlice({
  name: "announcement",
  initialState,
  reducers: {
    setIsAnnouncementBarOpen: (state, action: PayloadAction<boolean>) => {
      state.isAnnouncementBarOpen = action.payload;
    },
  },
});

export const { setIsAnnouncementBarOpen } = announcementSlice.actions;

export default announcementSlice.reducer;
