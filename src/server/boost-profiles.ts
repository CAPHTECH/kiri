/**
 * Boost Profile Configurations
 *
 * This module provides centralized configuration for boost_profile options.
 * Each profile defines how different file types should be ranked in search results.
 *
 * Profiles:
 * - default: Prioritizes implementation files over documentation
 * - docs: Prioritizes documentation over implementation
 * - balanced: Equal weight for both docs and implementation
 * - none: No file type boosting (pure keyword scoring)
 */

/**
 * Boost profile configuration
 * Defines how different file types should be ranked
 */
export interface BoostProfileConfig {
  /**
   * Directories to allow even if they match global denylist patterns.
   * Example: ["docs/"] allows docs/ files despite being blacklisted by default.
   * This overrides the global blacklist in applyFileTypeBoost/applyAdditiveFilePenalties.
   */
  denylistOverrides: string[];

  /** Multiplicative factors for different file types */
  fileTypeMultipliers: {
    /** Documentation files (.md, .yaml, .yml, .mdc) */
    doc: number;
    /** Implementation files (src/**) */
    impl: number;
    /** Configuration files (tsconfig.json, package.json, etc.) */
    config: number;
  };

  /**
   * Path-specific multipliers (e.g., src/app/ gets higher boost than src/)
   * Array is sorted by prefix length (longest first) to ensure correct matching priority
   */
  pathMultipliers: Array<{ prefix: string; multiplier: number }>;

  /**
   * Skip additive penalty for config files (-1.5 score penalty)
   * and only apply multiplicative penalty (e.g., 0.3x multiplier)
   * @default false
   */
  skipConfigAdditivePenalty?: boolean;
}

export type BoostProfileName = "default" | "docs" | "none" | "balanced";

/**
 * Boost profile definitions
 * Centralized configuration for all boost profiles
 */
export const BOOST_PROFILES: Record<BoostProfileName, BoostProfileConfig> = {
  default: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      doc: 0.5, // 50% penalty for docs
      impl: 1.3, // 30% boost for implementation
      config: 0.05, // 95% penalty for config files
    },
    // ✅ Sorted by prefix length (longest first) for correct matching priority
    pathMultipliers: [
      { prefix: "src/components/", multiplier: 1.3 },
      { prefix: "src/app/", multiplier: 1.4 },
      { prefix: "src/lib/", multiplier: 1.2 },
      { prefix: "src/", multiplier: 1.0 },
    ],
  },

  docs: {
    denylistOverrides: ["docs/"],
    fileTypeMultipliers: {
      doc: 1.5, // 50% boost for docs
      impl: 0.5, // 50% penalty for implementation
      config: 0.05, // Config files still penalized
    },
    pathMultipliers: [], // No path-specific boosts in docs mode
  },

  balanced: {
    denylistOverrides: ["docs/"],
    fileTypeMultipliers: {
      doc: 1.0, // No penalty for docs
      impl: 1.0, // No boost for implementation
      // Config files in balanced mode are considered more relevant for understanding
      // a project's structure alongside its documentation. Therefore, we use a
      // higher multiplier (0.3x vs 0.05x in default) to keep them accessible.
      config: 0.3,
    },
    pathMultipliers: [], // No path-specific boosts in balanced mode
    // Skip additive penalty (-1.5) for config files; use only multiplicative penalty.
    // This prevents config files from being completely deprioritized in balanced searches
    // where understanding project setup is often as important as code/docs.
    skipConfigAdditivePenalty: true,
  },

  none: {
    denylistOverrides: [],
    fileTypeMultipliers: {
      doc: 1.0, // No penalty/boost
      impl: 1.0, // No penalty/boost
      config: 1.0, // No penalty/boost
    },
    pathMultipliers: [],
  },
};

/**
 * Get boost profile configuration by name
 * @throws Error if profile name is invalid
 */
export function getBoostProfile(name: BoostProfileName): BoostProfileConfig {
  const profile = BOOST_PROFILES[name];
  if (!profile) {
    throw new Error(
      `Invalid boost profile: "${name}". ` +
        `Valid profiles are: ${Object.keys(BOOST_PROFILES).join(", ")}`
    );
  }
  return profile;
}

/**
 * Check if a profile name is valid
 */
export function isValidBoostProfile(name: string): name is BoostProfileName {
  return name in BOOST_PROFILES;
}
