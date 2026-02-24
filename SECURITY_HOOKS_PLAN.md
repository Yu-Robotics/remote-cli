# Security Hooks Implementation Plan

## Overview

This plan implements directory-based security restrictions using Claude Code's native Hooks mechanism. The goal is to ensure Claude Code can only access files within the configured working directory and its subdirectories.

## Key Insight: Reusing Existing Code

After analyzing the existing codebase, I found:

1. **ToolUseInfo already captures tool information** (`packages/cli/src/types/index.ts:4-8`):
   ```typescript
   export interface ToolUseInfo {
     name: string;      // Tool name: 'Edit', 'Write', 'Read', 'Bash', 'Glob', 'Grep'
     id: string;        // Tool call ID
     input: Record<string, any>;  // Parameters including file_path
   }
   ```

2. **ClaudePersistentExecutor already parses tool_use** (`packages/cli/src/executor/ClaudePersistentExecutor.ts:603-612`):
   - Detects `tool_use` blocks in Claude's output
   - Passes `ToolUseInfo` via callback

3. **MessageHandler forwards tool info** (`packages/cli/src/client/MessageHandler.ts:443-445`):
   - Receives `onToolUse` callback
   - Sends tool_use info to router via WebSocket

4. **ClaudeCodeHooks exists but is post-hoc** (`packages/cli/src/hooks/ClaudeCodeHooks.ts`):
   - `TOOL_BEFORE_EXECUTION` event exists
   - BUT: This fires AFTER Claude Code has already decided to execute
   - Cannot actually block execution

**Critical Problem**: The existing `tool_use` detection is notification-only. When we receive it, Claude Code has already committed to executing the tool. We cannot prevent execution from within our process.

## Solution: Claude Code Native Hooks

Claude Code supports hooks that run BEFORE tool execution via the `hooks` configuration. By using `PreToolUse` hooks that exit with code 2, we can block unauthorized operations.

### How Claude Code Hooks Work

1. Configure hooks in `~/.claude/settings.json` or project `.claude/settings.json`
2. Claude Code calls the hook script BEFORE executing each tool
3. Hook script receives tool info via environment variables or stdin
4. Exit code determines action:
   - `0` = Allow execution
   - `2` = Block execution (Claude sees "permission denied")
   - Other = Error

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        remote-cli client                             │
│                                                                      │
│  ┌──────────────┐    ┌─────────────────┐    ┌────────────────────┐  │
│  │ ConfigManager │───▶│ HooksConfigurator│───▶│ .claude/settings  │  │
│  │              │    │                 │    │ (PreToolUse hooks) │  │
│  │ workingDir   │    │ generateConfig()│    └────────────────────┘  │
│  │ allowedDirs  │    └─────────────────┘              │              │
│  └──────────────┘                                     │              │
│                                                       ▼              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Claude Code CLI                            │   │
│  │                                                               │   │
│  │   Tool Request ──▶ PreToolUse Hook ──▶ security-guard.js     │   │
│  │        │                                      │               │   │
│  │        │                                      ▼               │   │
│  │        │                              Check file_path         │   │
│  │        │                              against allowedDirs     │   │
│  │        │                                      │               │   │
│  │        │                    ┌────────┬────────┘               │   │
│  │        │                    │        │                        │   │
│  │        │              exit(0)   exit(2)                       │   │
│  │        │               Allow     Block                        │   │
│  │        ▼                    │        │                        │   │
│  │   Execute Tool ◀────────────┘        │                        │   │
│  │        │                             │                        │   │
│  │   tool_result                  "Blocked: path                 │   │
│  │                                 outside allowed dirs"         │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Security Guard Script

Create a standalone script that Claude Code will call as a PreToolUse hook.

**File**: `packages/cli/src/security/security-guard.js`

