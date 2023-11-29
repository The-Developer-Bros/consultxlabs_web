"use client";
import AnnouncementBar from "@/components/AnnouncementBar";
import Banner from "@/components/Banner";
import Footer from "@/components/Footer";
import TestimonialsSection from "@/components/TestimonialSection";
import store from "@/redux/store";
import { Provider as ReduxProvider } from "react-redux";
import Navbar from "../components/Navbar";

export default function Home() {
  return (
    <ReduxProvider store={store}>
      <AnnouncementBar />
      <Navbar />
      <Banner />
      {/* <UserCarousel /> */}
      <TestimonialsSection />
      <Footer />
    </ReduxProvider>
  );
}
 