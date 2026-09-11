/**
 * Service for managing topics
 */

import type { Topic } from "@prisma/client";

export class TopicService {
  /**
   * Get all available topics, optionally filtered by query
   */
  static async getTopics(query?: string): Promise<Topic[]> {
    try {
      const url = new URL("/api/user/content/topics", window.location.origin);
      if (query) {
        url.searchParams.set("query", query);
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Failed to fetch topics");
      }

      const { data } = await response.json();
      return data;
    } catch (error) {
      console.error("[TopicService.getTopics] Error:", error);
      return [];
    }
  }

  /**
   * Create topics by name, returning IDs of created/existing topics
   */
  static async createTopics(topicNames: string[]): Promise<string[]> {
    try {
      if (!Array.isArray(topicNames) || topicNames.length === 0) {
        return [];
      }

      // Process and deduplicate topic names
      const processedTopics = topicNames
        .map((topic) => topic.trim())
        .filter((topic) => topic && topic.length >= 2);

      const uniqueTopicNames = processedTopics.reduce((acc, current) => {
        const lowerCaseName = current.toLowerCase();
        if (!acc.some((item) => item.toLowerCase() === lowerCaseName)) {
          acc.push(current);
        }
        return acc;
      }, [] as string[]);

      if (uniqueTopicNames.length === 0) {
        return [];
      }

      const response = await fetch("/api/user/content/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: uniqueTopicNames }),
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ error: "Failed to parse error response" }));
        throw new Error(errorData.error || "Failed to create topics via API");
      }

      const { data: topics } = await response.json();
      if (!Array.isArray(topics)) {
        throw new Error("Invalid response format from topic creation API");
      }

      return topics.map((topic: Topic) => topic.id);
    } catch (error) {
      console.error("[TopicService.createTopics] Error:", error);
      throw error;
    }
  }

  /**
   * Delete topics by IDs
   */
  static async deleteTopics(topicIds: string[]): Promise<boolean> {
    if (topicIds.length === 0) {
      return true;
    }

    try {
      const response = await fetch("/api/user/content/topics", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: topicIds }),
      });

      return response.ok;
    } catch (error) {
      console.error("[TopicService.deleteTopics] Error:", error);
      return false;
    }
  }

  /**
   * Process topic names from form data
   * - Trims whitespace
   * - Converts to sentence case
   * - Removes special characters
   * - Filters duplicates and short names
   */
  static processTopicNames(topics: string[]): string[] {
    if (!Array.isArray(topics) || topics.length === 0) {
      return [];
    }

    return topics
      .map((topic) => {
        // Remove extra whitespace and trim
        let processed = topic.trim().replace(/\s+/g, " ");

        // Convert to sentence case
        processed = processed.toLowerCase();
        processed = processed.charAt(0).toUpperCase() + processed.slice(1);

        // Remove special characters except spaces and alphanumeric
        processed = processed.replace(/[^a-zA-Z0-9\s]/g, "");

        return processed;
      })
      .filter(
        (topic, index, self) =>
          // Filter out empty topics and those less than 2 characters
          topic.length >= 2 &&
          // Filter out duplicates (case-insensitive)
          self.findIndex((t) => t.toLowerCase() === topic.toLowerCase()) ===
            index,
      );
  }
}