```javascript
#!/usr/bin/env node
/**
 * Claude Code PreToolUse Hook - Security Guard
 *
 * This script is called by Claude Code BEFORE executing any tool.
 * It validates that file operations are within allowed directories.
 *
 * Exit codes:
 *   0 = Allow execution
 *   2 = Block execution (permission denied)
 */

const path = require('path');
const fs = require('fs');

// Read hook input from stdin (Claude Code passes JSON)
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(input);
    const result = validateToolUse(hookData);
    if (!result.allowed) {
      console.error(`[SecurityGuard] Blocked: ${result.reason}`);
      process.exit(2);
    }
    process.exit(0);
  } catch (error) {
    console.error(`[SecurityGuard] Error: ${error.message}`);
    process.exit(0); // Allow on error to avoid blocking legitimate operations
  }
});

function validateToolUse(hookData) {
  const { tool_name, tool_input } = hookData;

  // Load allowed directories from config
  const configPath = process.env.REMOTE_CLI_CONFIG ||
    path.join(process.env.HOME, '.remote-cli', 'config.json');

  let allowedDirs = [];
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    allowedDirs = config.security?.allowedDirectories || [];
  } catch (e) {
    return { allowed: true, reason: 'No config found, allowing by default' };
  }

  if (allowedDirs.length === 0) {
    return { allowed: true, reason: 'No directory restrictions configured' };
  }

  // Tools that access files
  const fileTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'];

  if (!fileTools.includes(tool_name)) {
    // Non-file tools (Bash, Task, etc.) - allow for now
    // TODO: Add Bash command filtering in Phase 2
    return { allowed: true, reason: 'Non-file tool' };
  }

  // Extract file path from tool input
  const filePath = tool_input.file_path || tool_input.path || tool_input.notebook_path;

  if (!filePath) {
    return { allowed: true, reason: 'No file path in tool input' };
  }

  // Resolve to absolute path
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(process.cwd(), filePath);

  // Check if path is within any allowed directory
  for (const allowedDir of allowedDirs) {
    const resolvedAllowed = allowedDir.startsWith('~')
      ? path.join(process.env.HOME, allowedDir.slice(1))
      : path.resolve(allowedDir);

    if (absolutePath.startsWith(resolvedAllowed + path.sep) || absolutePath === resolvedAllowed) {
      return { allowed: true, reason: `Path within allowed dir: ${allowedDir}` };
    }
  }

  return {
    allowed: false,
    reason: `Path "${filePath}" is outside allowed directories: ${allowedDirs.join(', ')}`
  };
}
```

### Phase 2: Hooks Configurator

Create a module that configures Claude Code's hooks settings.

**File**: `packages/cli/src/security/HooksConfigurator.ts`

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../config/ConfigManager';

