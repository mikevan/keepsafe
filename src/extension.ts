import * as vscode from "vscode";
import { CheckpointRecord, CheckpointStore } from "./store";

// ---------------------------------------------------------------------------
// Tree view data
// ---------------------------------------------------------------------------

type KeepSafeCommandNode = {
  label: string;
  description: string;
  commandId: string;
  icon: string;
};

type KeepSafeCommandSection = {
  label: string;
  description: string;
  icon: string;
  children: KeepSafeCommandNode[];
};

const commandSections: KeepSafeCommandSection[] = [
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

const commandPairs: Array<[string, (...args: unknown[]) => unknown]> = [
  ["keepsafe.quickCheckpoint", quickCheckpoint],
  ["keepsafe.restoreLatestCheckpoint", restoreLatestCheckpoint],
  ["keepsafe.createCheckpoint", createCheckpoint],
  ["keepsafe.listCheckpoints", listCheckpoints],
  ["keepsafe.restoreCheckpoint", restoreCheckpoint],
  ["keepsafe.diffCheckpoints", diffCheckpoints],
  ["keepsafe.rebuild", rebuildMetadata],
  ["keepsafe.ignoreAdd", addIgnorePattern],
];

export function activate(context: vscode.ExtensionContext): void {
  for (const [commandId, handler] of commandPairs) {
    context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("keepsafe.openCommandCenter", () => {
      void vscode.commands.executeCommand("workbench.view.extension.keepsafeView");
    })
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("keepsafe.commandLauncher", new KeepSafeCommandTreeProvider())
  );
  context.subscriptions.push(output);
}

export function deactivate(): void {
  output.dispose();
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function createCheckpoint(): Promise<void> {
  const root = getWorkspaceRootOrThrow();
  const name = await vscode.window.showInputBox({
    title: "KeepSafe Checkpoint Name",
    prompt: "Enter checkpoint name",
    placeHolder: "Initial checkpoint",
    validateInput: (value) => (value.trim() ? null : "Checkpoint name is required"),
  });
  if (!name) return;

  await runStoreOp(root, (store) => {
    const result = store.createCheckpoint(name);
    output.appendLine(result.summary);
    vscode.window.showInformationMessage(result.summary);
  });
}

async function quickCheckpoint(): Promise<void> {
  const root = getWorkspaceRootOrThrow();
  const now = new Date();
  const stamp =
    String(now.getFullYear()).padStart(4, "0") +
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

async function listCheckpoints(): Promise<void> {
  const root = getWorkspaceRootOrThrow();
  const store = new CheckpointStore(root);
  const checkpoints = store.listCheckpoints();
  if (!checkpoints.length) {
    vscode.window.showInformationMessage("No checkpoints found.");
    return;
  }
  await vscode.window.showQuickPick(
    checkpoints.map((cp) => ({ label: cp.checkpoint_id, description: cp.name, detail: cp.created_at })),
    { title: "KeepSafe Checkpoints", canPickMany: false, placeHolder: "Checkpoint list" }
  );
}

async function restoreCheckpoint(): Promise<void> {
  const root = getWorkspaceRootOrThrow();
  const checkpoint = await pickCheckpoint(root, "Select checkpoint to restore");
  if (!checkpoint) return;

  const answer = await vscode.window.showWarningMessage(
    `Restore checkpoint ${checkpoint.checkpoint_id}? This will overwrite tracked files in the workspace.`,
    { modal: true },
    "Restore"
  );
  if (answer !== "Restore") return;

  await runStoreOp(root, (store) => {
    store.restoreCheckpoint(checkpoint.checkpoint_id);
    output.appendLine(`Restored ${checkpoint.checkpoint_id}`);
    vscode.window.showInformationMessage(`Restored ${checkpoint.checkpoint_id}`);
  });
}

async function restoreLatestCheckpoint(): Promise<void> {
  const root = getWorkspaceRootOrThrow();
  const store = new CheckpointStore(root);
  const checkpoints = store.listCheckpoints();
  if (!checkpoints.length) {
    vscode.window.showInformationMessage("No checkpoints found.");
    return;
  }
  const latest = checkpoints[checkpoints.length - 1];

  const answer = await vscode.window.showWarningMessage(
    `Restore latest checkpoint ${latest.checkpoint_id}? This will overwrite tracked files in the workspace.`,
    { modal: true },
    "Restore"
  );
  if (answer !== "Restore") return;

  await runStoreOp(root, (store) => {
    store.restoreCheckpoint(latest.checkpoint_id);
    output.appendLine(`Restored latest checkpoint ${latest.checkpoint_id}`);
    vscode.window.showInformationMessage(`Restored latest checkpoint ${latest.checkpoint_id}`);
  });
}

async function diffCheckpoints(): Promise<void> {
  const root = getWorkspaceRootOrThrow();
  const left = await pickCheckpoint(root, "Select older checkpoint");
  if (!left) return;
  const right = await pickCheckpoint(root, "Select newer checkpoint");
  if (!right) return;

  await runStoreOp(root, (store) => {
    const diff = store.compareCheckpoints(left.checkpoint_id, right.checkpoint_id);
    output.appendLine(diff);
    output.show(true);
  });
}

async function rebuildMetadata(): Promise<void> {
  const root = getWorkspaceRootOrThrow();
  await runStoreOp(root, (store) => {
    const msg = store.rebuild();
    output.appendLine(msg);
    vscode.window.showInformationMessage(msg);
  });
}

async function addIgnorePattern(): Promise<void> {
  const root = getWorkspaceRootOrThrow();
  const pattern = await vscode.window.showInputBox({
    title: "KeepSafe Ignore Pattern",
    prompt: "Enter a .gitignore pattern to add",
    placeHolder: "logs/*.log or ./build",
    validateInput: (value) => (value.trim() ? null : "Pattern is required"),
  });
  if (!pattern) return;

  const asDirectory = await vscode.window.showQuickPick(
    [{ label: "No", value: false }, { label: "Yes", value: true }],
    { title: "Treat as directory pattern?", placeHolder: "Adds trailing slash when yes" }
  );
  if (!asDirectory) return;

  await runStoreOp(root, (store) => {
    const msg = store.addGitignoreEntry(pattern, asDirectory.value);
    output.appendLine(msg);
    vscode.window.showInformationMessage(msg);
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function runStoreOp(root: string, op: (store: CheckpointStore) => void): Promise<void> {
  try {
    const store = new CheckpointStore(root);
    op(store);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(`Error: ${msg}`);
    vscode.window.showErrorMessage(`KeepSafe: ${msg}`);
  }
}

async function pickCheckpoint(root: string, title: string): Promise<CheckpointRecord | undefined> {
  const store = new CheckpointStore(root);
  const checkpoints = store.listCheckpoints();
  if (!checkpoints.length) {
    vscode.window.showInformationMessage("No checkpoints found.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    checkpoints.map((cp) => ({ label: cp.checkpoint_id, description: cp.name, detail: cp.created_at, checkpoint: cp })),
    { title, canPickMany: false }
  );
  return pick?.checkpoint;
}

function getWorkspaceRootOrThrow(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error("Open a workspace folder first.");
  return root;
}

// ---------------------------------------------------------------------------
// Tree view
// ---------------------------------------------------------------------------

class KeepSafeCommandTreeProvider implements vscode.TreeDataProvider<KeepSafeCommandTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<KeepSafeCommandTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  getTreeItem(element: KeepSafeCommandTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: KeepSafeCommandTreeItem): KeepSafeCommandTreeItem[] {
    if (element?.kind === "section") {
      return commandSections
        .find((s) => s.label === element.label)
        ?.children.map((n) => new KeepSafeCommandTreeItem("command", n.label, n.description, n.commandId, n.icon)) ?? [];
    }
    return commandSections.map(
      (s) => new KeepSafeCommandTreeItem("section", s.label, s.description, undefined, s.icon)
    );
  }
}

class KeepSafeCommandTreeItem extends vscode.TreeItem {
  readonly kind: "section" | "command";

  constructor(
    kind: "section" | "command",
    label: string,
    description: string,
    commandId: string | undefined,
    icon: string
  ) {
    super(label, kind === "section" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.kind = kind;
    this.description = description;
    if (commandId) {
      this.command = { command: commandId, title: label, arguments: [] };
    }
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}
