// TestimonialsSection.tsx
import React, { useState } from "react";
import Testimonial from "./Testimonial";
import "../styles/TestimonialsSection.css";

const testimonials = [
  {
    name: "John Doe",
    testimonial: "The consultation was really helpful. Highly recommended!",
    image: "/path/to/john-doe.jpg",
  },
  {
    name: "Jane Smith",
    testimonial: "Great service! The consultants are very knowledgeable.",
    image: "/path/to/jane-smith.jpg",
  },
  {
    name: "Bob Johnson",
    testimonial:
      "I had a great experience. Will definitely use this service again.",
    image: "/path/to/bob-johnson.jpg",
  },

  // Add more testimonials as needed
];

const TestimonialsSection: React.FC = () => {
  const [current, setCurrent] = useState(0);

  const handlePrev = () => {
    setCurrent((current - 1 + testimonials.length) % testimonials.length);
  };

  const handleNext = () => {
    setCurrent((current + 1) % testimonials.length);
  };

  return (
    <div className="testimonials">
      <button onClick={handlePrev}>Prev</button>
      {testimonials.map((testimonial, index) => (
        <Testimonial
          key={index}
          {...testimonial}
          isActive={index === current}
        />
      ))}
      <button onClick={handleNext}>Next</button>
    </div>
  );
};

export default TestimonialsSection;
