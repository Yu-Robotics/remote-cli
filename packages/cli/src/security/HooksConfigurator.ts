/**
 * HooksConfigurator - Manages Claude Code hooks configuration
 *
 * This module handles the configuration of Claude Code's PreToolUse hooks
 * to enforce directory-based security restrictions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Claude Code hook configuration
 */
interface HookConfig {
  command: string;
  tools?: string[];
}

/**
 * Claude Code settings structure
 */
interface ClaudeSettings {
  hooks?: {
    PreToolUse?: (string | HookConfig)[];
    PostToolUse?: (string | HookConfig)[];
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * File operation tools that need security validation
 */
const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'];

/**
 * HooksConfigurator manages Claude Code hooks configuration
 * for security enforcement
 */
export class HooksConfigurator {
  private claudeSettingsPath: string;

  constructor() {
    this.claudeSettingsPath = path.join(
      os.homedir(),
      '.claude',
      'settings.json'
    );
  }

  /**
   * Configure Claude Code hooks for security
   * Adds the security guard hook to PreToolUse
   */
  async configure(): Promise<void> {
    const securityGuardPath = this.getSecurityGuardPath();

    // Verify security guard script exists
    if (!fs.existsSync(securityGuardPath)) {
      throw new Error(`Security guard script not found at: ${securityGuardPath}`);
    }

    // Read existing settings or create empty object
    let settings: ClaudeSettings = {};
    try {
      if (fs.existsSync(this.claudeSettingsPath)) {
        const content = fs.readFileSync(this.claudeSettingsPath, 'utf8');
        settings = JSON.parse(content);
      }
    } catch {
      // If file doesn't exist or can't be parsed, start fresh
      settings = {};
    }

    // Initialize hooks structure
    settings.hooks = settings.hooks || {};
    settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];

    // Check if security guard hook is already configured
    const hookCommand = `node "${securityGuardPath}"`;
    const existingHook = settings.hooks.PreToolUse.find((hook) => {
      const command = typeof hook === 'string' ? hook : hook.command;
      return command.includes('security-guard');
    });

    // Add hook if not already present
    if (!existingHook) {
      const newHook: HookConfig = {
        command: hookCommand,
        tools: FILE_TOOLS
      };
      settings.hooks.PreToolUse.push(newHook);
    }

    // Ensure .claude directory exists
    const claudeDir = path.dirname(this.claudeSettingsPath);
    fs.mkdirSync(claudeDir, { recursive: true });

    // Write settings
    fs.writeFileSync(
      this.claudeSettingsPath,
      JSON.stringify(settings, null, 2),
      'utf8'
    );

    console.log('[HooksConfigurator] Claude Code hooks configured successfully');
  }

  /**
   * Remove security guard hooks from Claude settings
   */
  async unconfigure(): Promise<void> {
    // Check if settings file exists
    if (!fs.existsSync(this.claudeSettingsPath)) {
      return;
    }

    // Read settings
    let settings: ClaudeSettings;
    try {
      const content = fs.readFileSync(this.claudeSettingsPath, 'utf8');
      settings = JSON.parse(content);
    } catch {
      return;
    }

    // Remove security guard hooks from PreToolUse
    if (settings.hooks?.PreToolUse) {
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((hook) => {
        const command = typeof hook === 'string' ? hook : hook.command;
        return !command.includes('security-guard');
      });
    }

    // Write settings back
    fs.writeFileSync(
      this.claudeSettingsPath,
      JSON.stringify(settings, null, 2),
      'utf8'
    );

    console.log('[HooksConfigurator] Claude Code hooks removed');
  }

  /**
   * Check if security guard hooks are configured
   */
  async isConfigured(): Promise<boolean> {
    // Check if settings file exists
    if (!fs.existsSync(this.claudeSettingsPath)) {
      return false;
    }

    // Read settings
    let settings: ClaudeSettings;
    try {
      const content = fs.readFileSync(this.claudeSettingsPath, 'utf8');
      settings = JSON.parse(content);
    } catch {
      return false;
    }

    // Check for security guard in PreToolUse
    if (!settings.hooks?.PreToolUse) {
      return false;
    }

    return settings.hooks.PreToolUse.some((hook) => {
      const command = typeof hook === 'string' ? hook : hook.command;
      return command.includes('security-guard');
    });
  }

  /**
   * Get the path to the security guard script
   */
  getSecurityGuardPath(): string {
    // The security guard script is in the same directory as this module
    // Try .ts first (for development), then .js (for production)
    const tsPath = path.join(__dirname, 'security-guard.ts');
    const jsPath = path.join(__dirname, 'security-guard.js');
    return fs.existsSync(tsPath) ? tsPath : jsPath;
  }
}
