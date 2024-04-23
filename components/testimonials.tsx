import React from "react";
import Image from "next/image";

interface Testimonial {
  name: string;
  image: string;
  quote: string;
}

const testimonialData: Testimonial[] = [
  {
    name: "John Doe",
    image: "/images/avatar1.jpg",
    quote:
      "The team at ConsultX provided us with valuable insights that helped our business grow. Their expertise in the field is unparalleled.",
  },
  {
    name: "Jane Smith",
    image: "/images/avatar2.jpg",
    quote:
      "Working with ConsultX was a game-changer for us. Their strategic advice helped us navigate complex business challenges.",
  },
  {
    name: "Mike Johnson",
    image: "/images/avatar3.jpg",
    quote:
      "The consultants at ConsultX are top-notch. They helped us optimize our processes and improve efficiency.",
  },
];

interface TestimonialCardProps {
  name: string;
  image: string;
  quote: string;
}

const TestimonialCard: React.FC<TestimonialCardProps> = ({
  name,
  image,
  quote,
}) => (
  <div className="bg-white p-8 border border-gray-200 rounded-lg shadow-sm">
    <div className="flex items-center justify-center">
      <Image
        src={image}
        alt={`${name}'s face`}
        width={48}
        height={48}
        className="rounded-full"
      />
    </div>
    <h3 className="mt-6 text-center text-xl font-medium text-gray-900">
      {name}
    </h3>
    <p className="mt-2 text-center text-gray-500">&quot;{quote}&quot;</p>
  </div>
);

const TestimonialSection: React.FC = () => (
  <div className="bg-gray-100">
    <div className="max-w-7xl mx-auto py-16 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-3xl font-extrabold text-gray-900">
          Hear what our customers have to say about us
        </h2>
        <p className="mt-4 text-lg text-gray-500">
          Check out what our customers are saying about us!
        </p>
      </div>
      <div className="mt-16">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {testimonialData.map((testimonial, index) => (
            <TestimonialCard key={index} {...testimonial} />
          ))}
        </div>
      </div>
    </div>
  </div>
);

export default TestimonialSection;
