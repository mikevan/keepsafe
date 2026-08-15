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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const store_1 = require("./store");
const commandSections = [
    {
        label: "Quick Actions",
        description: "Fast checkpointing entry points",
        icon: "zap",
        children: [
            { label: "Quick Checkpoint", description: "Create an immediate checkpoint", commandId: "keepsafe.quickCheckpoint", icon: "flash" },
            { label: "Create Checkpoint", description: "Name a checkpoint manually", commandId: "keepsafe.createCheckpoint", icon: "save" },
            { label: "List Checkpoints", description: "Browse checkpoint history", commandId: "keepsafe.listCheckpoints", icon: "list-unordered" },
        ],
    },
    {
        label: "Recovery",
        description: "Restore or compare states",
        icon: "history",
        children: [
            { label: "Restore Latest", description: "Restore the newest checkpoint", commandId: "keepsafe.restoreLatestCheckpoint", icon: "history" },
            { label: "Restore Checkpoint", description: "Pick a checkpoint to restore", commandId: "keepsafe.restoreCheckpoint", icon: "debug-restart" },
            { label: "Diff Checkpoints", description: "Compare two checkpoints", commandId: "keepsafe.diffCheckpoints", icon: "compare-changes" },
        ],
    },
    {
        label: "Maintenance",
        description: "Store upkeep tools",
        icon: "database",
        children: [
            { label: "Rebuild Metadata", description: "Reindex the KeepSafe store", commandId: "keepsafe.rebuild", icon: "database" },
            { label: "Add Ignore Pattern", description: "Add a .gitignore entry", commandId: "keepsafe.ignoreAdd", icon: "eye-closed" },
        ],
    },
];
// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------
const output = vscode.window.createOutputChannel("KeepSafe");
const commandPairs = [
    ["keepsafe.quickCheckpoint", quickCheckpoint],
    ["keepsafe.restoreLatestCheckpoint", restoreLatestCheckpoint],
    ["keepsafe.createCheckpoint", createCheckpoint],
    ["keepsafe.listCheckpoints", listCheckpoints],
    ["keepsafe.restoreCheckpoint", restoreCheckpoint],
    ["keepsafe.diffCheckpoints", diffCheckpoints],
    ["keepsafe.rebuild", rebuildMetadata],
    ["keepsafe.ignoreAdd", addIgnorePattern],
];
function activate(context) {
    for (const [commandId, handler] of commandPairs) {
        context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
    }
    context.subscriptions.push(vscode.commands.registerCommand("keepsafe.openCommandCenter", () => {
        void vscode.commands.executeCommand("workbench.view.extension.keepsafeView");
    }));
    context.subscriptions.push(vscode.window.registerTreeDataProvider("keepsafe.commandLauncher", new KeepSafeCommandTreeProvider()));
    context.subscriptions.push(output);
}
function deactivate() {
    output.dispose();
}
// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
async function createCheckpoint() {
    const root = getWorkspaceRootOrThrow();
    const name = await vscode.window.showInputBox({
        title: "KeepSafe Checkpoint Name",
        prompt: "Enter checkpoint name",
        placeHolder: "Initial checkpoint",
        validateInput: (value) => (value.trim() ? null : "Checkpoint name is required"),
    });
    if (!name)
        return;
    await runStoreOp(root, (store) => {
        const result = store.createCheckpoint(name);
        output.appendLine(result.summary);
        vscode.window.showInformationMessage(result.summary);
    });
}
async function quickCheckpoint() {
    const root = getWorkspaceRootOrThrow();
    const now = new Date();
    const stamp = String(now.getFullYear()).padStart(4, "0") +
        String(now.getMonth() + 1).padStart(2, "0") +
        String(now.getDate()).padStart(2, "0") +
        "-" +
        String(now.getHours()).padStart(2, "0") +
        String(now.getMinutes()).padStart(2, "0") +
        String(now.getSeconds()).padStart(2, "0");
    await runStoreOp(root, (store) => {
        const result = store.createCheckpoint(`quick-${stamp}`);
        output.appendLine(result.summary);
        vscode.window.showInformationMessage(result.summary);
    });
}
async function listCheckpoints() {
    const root = getWorkspaceRootOrThrow();
    const store = new store_1.CheckpointStore(root);
    const checkpoints = store.listCheckpoints();
    if (!checkpoints.length) {
        vscode.window.showInformationMessage("No checkpoints found.");
        return;
    }
    await vscode.window.showQuickPick(checkpoints.map((cp) => ({ label: cp.checkpoint_id, description: cp.name, detail: cp.created_at })), { title: "KeepSafe Checkpoints", canPickMany: false, placeHolder: "Checkpoint list" });
}
async function restoreCheckpoint() {
    const root = getWorkspaceRootOrThrow();
    const checkpoint = await pickCheckpoint(root, "Select checkpoint to restore");
    if (!checkpoint)
        return;
    const answer = await vscode.window.showWarningMessage(`Restore checkpoint ${checkpoint.checkpoint_id}? This will overwrite tracked files in the workspace.`, { modal: true }, "Restore");
    if (answer !== "Restore")
        return;
    await runStoreOp(root, (store) => {
        store.restoreCheckpoint(checkpoint.checkpoint_id);
        output.appendLine(`Restored ${checkpoint.checkpoint_id}`);
        vscode.window.showInformationMessage(`Restored ${checkpoint.checkpoint_id}`);
    });
}
async function restoreLatestCheckpoint() {
    const root = getWorkspaceRootOrThrow();
    const store = new store_1.CheckpointStore(root);
    const checkpoints = store.listCheckpoints();
    if (!checkpoints.length) {
        vscode.window.showInformationMessage("No checkpoints found.");
        return;
    }
    const latest = checkpoints[checkpoints.length - 1];
    const answer = await vscode.window.showWarningMessage(`Restore latest checkpoint ${latest.checkpoint_id}? This will overwrite tracked files in the workspace.`, { modal: true }, "Restore");
    if (answer !== "Restore")
        return;
    await runStoreOp(root, (store) => {
        store.restoreCheckpoint(latest.checkpoint_id);
        output.appendLine(`Restored latest checkpoint ${latest.checkpoint_id}`);
        vscode.window.showInformationMessage(`Restored latest checkpoint ${latest.checkpoint_id}`);
    });
}
async function diffCheckpoints() {
    const root = getWorkspaceRootOrThrow();
    const left = await pickCheckpoint(root, "Select older checkpoint");
    if (!left)
        return;
    const right = await pickCheckpoint(root, "Select newer checkpoint");
    if (!right)
        return;
    await runStoreOp(root, (store) => {
        const diff = store.compareCheckpoints(left.checkpoint_id, right.checkpoint_id);
        output.appendLine(diff);
        output.show(true);
    });
}
async function rebuildMetadata() {
    const root = getWorkspaceRootOrThrow();
    await runStoreOp(root, (store) => {
        const msg = store.rebuild();
        output.appendLine(msg);
        vscode.window.showInformationMessage(msg);
    });
}
async function addIgnorePattern() {
    const root = getWorkspaceRootOrThrow();
    const pattern = await vscode.window.showInputBox({
        title: "KeepSafe Ignore Pattern",
        prompt: "Enter a .gitignore pattern to add",
        placeHolder: "logs/*.log or ./build",
        validateInput: (value) => (value.trim() ? null : "Pattern is required"),
    });
    if (!pattern)
        return;
    const asDirectory = await vscode.window.showQuickPick([{ label: "No", value: false }, { label: "Yes", value: true }], { title: "Treat as directory pattern?", placeHolder: "Adds trailing slash when yes" });
    if (!asDirectory)
        return;
    await runStoreOp(root, (store) => {
        const msg = store.addGitignoreEntry(pattern, asDirectory.value);
        output.appendLine(msg);
        vscode.window.showInformationMessage(msg);
    });
}
// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
async function runStoreOp(root, op) {
    try {
        const store = new store_1.CheckpointStore(root);
        op(store);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`Error: ${msg}`);
        vscode.window.showErrorMessage(`KeepSafe: ${msg}`);
    }
}
async function pickCheckpoint(root, title) {
    const store = new store_1.CheckpointStore(root);
    const checkpoints = store.listCheckpoints();
    if (!checkpoints.length) {
        vscode.window.showInformationMessage("No checkpoints found.");
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(checkpoints.map((cp) => ({ label: cp.checkpoint_id, description: cp.name, detail: cp.created_at, checkpoint: cp })), { title, canPickMany: false });
    return pick?.checkpoint;
}
function getWorkspaceRootOrThrow() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root)
        throw new Error("Open a workspace folder first.");
    return root;
}
// ---------------------------------------------------------------------------
// Tree view
// ---------------------------------------------------------------------------
class KeepSafeCommandTreeProvider {
    constructor() {
        this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (element?.kind === "section") {
            return commandSections
                .find((s) => s.label === element.label)
                ?.children.map((n) => new KeepSafeCommandTreeItem("command", n.label, n.description, n.commandId, n.icon)) ?? [];
        }
        return commandSections.map((s) => new KeepSafeCommandTreeItem("section", s.label, s.description, undefined, s.icon));
    }
}
class KeepSafeCommandTreeItem extends vscode.TreeItem {
    constructor(kind, label, description, commandId, icon) {
        super(label, kind === "section" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.kind = kind;
        this.description = description;
        if (commandId) {
            this.command = { command: commandId, title: label, arguments: [] };
        }
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}
//# sourceMappingURL=extension.js.map