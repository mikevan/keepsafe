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
exports.CheckpointStore = void 0;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const zlib = __importStar(require("node:zlib"));
const scanner_1 = require("./scanner");
const MAX_INLINE_NEW_FILE_BYTES = 256 * 1024;
const MAX_INLINE_CHECKPOINT_BYTES = 5 * 1024 * 1024;
const FULL_SNAPSHOT_INTERVAL = 10;
class CheckpointStore {
    constructor(root) {
        this.root = path.resolve(root);
        this.keepsafeDir = path.join(this.root, ".keepsafe");
        this.checkpointsDir = path.join(this.keepsafeDir, "checkpoints");
        this.blobsDir = path.join(this.keepsafeDir, "blobs");
        this.indexPath = path.join(this.keepsafeDir, "ts-index.json");
        this.fileStatePath = path.join(this.keepsafeDir, "ts-file-state.json");
        fs.mkdirSync(this.checkpointsDir, { recursive: true });
        fs.mkdirSync(this.blobsDir, { recursive: true });
        this.migrateIfNeeded();
    }
    createCheckpoint(name) {
        const index = this.loadIndex();
        const sequence = index.checkpoints.length + 1;
        const checkpointId = `${String(sequence).padStart(4, "0")}-${slugify(name)}`;
        const checkpointDir = path.join(this.checkpointsDir, checkpointId);
        fs.mkdirSync(checkpointDir, { recursive: true });
        const createdAt = utcNow();
        const isFullSnapshot = sequence === 1 || sequence % FULL_SNAPSHOT_INTERVAL === 0;
        const latest = index.checkpoints.at(-1) ?? null;
        const baseCheckpointId = latest?.checkpoint_id ?? null;
        const prevFileState = this.loadFileState();
        const currentFiles = (0, scanner_1.scanTextFiles)(this.root);
        const currentMap = new Map(currentFiles.map((f) => [f.relativePath, f]));
        const entriesLines = [];
        const manifestLines = [
            `Checkpoint: ${checkpointId}`,
            `Name: ${name}`,
            `Created: ${createdAt}`,
            `Mode: ${isFullSnapshot ? "snapshot" : "delta"}`,
            ...(baseCheckpointId ? [`Base: ${baseCheckpointId}`] : []),
            "",
        ];
        let addedCount = 0;
        let modifiedCount = 0;
        let deletedCount = 0;
        let inlineBudget = MAX_INLINE_CHECKPOINT_BYTES;
        const newFileState = new Map(prevFileState);
        if (isFullSnapshot) {
            newFileState.clear();
            for (const [relativePath, file] of currentMap) {
                const blobId = this.storeBlob(file.absolutePath, file.contentHash);
                let inlineText;
                if (file.size <= MAX_INLINE_NEW_FILE_BYTES && inlineBudget >= file.size) {
                    try {
                        inlineText = fs.readFileSync(file.absolutePath, "utf-8");
                        inlineBudget -= file.size;
                    }
                    catch { /**/ }
                }
                const entry = { op: "add", path: relativePath, blob_id: blobId, content_hash: file.contentHash, size: file.size };
                if (inlineText !== undefined)
                    entry.text = inlineText;
                entriesLines.push(stableJson(entry));
                appendManifestEntry(manifestLines, entry);
                newFileState.set(relativePath, { blob_id: blobId, content_hash: file.contentHash, size: file.size, checkpoint_id: checkpointId });
                addedCount++;
            }
        }
        else {
            // Added and modified
            for (const [relativePath, file] of currentMap) {
                const previous = prevFileState.get(relativePath);
                if (previous && previous.content_hash === file.contentHash) {
                    continue; // unchanged
                }
                const isNew = previous === undefined;
                const blobId = this.storeBlob(file.absolutePath, file.contentHash);
                let inlineText;
                if (isNew && file.size <= MAX_INLINE_NEW_FILE_BYTES && inlineBudget >= file.size) {
                    try {
                        inlineText = fs.readFileSync(file.absolutePath, "utf-8");
                        inlineBudget -= file.size;
                    }
                    catch { /**/ }
                }
                const op = isNew ? "add" : "modify";
                const entry = { op, path: relativePath, blob_id: blobId, content_hash: file.contentHash, size: file.size };
                if (inlineText !== undefined)
                    entry.text = inlineText;
                entriesLines.push(stableJson(entry));
                appendManifestEntry(manifestLines, entry);
                newFileState.set(relativePath, { blob_id: blobId, content_hash: file.contentHash, size: file.size, checkpoint_id: checkpointId });
                isNew ? addedCount++ : modifiedCount++;
            }
            // Deleted
            for (const [relativePath] of prevFileState) {
                if (!currentMap.has(relativePath)) {
                    const entry = { op: "delete", path: relativePath };
                    entriesLines.push(stableJson(entry));
                    appendManifestEntry(manifestLines, entry);
                    newFileState.delete(relativePath);
                    deletedCount++;
                }
            }
        }
        const entriesPath = path.join(checkpointDir, "entries.jsonl");
        const manifestTxtPath = path.join(checkpointDir, "checkpoint.txt");
        const manifestJsonPath = path.join(checkpointDir, "manifest.json");
        fs.writeFileSync(entriesPath, entriesLines.join("\n") + (entriesLines.length > 0 ? "\n" : ""), "utf-8");
        fs.writeFileSync(manifestTxtPath, manifestLines.join("\n") + "\n", "utf-8");
        const trackedCount = newFileState.size;
        const changedCount = addedCount + modifiedCount + deletedCount;
        const kind = isFullSnapshot ? "snapshot" : "delta";
        fs.writeFileSync(manifestJsonPath, JSON.stringify({
            checkpoint_id: checkpointId, sequence, name, created_at: createdAt, kind,
            file_count: trackedCount, changed_count: changedCount, base_checkpoint_id: baseCheckpointId,
            path: `.keepsafe/checkpoints/${checkpointId}`,
        }, null, 2) + "\n", "utf-8");
        const indexEntry = {
            checkpoint_id: checkpointId, sequence, name, created_at: createdAt, kind,
            file_count: trackedCount, changed_count: changedCount, base_checkpoint_id: baseCheckpointId,
        };
        index.checkpoints.push(indexEntry);
        this.saveIndex(index);
        this.saveFileState(newFileState);
        const summary = `Created ${kind} checkpoint ${checkpointId} (${trackedCount} tracked files, ${changedCount} changes)`;
        return { summary, path: checkpointDir };
    }
    listCheckpoints() {
        return this.loadIndex().checkpoints.map((e) => ({
            ...e,
            path: `.keepsafe/checkpoints/${e.checkpoint_id}`,
        }));
    }
    restoreCheckpoint(checkpointId) {
        const targetFiles = this.materializeCheckpoint(checkpointId);
        const currentTracked = new Set(this.loadFileState().keys());
        for (const tracked of currentTracked) {
            if (!targetFiles.has(tracked)) {
                const fullPath = path.join(this.root, tracked);
                try {
                    fs.rmSync(fullPath, { force: true });
                }
                catch { /**/ }
            }
        }
        for (const [relativePath, blobId] of targetFiles) {
            const destination = path.join(this.root, relativePath);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, this.readBlob(blobId));
        }
    }
    compareCheckpoints(leftId, rightId) {
        const left = this.materializeCheckpoint(leftId);
        const right = this.materializeCheckpoint(rightId);
        const leftPaths = new Set(left.keys());
        const rightPaths = new Set(right.keys());
        const added = [...rightPaths].filter((p) => !leftPaths.has(p)).sort();
        const deleted = [...leftPaths].filter((p) => !rightPaths.has(p)).sort();
        const modified = [...leftPaths]
            .filter((p) => rightPaths.has(p) && left.get(p) !== right.get(p))
            .sort();
        const lines = [
            `Compare: ${leftId} -> ${rightId}`,
            `Added: ${added.length}`,
            `Deleted: ${deleted.length}`,
            `Modified: ${modified.length}`,
            "",
        ];
        for (const p of added)
            lines.push(`A ${p}`);
        for (const p of deleted)
            lines.push(`D ${p}`);
        for (const p of modified) {
            lines.push(`M ${p}`);
            try {
                const leftText = this.readBlob(left.get(p)).toString("utf-8");
                const rightText = this.readBlob(right.get(p)).toString("utf-8");
                const diff = unifiedDiff(leftText, rightText, `a/${p}`, `b/${p}`);
                if (diff)
                    lines.push(diff);
            }
            catch { /**/ }
            lines.push("");
        }
        return lines.join("\n").trimEnd() + "\n";
    }
    addGitignoreEntry(pattern, directory = false) {
        let normalized = pattern.trim();
        if (!normalized)
            throw new Error("Ignore pattern cannot be empty");
        if (directory && !normalized.endsWith("/"))
            normalized += "/";
        const gitignorePath = path.join(this.root, ".gitignore");
        let lines = [];
        if (fs.existsSync(gitignorePath)) {
            lines = fs.readFileSync(gitignorePath, "utf-8").split("\n");
        }
        if (lines.some((l) => l.trim() === normalized)) {
            return `Pattern already exists in ${gitignorePath}`;
        }
        if (lines.length > 0 && lines.at(-1).trim())
            lines.push("");
        lines.push(normalized);
        fs.writeFileSync(gitignorePath, lines.join("\n").trimEnd() + "\n", "utf-8");
        return `Added ignore pattern '${normalized}' to ${gitignorePath}`;
    }
    rebuild() {
        let checkpointDirs;
        try {
            checkpointDirs = fs.readdirSync(this.checkpointsDir)
                .filter((n) => fs.statSync(path.join(this.checkpointsDir, n)).isDirectory())
                .sort();
        }
        catch {
            return "No checkpoints directory found.";
        }
        const newIndex = { checkpoints: [] };
        const newFileState = new Map();
        for (let i = 0; i < checkpointDirs.length; i++) {
            const checkpointId = checkpointDirs[i];
            const checkpointDir = path.join(this.checkpointsDir, checkpointId);
            const entriesPath = path.join(checkpointDir, "entries.jsonl");
            if (!fs.existsSync(entriesPath))
                continue;
            const manifestPath = path.join(checkpointDir, "manifest.json");
            let manifest = {};
            if (fs.existsSync(manifestPath)) {
                try {
                    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
                }
                catch { /**/ }
            }
            const sequence = i + 1;
            const name = manifest["name"] ?? checkpointId;
            const created_at = manifest["created_at"] ?? utcNow();
            const kind = (manifest["kind"] ?? (sequence === 1 ? "snapshot" : "delta"));
            const base_checkpoint_id = i === 0 ? null : checkpointDirs[i - 1];
            let changedCount = 0;
            const rawLines = fs.readFileSync(entriesPath, "utf-8").split("\n");
            for (const line of rawLines) {
                const t = line.trim();
                if (!t)
                    continue;
                changedCount++;
                const entry = JSON.parse(t);
                if (entry.op === "add" || entry.op === "modify") {
                    newFileState.set(entry.path, {
                        blob_id: entry.blob_id, content_hash: entry.content_hash,
                        size: entry.size, checkpoint_id: checkpointId,
                    });
                }
                else if (entry.op === "delete") {
                    newFileState.delete(entry.path);
                }
            }
            newIndex.checkpoints.push({
                checkpoint_id: checkpointId, sequence, name, created_at, kind,
                file_count: newFileState.size, changed_count: changedCount, base_checkpoint_id,
            });
        }
        this.saveIndex(newIndex);
        this.saveFileState(newFileState);
        return `Rebuilt KeepSafe metadata from checkpoint logs (${newIndex.checkpoints.length} checkpoints indexed)`;
    }
    // --- private helpers ---
    materializeCheckpoint(checkpointId) {
        const index = this.loadIndex();
        const targetIdx = index.checkpoints.findIndex((c) => c.checkpoint_id === checkpointId);
        if (targetIdx === -1)
            throw new Error(`Checkpoint '${checkpointId}' does not exist`);
        let snapshotIdx = -1;
        for (let i = targetIdx; i >= 0; i--) {
            if (index.checkpoints[i].kind === "snapshot") {
                snapshotIdx = i;
                break;
            }
        }
        if (snapshotIdx === -1)
            throw new Error(`No snapshot found for checkpoint '${checkpointId}'`);
        const result = new Map();
        for (let i = snapshotIdx; i <= targetIdx; i++) {
            const cp = index.checkpoints[i];
            const entriesPath = path.join(this.checkpointsDir, cp.checkpoint_id, "entries.jsonl");
            if (!fs.existsSync(entriesPath))
                continue;
            for (const line of fs.readFileSync(entriesPath, "utf-8").split("\n")) {
                const t = line.trim();
                if (!t)
                    continue;
                const entry = JSON.parse(t);
                if (entry.op === "add" || entry.op === "modify")
                    result.set(entry.path, entry.blob_id);
                else if (entry.op === "delete")
                    result.delete(entry.path);
            }
        }
        return result;
    }
    storeBlob(filePath, contentHash) {
        const blobId = contentHash;
        const blobPath = this.blobFilePath(blobId);
        if (!fs.existsSync(blobPath)) {
            fs.mkdirSync(path.dirname(blobPath), { recursive: true });
            const raw = fs.readFileSync(filePath);
            fs.writeFileSync(blobPath, zlib.deflateSync(raw, { level: 6 }));
        }
        return blobId;
    }
    readBlob(blobId) {
        return zlib.inflateSync(fs.readFileSync(this.blobFilePath(blobId)));
    }
    blobFilePath(blobId) {
        return path.join(this.blobsDir, blobId.slice(0, 2), `${blobId.slice(2)}.blob`);
    }
    loadIndex() {
        if (!fs.existsSync(this.indexPath))
            return { checkpoints: [] };
        try {
            return JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
        }
        catch {
            return { checkpoints: [] };
        }
    }
    saveIndex(index) {
        fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
    }
    loadFileState() {
        if (!fs.existsSync(this.fileStatePath))
            return new Map();
        try {
            const raw = JSON.parse(fs.readFileSync(this.fileStatePath, "utf-8"));
            return new Map(Object.entries(raw));
        }
        catch {
            return new Map();
        }
    }
    saveFileState(state) {
        const obj = Object.fromEntries(state);
        fs.writeFileSync(this.fileStatePath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
    }
    /**
     * If checkpoint directories exist but no ts-index.json, auto-rebuild so
     * users with existing Python-created checkpoints get them indexed.
     */
    migrateIfNeeded() {
        if (fs.existsSync(this.indexPath))
            return;
        try {
            const dirs = fs.readdirSync(this.checkpointsDir);
            if (dirs.length > 0)
                this.rebuild();
        }
        catch { /**/ }
    }
}
exports.CheckpointStore = CheckpointStore;
// --- utilities ---
function slugify(name) {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "checkpoint";
}
function utcNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function stableJson(obj) {
    const sorted = Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
    return JSON.stringify(sorted);
}
function appendManifestEntry(lines, entry) {
    if (entry.op === "add") {
        lines.push(`A ${entry.path}`);
        if (entry.text !== undefined) {
            lines.push(`--- ${entry.path} ---`);
            lines.push(entry.text.endsWith("\n") ? entry.text.slice(0, -1) : entry.text);
        }
        else {
            lines.push(`[blob ${entry.blob_id} size=${entry.size}]`);
        }
        lines.push("");
    }
    else if (entry.op === "modify") {
        lines.push(`M ${entry.path} [blob ${entry.blob_id} size=${entry.size}]`);
        lines.push("");
    }
    else if (entry.op === "delete") {
        lines.push(`D ${entry.path}`);
        lines.push("");
    }
}
function unifiedDiff(leftText, rightText, fromFile, toFile) {
    const leftLines = leftText.split("\n");
    const rightLines = rightText.split("\n");
    if (leftText === rightText)
        return "";
    const diffLines = [`--- ${fromFile}`, `+++ ${toFile}`];
    // Simple line-by-line diff (not optimal but correct for display)
    const leftSet = new Set(leftLines.map((l, i) => `${i}:${l}`));
    const rightSet = new Set(rightLines.map((l, i) => `${i}:${l}`));
    let i = 0;
    let j = 0;
    while (i < leftLines.length || j < rightLines.length) {
        if (i < leftLines.length && j < rightLines.length && leftLines[i] === rightLines[j]) {
            diffLines.push(` ${leftLines[i]}`);
            i++;
            j++;
        }
        else if (j < rightLines.length && (i >= leftLines.length || leftLines[i] !== rightLines[j])) {
            diffLines.push(`+${rightLines[j]}`);
            j++;
        }
        else {
            diffLines.push(`-${leftLines[i]}`);
            i++;
        }
    }
    return diffLines.join("\n");
}
// suppress unused import warning
void crypto;
//# sourceMappingURL=store.js.map