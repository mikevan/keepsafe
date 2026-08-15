"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanTextFiles = scanTextFiles;
exports.scanFile = scanFile;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const DEFAULT_IGNORED_DIRS = new Set([
    ".git", ".keepsafe", ".venv", "venv", "env",
    "node_modules", "dist", "build", "__pycache__",
]);
const DEFAULT_IGNORED_FILES = new Set([".DS_Store"]);
function scanTextFiles(root) {
    const results = [];
    walkTextFiles(root, root, [], results);
    return results;
}
function walkTextFiles(root, currentDir, inheritedRules, results) {
    const rules = [...inheritedRules, ...loadGitignoreRules(currentDir)];
    let entries;
    try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true })
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    }
    catch {
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
function scanFile(filePath) {
    let size;
    try {
        size = fs.statSync(filePath).size;
    }
    catch {
        return null;
    }
    let buffer;
    try {
        buffer = fs.readFileSync(filePath);
    }
    catch {
        return null;
    }
    // Reject binary files (contain null bytes)
    if (buffer.includes(0)) {
        return null;
    }
    // Reject non-UTF-8 files
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    }
    catch {
        return null;
    }
    const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
    return { size, contentHash };
}
function shouldIgnore(entryPath, isDir, rules) {
    let ignored = false;
    for (const rule of rules) {
        if (ruleMatches(rule, entryPath, isDir)) {
            ignored = !rule.negated;
        }
    }
    return ignored;
}
function ruleMatches(rule, entryPath, isDir) {
    if (rule.directoryOnly && !isDir) {
        return false;
    }
    let relative;
    try {
        relative = path.relative(rule.baseDir, entryPath).replace(/\\/g, "/");
    }
    catch {
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
function globMatch(text, pattern) {
    let regexStr = "^";
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "*") {
            if (pattern[i + 1] === "*") {
                regexStr += ".*";
                i++;
            }
            else {
                regexStr += "[^/]*";
            }
        }
        else if (c === "?") {
            regexStr += "[^/]";
        }
        else if (c === "[") {
            const end = pattern.indexOf("]", i + 1);
            if (end !== -1) {
                regexStr += pattern.slice(i, end + 1);
                i = end;
            }
            else {
                regexStr += "\\[";
            }
        }
        else {
            regexStr += c.replace(/[.+^${}()|\\]/g, "\\$&");
        }
    }
    regexStr += "$";
    return new RegExp(regexStr).test(text);
}
function loadGitignoreRules(directory) {
    const gitignorePath = path.join(directory, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
        return [];
    }
    let content;
    try {
        content = fs.readFileSync(gitignorePath, "utf-8");
    }
    catch {
        return [];
    }
    const rules = [];
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
//# sourceMappingURL=scanner.js.map