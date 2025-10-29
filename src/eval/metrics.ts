export interface RetrievalEvent {
  id: string;
  timestampMs: number;
}

export function precisionAtK(
  retrievedIds: string[],
  relevantIds: Iterable<string>,
  k: number
): number {
  if (k <= 0 || retrievedIds.length === 0) {
    return 0;
  }
  const relevantSet = new Set(relevantIds);
  if (relevantSet.size === 0) {
    return 0;
  }
  const limit = Math.min(k, retrievedIds.length);
  let hits = 0;
  for (let index = 0; index < limit; index += 1) {
    const id = retrievedIds[index];
    if (id !== undefined && relevantSet.has(id)) {
      hits += 1;
    }
  }
  return hits / limit;
}

export interface LatencyEvent {
  timestampMs: number;
  relevant: boolean;
}

export function timeToFirstUseful(
  events: LatencyEvent[],
  options: { startTimestampMs?: number } = {}
): number {
  if (events.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const sorted = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  const baseline =
    typeof options.startTimestampMs === "number"
      ? options.startTimestampMs
      : (sorted[0]?.timestampMs ?? 0);
  for (const event of sorted) {
    if (event.relevant) {
      const deltaMs = event.timestampMs - baseline;
      return Math.max(0, deltaMs) / 1000;
    }
  }
  return Number.POSITIVE_INFINITY;
}

export interface EvaluateRetrievalOptions {
  items: RetrievalEvent[];
  relevant: Iterable<string>;
  k: number;
}

export interface RetrievalMetrics {
  precisionAtK: number;
  timeToFirstUseful: number;
}

export function evaluateRetrieval(options: EvaluateRetrievalOptions): RetrievalMetrics {
  const { items, relevant, k } = options;
  const ids = items.map((item) => item.id);
  const precision = precisionAtK(ids, relevant, k);
  const relevantSet = new Set(relevant);
  const latencyEvents: LatencyEvent[] = items.map((item) => ({
    timestampMs: item.timestampMs,
    relevant: relevantSet.has(item.id),
  }));
  const ttff = timeToFirstUseful(latencyEvents);
  return { precisionAtK: precision, timeToFirstUseful: ttff };
}
