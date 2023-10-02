// Testimonial.tsx
import React from "react";

interface TestimonialProps {
  name: string;
  testimonial: string;
  image: string;
  isActive: boolean;
}

const Testimonial: React.FC<TestimonialProps> = ({
  name,
  testimonial,
  image,
  isActive,
}) => {
  return (
    <div className={`testimonial ${isActive ? "active" : ""}`}>
      <img src={image} alt={name} />
      <h2>{name}</h2>
      <p>{testimonial}</p>
    </div>
  );
};

export default Testimonial;
