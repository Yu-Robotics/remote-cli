/**
 * Security Guard for Claude Code PreToolUse Hooks
 *
 * This module validates tool usage against allowed directory restrictions.
 * It can be used as:
 * 1. A library function (validateToolUse) for testing and programmatic use
 * 2. A standalone script called by Claude Code hooks
 *
 * Exit codes (when run as script):
 *   0 = Allow execution
 *   2 = Block execution (permission denied)
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Result of tool use validation
 */
export interface ValidationResult {
  allowed: boolean;
  reason: string;
}

/**
 * Hook data passed from Claude Code
 */
export interface HookData {
  tool_name: string;
  tool_input: Record<string, any> | undefined;
  cwd?: string;
}

/**
 * File operation tools that need path validation
 */
const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'];

/**
 * Dangerous commands that should always be blocked
 */
const DANGEROUS_COMMANDS = ['sudo'];

/**
 * Patterns that indicate piping to a shell (dangerous)
 */
const PIPE_TO_SHELL_PATTERNS = [
  /\|\s*bash\b/,
  /\|\s*sh\b/,
  /\|\s*zsh\b/,
  /\|\s*source\b/,
  /\$\(/,  // Command substitution
];

/**
 * Resolve a path that may contain ~ to an absolute path
 */
function resolvePath(filePath: string, cwd?: string): string {
  // Handle tilde expansion
  if (filePath.startsWith('~')) {
    const home = process.env.HOME || '';
    filePath = path.join(home, filePath.slice(1));
  }

  // Handle relative paths
  if (!path.isAbsolute(filePath)) {
    const basePath = cwd || process.cwd();
    filePath = path.resolve(basePath, filePath);
  }

  // Normalize to resolve .. and .
  return path.normalize(filePath);
}

/**
 * Resolve an allowed directory path (may contain ~)
 */
function resolveAllowedDir(dirPath: string): string {
  if (dirPath.startsWith('~')) {
    const home = process.env.HOME || '';
    return path.normalize(path.join(home, dirPath.slice(1)));
  }
  return path.normalize(path.resolve(dirPath));
}

/**
 * Check if a file path is within any of the allowed directories
 */
function isPathWithinAllowed(filePath: string, allowedDirs: string[]): boolean {
  const normalizedFilePath = path.normalize(filePath);

  for (const allowedDir of allowedDirs) {
    const normalizedAllowedDir = resolveAllowedDir(allowedDir);

    // Check if file path starts with allowed directory
    // Must either be exact match or have path separator after allowed dir
    if (normalizedFilePath === normalizedAllowedDir) {
      return true;
    }

    // Ensure we check with trailing separator to prevent prefix attacks
    // e.g., /home/user/app should not match /home/user/app-malicious
    const allowedWithSep = normalizedAllowedDir.endsWith(path.sep)
      ? normalizedAllowedDir
      : normalizedAllowedDir + path.sep;

    if (normalizedFilePath.startsWith(allowedWithSep)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract file path from tool input based on tool type
 */
function extractFilePath(toolName: string, toolInput: Record<string, any>): string | null {
  // Different tools use different parameter names for file paths
  if (toolName === 'NotebookEdit') {
    return toolInput.notebook_path || null;
  }

  if (toolName === 'Glob' || toolName === 'Grep') {
    // Glob and Grep use 'path' parameter
    return toolInput.path || toolInput.file_path || null;
  }

  // Read, Write, Edit use 'file_path'
  return toolInput.file_path || null;
}

/**
 * Extract paths from a bash command
 * Returns an array of paths found in the command
 */
function extractPathsFromCommand(command: string, cwd?: string): string[] {
  const paths: string[] = [];

  // Regex patterns to match paths
  // Match absolute paths, tilde paths, and relative paths with common extensions
  const pathPatterns = [
    // Absolute paths starting with /
    /(?:^|\s|=|"'`)(\/[^\s;|&><"'`]+)/g,
    // Tilde paths
    /(?:^|\s|=|"'`)(~\/[^\s;|&><"'`]*)/g,
    // Relative paths starting with ./ or ../
    /(?:^|\s|=|"'`)(\.\.[^\s;|&><"'`]*)/g,
    /(?:^|\s|=|"'`)(\.[^\s;|&><"'`]+)/g,
  ];

  for (const pattern of pathPatterns) {
    let match;
    while ((match = pattern.exec(command)) !== null) {
      const potentialPath = match[1].trim();
      // Filter out common non-path strings
      if (potentialPath && !potentialPath.match(/^\.(js|ts|json|md|sh)$/)) {
        paths.push(potentialPath);
      }
    }
  }

  return paths;
}

/**
 * Validate a Bash command against security restrictions
 */
function validateBashCommand(
  command: string,
  cwd: string | undefined,
  allowedDirs: string[]
): ValidationResult {
  // Check for dangerous commands
  for (const dangerous of DANGEROUS_COMMANDS) {
    if (new RegExp(`\\b${dangerous}\\b`).test(command)) {
      return {
        allowed: false,
        reason: `Command contains blocked keyword: ${dangerous}`
      };
    }
  }

  // Check for pipe to shell patterns
  for (const pattern of PIPE_TO_SHELL_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: 'Command contains dangerous pattern: pipe to shell'
      };
    }
  }

  // Extract and validate all paths in the command
  const extractedPaths = extractPathsFromCommand(command, cwd);

  for (const extractedPath of extractedPaths) {
    const resolvedPath = resolvePath(extractedPath, cwd);

    if (!isPathWithinAllowed(resolvedPath, allowedDirs)) {
      return {
        allowed: false,
        reason: `Path "${extractedPath}" is outside allowed directories: ${allowedDirs.join(', ')}`
      };
    }
  }

  return {
    allowed: true,
    reason: 'Command validated successfully'
  };
}

/**
 * Validate tool use against allowed directories
 *
 * @param hookData - Data from Claude Code hook (tool_name, tool_input, etc.)
 * @param allowedDirs - List of allowed directory paths
 * @returns ValidationResult indicating if the operation is allowed
 */
export function validateToolUse(hookData: HookData, allowedDirs: string[]): ValidationResult {
  const { tool_name, tool_input, cwd } = hookData;

  // If no restrictions configured, allow everything
  if (!allowedDirs || allowedDirs.length === 0) {
    return {
      allowed: true,
      reason: 'No directory restrictions configured'
    };
  }

  // Handle Bash tool specially
  if (tool_name === 'Bash') {
    if (!tool_input?.command) {
      return {
        allowed: true,
        reason: 'No command in Bash tool input'
      };
    }
    return validateBashCommand(tool_input.command, cwd, allowedDirs);
  }

  // Non-file tools (other than Bash) are allowed by default
  if (!FILE_TOOLS.includes(tool_name)) {
    return {
      allowed: true,
      reason: 'Non-file tool'
    };
  }

  // Handle missing or undefined tool_input
  if (!tool_input) {
    return {
      allowed: true,
      reason: 'No file path in tool input (undefined input)'
    };
  }

  // Extract file path from tool input
  const filePath = extractFilePath(tool_name, tool_input);

  if (!filePath) {
    return {
      allowed: true,
      reason: 'No file path in tool input'
    };
  }

  // Resolve the file path to absolute
  const absolutePath = resolvePath(filePath, cwd);

  // Check if path is within allowed directories
  if (isPathWithinAllowed(absolutePath, allowedDirs)) {
    return {
      allowed: true,
      reason: `Path within allowed directory`
    };
  }

  return {
    allowed: false,
    reason: `Path "${filePath}" is outside allowed directories: ${allowedDirs.join(', ')}`
  };
}

/**
 * Load allowed directories from config file
 * If lastWorkingDirectory is set, use it as the primary allowed directory
 */
export function loadAllowedDirs(configPath?: string): string[] {
  const effectivePath = configPath ||
    process.env.REMOTE_CLI_CONFIG ||
    path.join(process.env.HOME || '', '.remote-cli', 'config.json');

  try {
    const config = JSON.parse(fs.readFileSync(effectivePath, 'utf8'));

    // If lastWorkingDirectory is set, use it as the primary (and only) allowed directory
    // This ensures security is tied to the current working directory
    if (config.lastWorkingDirectory) {
      return [config.lastWorkingDirectory];
    }

    // Fallback to allowedDirectories if no working directory is set
    return config.security?.allowedDirectories || [];
  } catch {
    return [];
  }
}

/**
 * Main function when run as a script
 * Reads hook data from stdin and exits with appropriate code
 */
export async function main(): Promise<void> {
  let input = '';

  // Read from stdin
  process.stdin.setEncoding('utf8');

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const hookData: HookData = JSON.parse(input);
    const allowedDirs = loadAllowedDirs();

    // If no allowed directories are configured, allow everything (fallback)
    if (allowedDirs.length === 0) {
      console.error('[SecurityGuard] Warning: No working directory configured, allowing all operations');
      process.exit(0);
    }

    const result = validateToolUse(hookData, allowedDirs);

    if (!result.allowed) {
      console.error(`[SecurityGuard] Blocked: ${result.reason}`);
      process.exit(2);
    }

    process.exit(0);
  } catch (error) {
    console.error(`[SecurityGuard] Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    // Allow on error to avoid blocking legitimate operations
    process.exit(0);
  }
}

// Run main if executed directly
if (require.main === module) {
  main();
}
