/**
 * Shared CLI Argument Parsing Utilities
 *
 * Provides consistent --help and --version handling across all kiri commands.
 */

import { parseArgs } from "util";

/**
 * CLI option specification
 */
export interface CliOption {
  /** Option flag name (without --) */
  flag: string;
  /** Short flag (single character, optional) */
  short?: string;
  /** Option type */
  type: "string" | "boolean";
  /** Default value */
  default?: string | boolean;
  /** Description for help text */
  description: string;
  /** Placeholder for help text (e.g., "<path>", "<port>") */
  placeholder?: string;
}

/**
 * Help section for grouping related options
 */
export interface HelpSection {
  /** Section title */
  title: string;
  /** Options in this section */
  options: CliOption[];
}

/**
 * Complete CLI specification
 */
export interface CliSpec {
  /** Command name (e.g., "kiri", "kiri-server") */
  commandName: string;
  /** Command description */
  description: string;
  /** Package version */
  version: string;
  /** Usage line (e.g., "kiri [options]") */
  usage: string;
  /** Help sections grouping related options */
  sections: HelpSection[];
  /** Optional examples */
  examples?: string[];
}

/**
 * Parsed CLI arguments result
 */
export interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
}

/**
 * Render help message to stdout
 */
export function renderHelp(spec: CliSpec): void {
  console.log(`${spec.description}\n`);
  console.log(`Usage: ${spec.usage}\n`);

  // Render each section
  for (const section of spec.sections) {
    console.log(`${section.title}:`);
    for (const opt of section.options) {
      const shortFlag = opt.short ? `-${opt.short}, ` : "    ";
      const longFlag = `--${opt.flag}`;
      const placeholder = opt.placeholder || "";
      const flagDisplay = `${shortFlag}${longFlag}${placeholder ? " " + placeholder : ""}`;

      // Pad to 40 characters for alignment
      const padding = " ".repeat(Math.max(1, 40 - flagDisplay.length));
      const defaultInfo = opt.default !== undefined ? ` (default: ${opt.default})` : "";

      console.log(`  ${flagDisplay}${padding}${opt.description}${defaultInfo}`);
    }
    console.log();
  }

  // Common options (help and version)
  console.log("Common:");
  console.log("  -h, --help                              Show this help message");
  console.log("  -v, --version                           Show version information");
  console.log();

  // Examples
  if (spec.examples && spec.examples.length > 0) {
    console.log("Examples:");
    for (const example of spec.examples) {
      console.log(`  ${example}`);
    }
    console.log();
  }
}

/**
 * Render version information to stdout
 */
export function renderVersion(commandName: string, version: string): void {
  console.log(`${commandName} v${version}`);
}

/**
 * Define CLI with automatic --help and --version handling
 *
 * @param spec CLI specification
 * @returns Parsed arguments (if not exited via --help or --version)
 */
export function defineCli(spec: CliSpec): ParsedArgs {
  // Build parseArgs options from spec
  const options: Record<
    string,
    { type: "string" | "boolean"; short?: string; default?: string | boolean }
  > = {};

  // Add all defined options
  for (const section of spec.sections) {
    for (const opt of section.options) {
      options[opt.flag] = {
        type: opt.type,
        ...(opt.short && { short: opt.short }),
        ...(opt.default !== undefined && { default: opt.default }),
      };
    }
  }

  // Add help and version options
  options.help = { type: "boolean", short: "h" };
  options.version = { type: "boolean", short: "v" };

  // Parse arguments
  const { values } = parseArgs({ options, allowPositionals: true });

  // Handle --help
  if (values.help) {
    renderHelp(spec);
    process.exit(0);
  }

  // Handle --version
  if (values.version) {
    renderVersion(spec.commandName, spec.version);
    process.exit(0);
  }

  return { values };
}
