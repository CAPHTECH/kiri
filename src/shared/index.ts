export function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function notImplemented(feature: string): never {
  throw new Error(`Feature not implemented: ${feature}`);
}
