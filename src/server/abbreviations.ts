/**
 * Abbreviation expansion for path matching (ADR 003)
 *
 * Bridges the vocabulary gap between natural language queries and technical path names.
 * Example: "database" → ["database", "db", "data"]
 *
 * LDE principles:
 * - Pure functions (no side effects)
 * - Readonly types (immutability)
 * - Property-based testing
 */

/**
 * Abbreviation mapping (LDE: readonly, immutable)
 */
export interface AbbreviationMap {
  readonly canonical: string; // Standard full form (e.g., "database")
  readonly variants: readonly string[]; // Common abbreviations (e.g., ["db", "data"])
}

/**
 * Default abbreviation dictionary
 *
 * Maintenance: Add new entries as needed, alphabetically sorted by canonical
 * Conflicts: Use most common meaning (e.g., "db" → "database" not "debug")
 */
export const DEFAULT_ABBREVIATIONS: readonly AbbreviationMap[] = [
  { canonical: "administrator", variants: ["admin"] },
  { canonical: "application", variants: ["app"] },
  { canonical: "authentication", variants: ["auth"] },
  { canonical: "authorization", variants: ["authz"] },
  { canonical: "configuration", variants: ["config", "cfg", "conf"] },
  { canonical: "controller", variants: ["ctrl"] },
  { canonical: "database", variants: ["db", "data"] },
  { canonical: "development", variants: ["dev"] },
  { canonical: "directory", variants: ["dir"] },
  { canonical: "document", variants: ["doc", "docs"] },
  { canonical: "error", variants: ["err", "errors"] },
  { canonical: "implementation", variants: ["impl"] },
  { canonical: "manager", variants: ["mgr"] },
  { canonical: "production", variants: ["prod"] },
  { canonical: "repository", variants: ["repo"] },
  { canonical: "service", variants: ["svc", "srv"] },
  { canonical: "source", variants: ["src"] },
  { canonical: "specification", variants: ["spec", "specs"] },
  { canonical: "temporary", variants: ["tmp", "temp"] },
  { canonical: "utilities", variants: ["util", "utils"] },
];

/**
 * Expand term with common abbreviations (LDE: pure function)
 *
 * Matches term (case-insensitive) against abbreviation dictionary and returns
 * all related forms (canonical + variants).
 *
 * @param term - Query term to expand (e.g., "db", "database", "config")
 * @param abbreviations - Abbreviation dictionary (default: DEFAULT_ABBREVIATIONS)
 * @returns Readonly array of expanded terms including canonical and all variants
 *
 * @example
 * expandAbbreviations("db") → ["database", "db", "data"]
 * expandAbbreviations("config") → ["configuration", "config", "cfg", "conf"]
 * expandAbbreviations("unknown") → ["unknown"]
 *
 * LDE properties:
 * - Pure: Same input always produces same output
 * - No side effects: Doesn't modify input or global state
 * - Immutable: Returns readonly array
 */
export function expandAbbreviations(
  term: string,
  abbreviations: readonly AbbreviationMap[] = DEFAULT_ABBREVIATIONS
): readonly string[] {
  const normalized = term.toLowerCase().trim();

  // Find matching abbreviation map (check both canonical and variants)
  const map = abbreviations.find(
    (m) => m.canonical === normalized || m.variants.includes(normalized)
  );

  if (map) {
    // Return all forms: canonical + variants
    return [map.canonical, ...map.variants];
  }

  // No match: return original term
  return [term];
}
