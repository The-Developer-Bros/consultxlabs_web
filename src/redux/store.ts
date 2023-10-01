// store.ts
import { configureStore } from "@reduxjs/toolkit";
import userReducer from "./userSlice";
import announcementReducer from "./announcementSlice";

const store = configureStore({
  reducer: {
    user: userReducer,
    announcement: announcementReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export default store;
