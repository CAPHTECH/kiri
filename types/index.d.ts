export interface Snippet {
  path: string;
  range: [number, number];
  symbols: string[];
}

export interface BundleExplanation {
  reason: string;
  weight: number;
}
