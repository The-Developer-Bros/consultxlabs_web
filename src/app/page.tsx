"use client";
import { Provider } from "react-redux";
import store from "@/redux/store";
import Navbar from "../components/Navbar";
import AnnouncementBar from "@/components/AnnouncementBar";
import TestimonialsSection from "@/components/TestimonialSection";
import Footer from "@/components/Footer";
import Banner from "@/components/Banner";
export default function Home() {
  return (
    <Provider store={store}>
      <AnnouncementBar />
      <Navbar />
        <Banner />
      <TestimonialsSection />
      <Footer />
    </Provider>
  );
}
