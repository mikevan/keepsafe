# KeepSafe

AI just destroyed six weeks of work. It says everything is fine.

Meet KeepSafe.

KeepSafe creates fast, local checkpoints for AI-assisted development, giving you an immediate rollback point before your coding agent starts “improving” things.

Create a checkpoint. Let the AI work. If it breaks your code, restore the project in seconds.

KeepSafe lives inside your project and works hand-in-hand with Git. It does not replace source control. It gives you a much faster recovery layer for the kind of mistakes AI coding tools make every day.

Git protects your project history. KeepSafe protects you from the last prompt.

IMPORTANT: Add ".keepsafe" to your .gitignore profile so you don't accidentally upload it to your repository.

Keepsafe is written so it will just work in VSCode. You won't need to install any other language packs like python or java.

## Why KeepSafe?

AI coding tools are fast but imprecise. They can quietly break working code across many files, and a single `Ctrl+Z` won't save you. KeepSafe gives you named, timestamped snapshots of your entire workspace that you can restore in seconds.

**Before you let an AI rewrite your auth module** → Quick Checkpoint  
**After it breaks three unrelated files** → Restore Latest Checkpoint

## Getting Started

1. Open the KeepSafe panel from the activity bar (shield icon on the left)
2. Click **Quick Checkpoint** before any risky AI-assisted change
3. If something goes wrong, click **Restore Latest Checkpoint**

That's it. No accounts, no cloud sync, no Python install required.

## Commands

All commands are available from the KeepSafe panel or via `Ctrl+Shift+P`:

| Command | What it does |
|---|---|
| **Quick Checkpoint** | Snapshots the workspace instantly, named by timestamp (`quick-20260813-143022`) |
| **Create Checkpoint** | Prompts for a name so you can label meaningful states (`before-auth-refactor`) |
| **List Checkpoints** | Shows all checkpoints with names and timestamps |
| **Restore Latest** | Rolls back to the most recent checkpoint after a confirmation prompt |
| **Restore Checkpoint** | Lets you pick any checkpoint from history to restore |
| **Diff Checkpoints** | Shows what changed between two checkpoints in the Output panel |
| **Add Ignore Pattern** | Adds a `.gitignore` entry to exclude files from checkpointing |
| **Rebuild Metadata** | Rebuilds the checkpoint index if it gets out of sync |

## Example Workflow

```
# Starting a session with an AI assistant
→ Quick Checkpoint          # "quick-20260813-090012"

# AI refactors your API layer
→ Quick Checkpoint          # "quick-20260813-091530"

# AI rewrites your database module and breaks everything
→ Restore Latest Checkpoint # back to "quick-20260813-091530"

# Compare what changed between two points
→ Diff Checkpoints          # pick any two from history
```

## How It Works

KeepSafe stores checkpoints locally in a `.keepsafe/` folder at your workspace root:

- **Snapshots** are taken every 10 checkpoints — full copies of all tracked files
- **Deltas** record only what changed between snapshots, keeping the store compact
- **Blobs** are content-addressed and compressed, so identical files are stored once
- Files matching `.gitignore` rules and common build artifacts (`node_modules`, `dist`, `__pycache__`, etc.) are automatically excluded

## Keeping Checkpoints Out of Git

KeepSafe stores everything in a `.keepsafe/` folder at your workspace root. Add this to your `.gitignore` to keep checkpoint data local:

```
# KeepSafe local checkpoint store
.keepsafe/
```

An `example.gitignore` with this entry is included in the extension's media folder for reference.

## Development

```bash
npm install
npm run compile
# Press F5 in VS Code to launch the Extension Development Host
```

