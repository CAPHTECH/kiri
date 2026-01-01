export interface Snippet {
  path: string;
  range: [number, number];
  rangeSource: "symbol" | "window" | "clamped";
  symbols: string[];
}

export interface BundleExplanation {
  reason: string;
  weight: number;
}
