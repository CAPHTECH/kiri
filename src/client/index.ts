export function buildContextBundleRequest(
  snippets: Array<{ path: string; lines: number[] }>
): string {
  // TODO: align with MCP client schema
  return JSON.stringify({ snippets }, null, 2);
}
