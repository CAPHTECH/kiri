/**
 * Test fixture factories for database records
 * These factories help maintain consistency when schema changes occur
 */

/**
 * File table record structure
 */
export interface FileRecord {
  repo_id: number;
  path: string;
  blob_hash: string;
  ext: string;
  lang: string;
  is_binary: boolean;
  mtime: string;
  [key: string]: string | number | boolean; // Index signature for buildInsertStatement compatibility
}

/**
 * Document metadata record structure
 */
export interface DocumentMetadataRecord {
  repo_id: number;
  path: string;
  source: string;
  data: string;
  [key: string]: string | number; // Index signature for buildInsertStatement compatibility
}

/**
 * Create a file record with default values
 *
 * @param repoId Repository ID
 * @param overrides Partial overrides for default values
 * @returns FileRecord with defaults applied
 */
export function createFileRecord(
  repoId: number,
  overrides: Partial<Omit<FileRecord, "repo_id">> = {}
): FileRecord {
  return {
    repo_id: repoId,
    path: "docs/README.md",
    blob_hash: "test-hash",
    ext: ".md",
    lang: "markdown",
    is_binary: false,
    mtime: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Create a document metadata record with default values
 *
 * @param repoId Repository ID
 * @param overrides Partial overrides for default values
 * @returns DocumentMetadataRecord with defaults applied
 */
export function createDocumentMetadataRecord(
  repoId: number,
  overrides: Partial<Omit<DocumentMetadataRecord, "repo_id">> = {}
): DocumentMetadataRecord {
  return {
    repo_id: repoId,
    path: "docs/README.md",
    source: "front_matter",
    data: JSON.stringify({ title: "Test" }),
    ...overrides,
  };
}

/**
 * Helper to build parameterized INSERT statement from a record object
 *
 * @param tableName Name of the table
 * @param record Record object with column names as keys
 * @returns Object with SQL string and values array
 */
export function buildInsertStatement<T extends Record<string, unknown>>(
  tableName: string,
  record: T
): { sql: string; values: unknown[] } {
  const columns = Object.keys(record);
  const placeholders = columns.map(() => "?").join(", ");
  const sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`;
  const values = Object.values(record);

  return { sql, values };
}
