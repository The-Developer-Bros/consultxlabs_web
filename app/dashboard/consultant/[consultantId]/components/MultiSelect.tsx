"use client";

import * as React from "react";

interface Option {
  value: string;
  label: string;
}

interface MultiSelectProps {
  options: Option[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}

export function MultiSelect({
  options = [],
  selected = [],
  onChange,
  placeholder = "Select options",
}: MultiSelectProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Ensure we're working with arrays
  const safeSelected = Array.isArray(selected) ? selected : [];
  const safeOptions = Array.isArray(options) ? options : [];

  const selectedOptions = safeOptions.filter((option) =>
    safeSelected.includes(option.value),
  );

  const filteredOptions = safeOptions.filter((option) =>
    option.label.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  // Handle clicking outside to close dropdown
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleToggleOption = (value: string) => {
    const newSelected = safeSelected.includes(value)
      ? safeSelected.filter((item) => item !== value)
      : [...safeSelected, value];
    onChange(newSelected);
  };

  const handleRemoveOption = (e: React.MouseEvent, valueToRemove: string) => {
    e.stopPropagation();
    const newSelected = safeSelected.filter((value) => value !== valueToRemove);
    onChange(newSelected);
  };

  return (
    <div className="relative" ref={containerRef}>
      <div
        className="min-h-[38px] px-3 py-2 border rounded-md cursor-pointer bg-white flex flex-wrap gap-1 items-center"
        onClick={() => setIsOpen(!isOpen)}
      >
        {selectedOptions.length > 0 ? (
          selectedOptions.map((option) => (
            <span
              key={option.value}
              className="bg-gray-100 px-2 py-1 rounded-md text-sm flex items-center gap-1"
            >
              {option.label}
              <button
                onClick={(e) => handleRemoveOption(e, option.value)}
                className="ml-1 text-gray-500 hover:text-gray-700"
              >
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="text-gray-400">{placeholder}</span>
        )}
      </div>

      {isOpen && (
        <div className="absolute z-10 w-full mt-1 bg-white border rounded-md shadow-lg max-h-60 overflow-auto">
          <div className="sticky top-0 bg-white border-b p-2">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-2 py-1 border rounded-md"
              placeholder="Search..."
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          {filteredOptions.map((option) => (
            <div
              key={option.value}
              className={`px-3 py-2 cursor-pointer hover:bg-gray-100 ${
                safeSelected.includes(option.value) ? "bg-gray-50" : ""
              }`}
              onClick={() => handleToggleOption(option.value)}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={safeSelected.includes(option.value)}
                  onChange={() => {}}
                  className="h-4 w-4"
                />
                <span>{option.label}</span>
              </div>
            </div>
          ))}
          {filteredOptions.length === 0 && (
            <div className="px-3 py-2 text-gray-500">No options available</div>
          )}
        </div>
      )}
    </div>
  );
}
