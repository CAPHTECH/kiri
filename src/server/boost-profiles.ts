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
  /** Directories to exclude from blacklist (e.g., ["docs/"]) */
  blacklistExceptions: string[];

  /** Multiplicative factors for different file types */
  fileTypeMultipliers: {
    /** Documentation files (.md, .yaml, .yml, .mdc) */
    doc: number;
    /** Implementation files (src/**) */
    impl: number;
    /** Configuration files (tsconfig.json, package.json, etc.) */
    config: number;
  };

  /** Path-specific multipliers (e.g., src/app/ gets higher boost than src/) */
  pathMultipliers: Record<string, number>;
}

export type BoostProfileName = "default" | "docs" | "none" | "balanced";

/**
 * Boost profile definitions
 * Centralized configuration for all boost profiles
 */
export const BOOST_PROFILES: Record<BoostProfileName, BoostProfileConfig> = {
  default: {
    blacklistExceptions: [],
    fileTypeMultipliers: {
      doc: 0.5, // 50% penalty for docs
      impl: 1.3, // 30% boost for implementation
      config: 0.05, // 95% penalty for config files
    },
    pathMultipliers: {
      "src/app/": 1.4,
      "src/components/": 1.3,
      "src/lib/": 1.2,
      "src/": 1.0,
    },
  },

  docs: {
    blacklistExceptions: ["docs/"],
    fileTypeMultipliers: {
      doc: 1.5, // 50% boost for docs
      impl: 0.5, // 50% penalty for implementation
      config: 0.05, // Config files still penalized
    },
    pathMultipliers: {}, // No path-specific boosts in docs mode
  },

  balanced: {
    blacklistExceptions: ["docs/"],
    fileTypeMultipliers: {
      doc: 1.0, // No penalty for docs
      impl: 1.0, // No boost for implementation
      config: 0.3, // Relaxed penalty for config (was 0.05)
    },
    pathMultipliers: {}, // No path-specific boosts in balanced mode
  },

  none: {
    blacklistExceptions: [],
    fileTypeMultipliers: {
      doc: 1.0, // No penalty/boost
      impl: 1.0, // No penalty/boost
      config: 1.0, // No penalty/boost
    },
    pathMultipliers: {},
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
