const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".json": "JSON",
  ".md": "Markdown",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".rb": "Ruby",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".hpp": "C++",
  ".cc": "C++",
  ".hh": "C++",
  ".cs": "C#",
  ".dart": "Dart",
  ".php": "PHP",
  ".swift": "Swift",
  ".kt": "Kotlin",
  ".m": "Objective-C",
  ".mm": "Objective-C++",
  ".scala": "Scala",
  ".sh": "Shell",
};

export function detectLanguage(extension: string): string | null {
  const normalized = extension.toLowerCase();
  return LANGUAGE_BY_EXTENSION[normalized] ?? null;
}
