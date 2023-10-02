"use client";
import { Provider } from "react-redux";
import store from "@/redux/store";
import Navbar from "../components/Navbar";
import AnnouncementBar from "@/components/AnnouncementBar";
import TestimonialsSection from "@/components/TestimonialSection";
import Footer from "@/components/Footer";
export default function Home() {
  return (
    <Provider store={store}>
      <AnnouncementBar />
      <Navbar />
      <main className="flex min-h-screen flex-col items-center justify-between p-24">
        {/* Your main content goes here */}
      </main>
      <TestimonialsSection />
      <Footer />
    </Provider>
  );
}
