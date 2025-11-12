/**
 * Validation utilities for CLI arguments and user input
 */

/**
 * Parse a string to a positive integer with validation
 *
 * @param value - String value to parse
 * @param defaultValue - Default value if input is undefined
 * @param name - Parameter name for error messages
 * @returns Parsed integer
 * @throws Error if value is not a valid positive integer
 */
export function parsePositiveInt(
  value: string | undefined,
  defaultValue: number,
  name: string
): number {
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(
      `Invalid ${name}: "${value}". Expected a positive integer. Use default ${defaultValue} or specify a valid number.`
    );
  }
  return parsed;
}
