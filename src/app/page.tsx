"use client";
import { Provider } from "react-redux";
import store from "@/redux/store";
import Navbar from "../components/Navbar";
import AnnouncementBar from "@/components/AnnouncementBar";
import TestimonialsSection from "@/components/TestimonialSection";
import Footer from "@/components/Footer";
import Banner from "@/components/Banner";
import UserCarousel from "@/components/UserCarousel";
export default function Home() {
  return (
    <Provider store={store}>
      <AnnouncementBar />
      <Navbar />
      <Banner />
      {/* <UserCarousel /> */}
      <TestimonialsSection />
      <Footer />
    </Provider>
  );
}
 