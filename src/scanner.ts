import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git", ".keepsafe", ".venv", "venv", "env",
  "node_modules", "dist", "build", "__pycache__",
]);

const DEFAULT_IGNORED_FILES = new Set([".DS_Store"]);

export interface FileScanResult {
  absolutePath: string;
  relativePath: string;
  size: number;
  contentHash: string;
}

interface IgnoreRule {
  baseDir: string;
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
}

export function scanTextFiles(root: string): FileScanResult[] {
  const results: FileScanResult[] = [];
  walkTextFiles(root, root, [], results);
  return results;
}

function walkTextFiles(
  root: string,
  currentDir: string,
  inheritedRules: IgnoreRule[],
  results: FileScanResult[]
): void {
  const rules = [...inheritedRules, ...loadGitignoreRules(currentDir)];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  } catch {
    return;
  }

  for (const entry of entries) {
    if (DEFAULT_IGNORED_DIRS.has(entry.name) || DEFAULT_IGNORED_FILES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");

    if (shouldIgnore(absolutePath, entry.isDirectory(), rules)) {
      continue;
    }

    if (entry.isDirectory()) {
      walkTextFiles(root, absolutePath, rules, results);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const scan = scanFile(absolutePath);
    if (scan === null) {
      continue;
    }
    results.push({ absolutePath, relativePath, size: scan.size, contentHash: scan.contentHash });
  }
}

export function scanFile(filePath: string): { size: number; contentHash: string } | null {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return null;
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return null;
  }

  // Reject binary files (contain null bytes)
  if (buffer.includes(0)) {
    return null;
  }

  // Reject non-UTF-8 files
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }

  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
  return { size, contentHash };
}

function shouldIgnore(entryPath: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, entryPath, isDir)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function ruleMatches(rule: IgnoreRule, entryPath: string, isDir: boolean): boolean {
  if (rule.directoryOnly && !isDir) {
    return false;
  }

  let relative: string;
  try {
    relative = path.relative(rule.baseDir, entryPath).replace(/\\/g, "/");
  } catch {
    return false;
  }
  if (relative.startsWith("..")) {
    return false;
  }

  const pattern = rule.pattern;

  if (rule.anchored || pattern.includes("/")) {
    return globMatch(relative, pattern);
  }

  const parts = relative.split("/");
  return parts.some((part) => globMatch(part, pattern));
}

function globMatch(text: string, pattern: string): boolean {
  let regexStr = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*";
        i++;
      } else {
        regexStr += "[^/]*";
      }
    } else if (c === "?") {
      regexStr += "[^/]";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end !== -1) {
        regexStr += pattern.slice(i, end + 1);
        i = end;
      } else {
        regexStr += "\\[";
      }
    } else {
      regexStr += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  regexStr += "$";
  return new RegExp(regexStr).test(text);
}

function loadGitignoreRules(directory: string): IgnoreRule[] {
  const gitignorePath = path.join(directory, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(gitignorePath, "utf-8");
  } catch {
    return [];
  }

  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const negated = line.startsWith("!");
    if (negated) {
      line = line.slice(1);
    }

    const anchored = line.startsWith("/");
    if (anchored) {
      line = line.slice(1);
    }

    const directoryOnly = line.endsWith("/");
    if (directoryOnly) {
      line = line.slice(0, -1);
    }

    if (!line) {
      continue;
    }

    rules.push({ baseDir: directory, pattern: line, negated, directoryOnly, anchored });
  }

  return rules;
}
