#!/usr/bin/env tsx
/**
 * Fix kiri-large-100.yaml expected section
 *
 * Moves metadata.expected to the correct expected section at the end
 */

import { readFileSync, writeFileSync } from "node:fs";

import { parse, stringify } from "yaml";

interface Query {
  id: string;
  text: string;
  goal: string;
  metadata: {
    category: string;
    expected?: string[];
  };
}

interface Dataset {
  schemaVersion: string;
  name: string;
  datasetId: string;
  description: string;
  version: string;
  defaultParams: {
    k: number;
    timeoutMs: number;
  };
  queries: Query[];
  expected?: Array<{
    id: string;
    reference: {
      paths: string[];
    };
  }>;
}

async function main(): Promise<void> {
  const inputPath = "datasets/kiri-large-100.yaml";
  const outputPath = "datasets/kiri-large-100-fixed.yaml";

  console.log(`📖 Reading ${inputPath}...`);
  const content = readFileSync(inputPath, "utf-8");
  const dataset = parse(content) as Dataset;

  console.log(`📝 Processing ${dataset.queries.length} queries...`);

  // Extract expected from metadata and build expected section
  const expected: Array<{
    id: string;
    reference: {
      paths: string[];
    };
  }> = [];

  const queriesWithoutMetadataExpected = dataset.queries.map((query) => {
    const { expected: metadataExpected, ...restMetadata } = query.metadata;

    if (metadataExpected && metadataExpected.length > 0) {
      expected.push({
        id: query.id,
        reference: {
          paths: metadataExpected,
        },
      });
    }

    return {
      ...query,
      metadata: restMetadata,
    };
  });

  // Build new dataset structure
  const fixedDataset: Dataset = {
    ...dataset,
    queries: queriesWithoutMetadataExpected,
    expected,
  };

  console.log(`✅ Generated expected section with ${expected.length} entries`);

  // Write output
  const output = stringify(fixedDataset, {
    indent: 2,
    lineWidth: 120,
  });

  writeFileSync(outputPath, output, "utf-8");
  console.log(`💾 Saved to ${outputPath}`);

  // Stats
  console.log(`\n📊 Stats:`);
  console.log(`  Total queries: ${dataset.queries.length}`);
  console.log(`  With expected: ${expected.length}`);
  console.log(`  Without expected: ${dataset.queries.length - expected.length}`);

  // Category breakdown
  const categoryCount: Record<string, number> = {};
  dataset.queries.forEach((q) => {
    const cat = q.metadata.category;
    categoryCount[cat] = (categoryCount[cat] || 0) + 1;
  });

  console.log(`\n📂 Category breakdown:`);
  Object.entries(categoryCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([category, count]) => {
      console.log(`  ${category}: ${count}`);
    });
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
