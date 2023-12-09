import React from "react";

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
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Etiam in ex diam.",
  },
  {
    name: "Jane Smith",
    image: "/images/avatar2.jpg",
    quote: "Ut consectetur lacus eget velit aliquam interdum nec quis purus.",
  },
  {
    name: "Mike Johnson",
    image: "/images/avatar3.jpg",
    quote: "Fusce eu nisl eu purus lobortis ullamcorper at nec enim.",
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
      <img
        className="h-12 w-12 rounded-full"
        src={image}
        alt={`${name}'s face`}
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
