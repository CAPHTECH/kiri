export const DEFAULT_COMPACT_MODE = true;

export function resolveCompactFlag(value: boolean | undefined): boolean {
  return value ?? DEFAULT_COMPACT_MODE;
}
