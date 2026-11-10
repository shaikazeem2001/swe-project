import { z } from "zod";

/**
 * Server-side validation for the favorite movie.
 * `.trim()` runs first, so "   " becomes "" and fails min().
 * Control characters (newlines, tabs, NUL) are rejected: the title ends up in
 * an LLM prompt and in the UI, so we keep it to a single clean line.
 */
export const movieTitleSchema = z
  .string({ error: "Please enter a movie title." })
  .trim()
  .min(2, "Movie title must be at least 2 characters.")
  .max(100, "Movie title must be at most 100 characters.")
  .regex(/^[^\p{Cc}]+$/u, "Movie title contains invalid characters.");
