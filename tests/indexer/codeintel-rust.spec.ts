import { describe, expect, it } from "vitest";

import { analyzeSource } from "../../src/indexer/codeintel.js";

describe("analyzeSource with Rust language", () => {
  it("extracts symbols and doc comments", async () => {
    const rustCode = `/// Struct doc
pub struct Foo {
    value: i32,
}

impl Foo {
    /// Adds one
    pub fn add_one(&self) {}
}

pub trait Greeter {
    fn greet(&self);
}

fn helper() {}
`;

    const result = await analyzeSource("src/lib.rs", "Rust", rustCode, new Set(["src/lib.rs"]));

    const namesAndKinds = result.symbols.map((s) => ({ name: s.name, kind: s.kind }));
    expect(namesAndKinds).toEqual(
      expect.arrayContaining([
        { name: "Foo", kind: "struct" },
        { name: "impl Foo", kind: "impl" },
        { name: "add_one", kind: "method" },
        { name: "Greeter", kind: "trait" },
        { name: "greet", kind: "method" },
        { name: "helper", kind: "function" },
      ])
    );

    const structDoc = result.symbols.find((s) => s.name === "Foo");
    expect(structDoc?.doc).toBe("Struct doc");

    expect(result.snippets).toHaveLength(result.symbols.length);
  });

  it("extracts enum, const, static, type, and macro symbols", async () => {
    const rustCode = `
/// Status enum
pub enum Status {
    Active,
    Inactive,
}

/// Maximum size constant
pub const MAX_SIZE: usize = 1024;

/// Global counter
pub static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Type alias for Result
pub type Result<T> = std::result::Result<T, Error>;

/// Helper macro
macro_rules! log {
    ($msg:expr) => {
        println!("{}", $msg);
    };
}

mod submodule {
    pub fn inner() {}
}
`;

    const result = await analyzeSource("src/lib.rs", "Rust", rustCode, new Set(["src/lib.rs"]));

    const namesAndKinds = result.symbols.map((s) => ({ name: s.name, kind: s.kind }));
    expect(namesAndKinds).toEqual(
      expect.arrayContaining([
        { name: "Status", kind: "enum" },
        { name: "MAX_SIZE", kind: "const" },
        { name: "COUNTER", kind: "static" },
        { name: "Result", kind: "type" },
        { name: "log", kind: "macro" },
        { name: "submodule", kind: "mod" },
        { name: "inner", kind: "function" },
      ])
    );

    // Doc comment on enum
    const enumSymbol = result.symbols.find((s) => s.name === "Status");
    expect(enumSymbol?.doc).toBe("Status enum");

    // Doc comment on const
    const constSymbol = result.symbols.find((s) => s.name === "MAX_SIZE");
    expect(constSymbol?.doc).toBe("Maximum size constant");
  });

  it("extracts trait method signatures (function_signature_item)", async () => {
    const rustCode = `
pub trait Iterator {
    type Item;

    /// Returns the next item
    fn next(&mut self) -> Option<Self::Item>;

    /// Returns size hint
    fn size_hint(&self) -> (usize, Option<usize>);
}
`;

    const result = await analyzeSource("src/lib.rs", "Rust", rustCode, new Set(["src/lib.rs"]));

    const namesAndKinds = result.symbols.map((s) => ({ name: s.name, kind: s.kind }));
    expect(namesAndKinds).toEqual(
      expect.arrayContaining([
        { name: "Iterator", kind: "trait" },
        { name: "next", kind: "method" },
        { name: "size_hint", kind: "method" },
      ])
    );

    // Doc comment on trait method
    const nextMethod = result.symbols.find((s) => s.name === "next");
    expect(nextMethod?.doc).toBe("Returns the next item");
  });

  it("collects dependencies from use and mod statements", async () => {
    const rustCode = `
mod utils;

use crate::foo::{bar, nested::deep};
use std::collections::HashMap;
use crate::glob::*;
extern crate regex;
use crate::foo::Bar;
`;

    const fileSet = new Set<string>([
      "src/lib.rs",
      "src/utils.rs",
      "src/foo/bar.rs",
      "src/foo/mod.rs",
      "src/foo/nested/deep.rs",
      "src/glob/mod.rs",
      "src/foo.rs",
    ]);

    const result = await analyzeSource("src/lib.rs", "Rust", rustCode, fileSet);

    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        { dstKind: "path", dst: "src/utils.rs", rel: "mod" },
        { dstKind: "path", dst: "src/foo/bar.rs", rel: "import" },
        { dstKind: "path", dst: "src/foo/nested/deep.rs", rel: "import" },
        { dstKind: "path", dst: "src/foo.rs", rel: "import" },
        { dstKind: "package", dst: "std", rel: "import" },
        { dstKind: "package", dst: "regex", rel: "extern_crate" },
        { dstKind: "path", dst: "src/glob/mod.rs", rel: "import" },
      ])
    );
  });

  it("returns empty result for empty files", async () => {
    const result = await analyzeSource("src/lib.rs", "Rust", "", new Set(["src/lib.rs"]));
    expect(result).toEqual({ symbols: [], snippets: [], dependencies: [] });
  });

  it("resolves self:: imports correctly", async () => {
    const rustCode = `
use self::utils::helper;
use self::models::User;
`;

    const fileSet = new Set<string>(["src/lib.rs", "src/utils.rs", "src/models.rs"]);

    const result = await analyzeSource("src/lib.rs", "Rust", rustCode, fileSet);

    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        { dstKind: "path", dst: "src/utils.rs", rel: "import" },
        { dstKind: "path", dst: "src/models.rs", rel: "import" },
      ])
    );
  });

  it("resolves super:: imports correctly including chained super::", async () => {
    // super:: は現在のディレクトリの親を参照する
    // src/feature/sub/module.rs から super:: は src/feature/sub/ の親 = src/feature/
    const rustCode = `
use super::sibling;
use super::super::feature_peer;
`;

    const fileSet = new Set<string>([
      "src/feature/sub/module.rs",
      "src/feature/sibling.rs", // super:: から参照
      "src/feature_peer.rs", // super::super:: から参照
    ]);

    const result = await analyzeSource("src/feature/sub/module.rs", "Rust", rustCode, fileSet);

    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        { dstKind: "path", dst: "src/feature/sibling.rs", rel: "import" },
        { dstKind: "path", dst: "src/feature_peer.rs", rel: "import" },
      ])
    );
  });

  it("handles block doc comments (/** */)", async () => {
    const rustCode = `
/**
 * Block doc comment for struct
 */
pub struct Config {
    pub name: String,
}

/// Regular line doc comment
pub fn setup() {}
`;

    const result = await analyzeSource("src/lib.rs", "Rust", rustCode, new Set(["src/lib.rs"]));

    const configStruct = result.symbols.find((s) => s.name === "Config");
    expect(configStruct?.doc).toContain("Block doc comment for struct");

    const setupFn = result.symbols.find((s) => s.name === "setup");
    expect(setupFn?.doc).toBe("Regular line doc comment");
  });

  it("handles syntax errors gracefully", async () => {
    const rustCode = `
pub struct Incomplete {
    // Missing closing brace
`;

    const result = await analyzeSource("src/lib.rs", "Rust", rustCode, new Set(["src/lib.rs"]));

    // Should not throw, may return partial results or empty
    expect(result).toBeDefined();
    expect(result.symbols).toBeDefined();
    expect(result.snippets).toBeDefined();
    expect(result.dependencies).toBeDefined();
  });
});
