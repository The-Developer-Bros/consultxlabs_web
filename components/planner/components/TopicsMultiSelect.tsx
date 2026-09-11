"use client";

import type React from "react";

import { useState, useEffect, useRef, useMemo } from "react";
import { X, Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormLabel, FormMessage, FormDescription } from "@/components/ui/form";

interface TopicsMultiSelectProps {
  initialTopics?: string[];
  onTopicsChange?: (topics: string[]) => void;
  availableTopics?: {
    id: string;
    name: string;
    createdAt?: Date;
    updatedAt?: Date;
  }[];
  isLoading?: boolean;
  label?: string;
  error?: string;
  helpText?: string;
  className?: string;
  showCard?: boolean;
}

export function TopicsMultiSelect({
  initialTopics = [],
  onTopicsChange,
  availableTopics = [],
  isLoading = false,
  label = "Topics",
  error,
  helpText = "Select from existing topics or create new ones",
  className = "",
  showCard = false,
}: Readonly<TopicsMultiSelectProps>) {
  const [topics, setTopics] = useState<string[]>(initialTopics);
  const [inputValue, setInputValue] = useState("");
  const [suggestions, setSuggestions] = useState<
    { id: string; name: string }[]
  >([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Memoize stable references for complex deps to avoid unnecessary re-renders
  const initialTopicsKey = useMemo(() => JSON.stringify(initialTopics), [initialTopics]);
  const topicsKey = useMemo(() => JSON.stringify(topics), [topics]);
  const availableTopicsKey = useMemo(() => JSON.stringify(availableTopics), [availableTopics]);

  // Initialize with initial topics only once on mount or when initialTopics changes
  useEffect(() => {
    setTopics(initialTopics);
  }, [initialTopicsKey, initialTopics]);

  // Handle outside clicks to close suggestions dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        !inputRef.current?.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Update suggestions when input changes
  useEffect(() => {
    if (inputValue.trim() === "") {
      setSuggestions([]);
      return;
    }

    const filteredSuggestions = availableTopics
      .filter(
        (topic) =>
          topic.name.toLowerCase().includes(inputValue.toLowerCase()) &&
          !topics.includes(topic.name),
      )
      .slice(0, 5);

    setSuggestions(filteredSuggestions);
  }, [inputValue, availableTopicsKey, topicsKey, availableTopics, topics]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputValue(value);
    setShowSuggestions(true);
  };

  const addTopic = (topic: string = inputValue) => {
    if (topic.trim() === "") return;

    // Check for duplicates (case-insensitive)
    const isDuplicate = topics.some(
      (existingTopic) =>
        existingTopic.trim().toLowerCase() === topic.trim().toLowerCase(),
    );

    if (isDuplicate) return;

    const nextTopics = [...topics, topic];
    setTopics(nextTopics);
    onTopicsChange?.(nextTopics);
    setInputValue("");
    setSuggestions([]);
    inputRef.current?.focus();
  };

  const removeTopic = (index: number) => {
    const nextTopics = topics.filter((_, i) => i !== index);
    setTopics(nextTopics);
    onTopicsChange?.(nextTopics);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTopic();
    } else if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      // Focus the first suggestion if possible
      const suggestionsElement = suggestionsRef.current;
      if (suggestionsElement) {
        const firstSuggestion = suggestionsElement.querySelector("li");
        if (firstSuggestion) {
          (firstSuggestion as HTMLElement).focus();
        }
      }
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    addTopic(suggestion);
    setShowSuggestions(false);
  };

  const content = (
    <div className={`space-y-4 ${className}`}>
      {label && <FormLabel>{label}</FormLabel>}

      <div className="relative">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              ref={inputRef}
              type="text"
              placeholder="Add a topic..."
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={() => inputValue && setShowSuggestions(true)}
              className="w-full"
              disabled={isLoading}
            />
            {isLoading && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
          <Button
            onClick={() => addTopic()}
            disabled={
              !inputValue.trim() || isLoading || topics.includes(inputValue)
            }
            type="button"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add
          </Button>
        </div>

        {/* Suggestions dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div
            ref={suggestionsRef}
            className="absolute z-10 mt-1 w-full bg-background border rounded-md shadow-lg max-h-60 overflow-auto"
          >
            <ul className="py-1">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  className="w-full text-left px-4 py-2 hover:bg-muted cursor-pointer focus:bg-muted focus:outline-none"
                  onClick={() => handleSuggestionClick(suggestion.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSuggestionClick(suggestion.name);
                    }
                  }}
                  type="button"
                >
                  {suggestion.name}
                </button>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Topics list */}
      <div className="flex flex-wrap gap-2">
        {topics.length === 0 ? (
          <p className="text-muted-foreground text-sm">No topics added yet.</p>
        ) : (
          topics.map((topic) => (
            <Badge
              key={`topic-${topic}`}
              variant="secondary"
              className="px-3 py-1 text-sm flex items-center gap-1"
            >
              {topic}
              <button
                onClick={() => removeTopic(topics.indexOf(topic))}
                className="ml-1 rounded-full hover:bg-muted-foreground/20 p-0.5"
                aria-label={`Remove ${topic}`}
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))
        )}
      </div>
      {error && <FormMessage>{error}</FormMessage>}
      {helpText && !error && <FormDescription>{helpText}</FormDescription>}
    </div>
  );

  if (showCard) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{label}</CardTitle>
        </CardHeader>
        <CardContent>{content}</CardContent>
      </Card>
    );
  }

  return content;
}