export class HooksConfigurator {
  private configManager: ConfigManager;
  private claudeSettingsPath: string;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    this.claudeSettingsPath = path.join(
      process.env.HOME || '',
      '.claude',
      'settings.json'
    );
  }

  /**
   * Configure Claude Code hooks for security
   */
  async configure(): Promise<void> {
    const securityGuardPath = this.getSecurityGuardPath();

    // Ensure security guard script exists and is executable
    if (!fs.existsSync(securityGuardPath)) {
      throw new Error(`Security guard script not found at: ${securityGuardPath}`);
    }

    // Read existing Claude settings
    let claudeSettings: any = {};
    if (fs.existsSync(this.claudeSettingsPath)) {
      claudeSettings = JSON.parse(fs.readFileSync(this.claudeSettingsPath, 'utf8'));
    }

    // Add PreToolUse hook
    claudeSettings.hooks = claudeSettings.hooks || {};
    claudeSettings.hooks.PreToolUse = claudeSettings.hooks.PreToolUse || [];

    // Check if our hook is already configured
    const hookCommand = `node "${securityGuardPath}"`;
    const existingHook = claudeSettings.hooks.PreToolUse.find(
      (hook: any) => hook.command === hookCommand || hook === hookCommand
    );

    if (!existingHook) {
      claudeSettings.hooks.PreToolUse.push({
        command: hookCommand,
        // Only apply to file operation tools
        tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit']
      });
    }

    // Write back to settings
    fs.mkdirSync(path.dirname(this.claudeSettingsPath), { recursive: true });
    fs.writeFileSync(this.claudeSettingsPath, JSON.stringify(claudeSettings, null, 2));

    console.log('[HooksConfigurator] Claude Code hooks configured successfully');
  }

  /**
   * Remove our hooks from Claude settings
   */
  async unconfigure(): Promise<void> {
    if (!fs.existsSync(this.claudeSettingsPath)) {
      return;
    }

    const claudeSettings = JSON.parse(fs.readFileSync(this.claudeSettingsPath, 'utf8'));

    if (claudeSettings.hooks?.PreToolUse) {
      const securityGuardPath = this.getSecurityGuardPath();
      claudeSettings.hooks.PreToolUse = claudeSettings.hooks.PreToolUse.filter(
        (hook: any) => {
          const command = typeof hook === 'string' ? hook : hook.command;
          return !command.includes('security-guard');
        }
      );
    }

    fs.writeFileSync(this.claudeSettingsPath, JSON.stringify(claudeSettings, null, 2));
    console.log('[HooksConfigurator] Claude Code hooks removed');
  }

  private getSecurityGuardPath(): string {
    // In production, this will be in the installed package
    return path.join(__dirname, 'security-guard.js');
  }
}
```

### Phase 3: Integration with Client Startup

Modify the `init` and `start` commands to configure hooks.

**Modified files**:
- `packages/cli/src/commands/init.ts` - Configure hooks during init
- `packages/cli/src/commands/start.ts` - Verify hooks on startup
- `packages/cli/src/commands/stop.ts` - Optionally unconfigure hooks

### Phase 4: Enhanced Bash Security

Extend the security guard to handle Bash commands.

```javascript
// In security-guard.js, add Bash handling
if (tool_name === 'Bash') {
  const command = tool_input.command || '';

  // Block commands that could escape directory restrictions
  const dangerousPatterns = [
    /\bcd\s+[\/~]/,           // cd to absolute path
    /\bsudo\b/,               // sudo commands
    /\brm\s+-rf?\s+[\/~]/,    // rm with absolute path
    /\bchmod\b.*[\/~]/,       // chmod outside working dir
    // Add more patterns as needed
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return { allowed: false, reason: `Dangerous command pattern: ${pattern}` };
    }
  }

  // Also check any file paths in the command
  // This is more complex and may need path extraction logic
}
```

### Phase 5: Testing

Create comprehensive tests for the security mechanism.

**File**: `packages/cli/tests/security/security-guard.test.ts`

Test cases:
1. Allow file within working directory
2. Block file outside working directory
3. Allow file in additional allowed directory
4. Handle path traversal attempts (`../../etc/passwd`)
5. Handle tilde paths (`~/sensitive-file`)
6. Handle Bash commands with file paths
7. Handle missing config gracefully
8. Handle malformed hook input

## File Changes Summary

### New Files
| File | Description |
|------|-------------|
| `packages/cli/src/security/security-guard.js` | Standalone hook script for Claude Code |
| `packages/cli/src/security/HooksConfigurator.ts` | Manages Claude Code hooks configuration |
| `packages/cli/tests/security/security-guard.test.ts` | Tests for security guard |
| `packages/cli/tests/security/HooksConfigurator.test.ts` | Tests for hooks configurator |

### Modified Files
| File | Changes |
|------|---------|
| `packages/cli/src/commands/init.ts` | Add hooks configuration |
| `packages/cli/src/commands/start.ts` | Verify hooks on startup |
| `packages/cli/src/security/index.ts` | Export new modules |

## Reused Existing Code

| Component | Location | How Reused |
|-----------|----------|------------|
| `DirectoryGuard` | `packages/cli/src/security/DirectoryGuard.ts` | Used for path validation logic (can be imported into security-guard.js) |
| `ConfigManager` | `packages/cli/src/config/ConfigManager.ts` | Stores allowed directories |
| `ToolUseInfo` | `packages/cli/src/types/index.ts` | Type definitions for tool info |

## Security Considerations

1. **Default Deny**: If no config exists or config is invalid, the security guard allows execution (fail-open) to avoid breaking legitimate use cases. Consider changing to fail-closed for higher security.

2. **Symlink Attacks**: The security guard should resolve symlinks before path comparison to prevent symlink-based escapes.

3. **Race Conditions**: Between check and execution, the file system state could change. This is inherent to this approach.

4. **Bash Complexity**: Bash command filtering is inherently incomplete. Consider:
   - Using a more restrictive allow-list approach
   - Sandboxing with containers (complementary approach)

5. **Hook Bypass**: If Claude Code is updated and changes hook behavior, security could be compromised. Pin Claude Code version in production.

## Migration Plan

1. **Phase 1**: Deploy security-guard.js, run in "audit mode" (log but don't block)
2. **Phase 2**: Enable blocking for known-safe tool patterns
3. **Phase 3**: Full enforcement with user notification

## Dependencies

- No new npm dependencies required
- Uses only Node.js built-in modules (fs, path)
- Compatible with Claude Code hooks API

## Timeline Estimate

- Phase 1 (Security Guard Script): 2 hours
- Phase 2 (Hooks Configurator): 2 hours
- Phase 3 (Client Integration): 1 hour
- Phase 4 (Bash Security): 2 hours
- Phase 5 (Testing): 3 hours
- **Total**: ~10 hours
