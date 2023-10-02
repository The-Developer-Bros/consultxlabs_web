// TestimonialsSection.tsx
import React, { useState } from "react";
import Image from "next/image";
import "tailwindcss/tailwind.css";

interface TestimonialProps {
  name: string;
  testimonial: string;
  image: string;
  id: number;
}

const Testimonial: React.FC<TestimonialProps & { isActive: boolean }> = ({
  name,
  testimonial,
  image,
  isActive,
}) => {
  return (
    <div
      className={`flex flex-col items-center justify-center w-48 h-48 m-2 p-5 rounded-lg shadow-md transition-all duration-300 ease-in-out relative ${
        isActive ? "transform scale-150 z-10 shadow-lg" : "opacity-50"
      }`}
    >
      <Image src={image} alt={name} width={200} height={200} />
      <h2 className="text-lg font-bold">{name}</h2>
      <p className="text-sm">{testimonial}</p>
    </div>
  );
};

const TestimonialsSection: React.FC = () => {
  const [currentIndex, setCurrentIndex] = useState(0); // Add this line

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    } else {
      setCurrentIndex(testimonials.length - 1); // Replace items with testimonials
    }
  };

  const handleNext = () => {
    if (currentIndex < testimonials.length - 1) { // Replace items with testimonials
      setCurrentIndex(currentIndex + 1);
    } else {
      setCurrentIndex(0);
    }
  };

  return (
    <div className="flex overflow-hidden justify-center w-full max-w-7xl mx-auto relative">
      <button
        onClick={handlePrev}
        className="p-2 bg-blue-500 text-white rounded-lg"
      >
        Prev
      </button>
      {testimonials.map((testimonial, index) => (
        <Testimonial isActive={index === currentIndex} key={testimonial.id} {...testimonial} />
      ))}
      <button
        onClick={handleNext}
        className="p-2 bg-blue-500 text-white rounded-lg"
      >
        Next
      </button>
    </div>
  );
};

export default TestimonialsSection;



const testimonials: TestimonialProps[] = [
  {
    id: 0,
    name: "John Doe",
    testimonial:
      "Lorem ipsum dolor sit amet consectetur adipisicing elit. Quisquam, voluptatum.",
    image: "/images/testimonial-1.jpg",
  },
  {
    id: 1,
    name: "Jane Doe",
    testimonial:
      "Lorem ipsum dolor sit amet consectetur adipisicing elit. Quisquam, voluptatum.",
    image: "/images/testimonial-2.jpg",
  },
  {
    id: 2,
    name: "John Smith",
    testimonial:
      "Lorem ipsum dolor sit amet consectetur adipisicing elit. Quisquam, voluptatum.",
    image: "/images/testimonial-3.jpg",
  },
  {
    id: 3,
    name: "Jane Smith",
    testimonial:
      "Lorem ipsum dolor sit amet consectetur adipisicing elit. Quisquam, voluptatum.",
    image: "/images/testimonial-4.jpg",
  },
  {
    id: 4,
    name: "John Doe",
    testimonial:
      "Lorem ipsum dolor sit amet consectetur adipisicing elit. Quisquam, voluptatum.",
    image: "/images/testimonial-5.jpg",
  },
  {
    id: 5,
    name: "Jane Doe",
    testimonial:
      "Lorem ipsum dolor sit amet consectetur adipisicing elit. Quisquam, voluptatum.",
    image: "/images/testimonial-6.jpg",
  },
  {
    id: 6,
    name: "John Smith",
    testimonial:
      "Lorem ipsum dolor sit amet consectetur adipisicing elit. Quisquam, voluptatum.",
    image: "/images/testimonial-7.jpg",
  },
  {
    id: 7,
    name: "Jane Smith",
    testimonial:
      "Lorem ipsum dolor sit amet consectetur adipisicing elit. Quisquam, voluptatum.",
    image: "/images/testimonial-8.jpg",
  },
];
