import React from 'react';

const categories = [
  { title: 'Consultant Category 1', expertise: 'Business Strategy', rating: '4.5', location: 'London' },
  { title: 'Consultant Category 2', expertise: 'Finance', rating: '4.3', location: 'New York' },
  { title: 'Consultant Category 3', expertise: 'IT Services', rating: '4.2', location: 'Los Angeles' },
  { title: 'Consultant Category 4', expertise: 'Marketing', rating: '4.7', location: 'Chicago' },
];

export default function ExploreExperts() {
  return (
    <div className="p-10">
      <h1 className="text-2xl font-bold mb-4">Consultant Categories</h1>
      <div className="mb-4">
        <input className="w-full p-2 border rounded" type="text" placeholder="Search..." />
      </div>
      <div className="grid grid-cols-4 gap-4">
        {categories.map((category, index) => (
          <div key={index} className="flex flex-col items-center p-4 border rounded shadow-sm">
            <div className="w-16 h-16 bg-gray-200 mb-2"></div>
            <h2 className="text-lg font-semibold">{category.title}</h2>
            <p className="text-sm text-gray-500">{category.expertise}</p>
            <p className="text-sm text-gray-500">{category.rating}⭐ {category.location}</p>
          </div>
        ))}
      </div>
    </div>
  );
}