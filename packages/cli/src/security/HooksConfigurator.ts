/**
 * HooksConfigurator - Removes legacy remote-cli Claude Code hooks
 *
 * remote-cli no longer installs a global PreToolUse security hook. This
 * module remains temporarily so upgraded installations can remove hooks
 * written by older versions without touching user-defined hooks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Claude Code hook configuration (new format with matcher)
 */
interface HookConfig {
  matcher: string;
  hooks: Array<{
    type: 'command';
    command: string;
  }>;
}

/**
 * Claude Code settings structure
 */
interface ClaudeSettings {
  hooks?: {
    PreToolUse?: HookConfig[];
    PostToolUse?: HookConfig[];
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Removes remote-cli's legacy security hook from Claude Code settings.
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
   * Remove legacy remote-cli security guard hooks from Claude settings.
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

    const existingHooks = settings.hooks?.PreToolUse;
    if (!existingHooks) return;

    const remainingHooks = existingHooks.filter((hook) => {
      return !hook.hooks?.some(h => h.command.includes('security-guard'));
    });
    if (remainingHooks.length === existingHooks.length) return;

    if (remainingHooks.length > 0) settings.hooks!.PreToolUse = remainingHooks;
    else delete settings.hooks!.PreToolUse;
    if (Object.keys(settings.hooks!).length === 0) delete settings.hooks;

    // Write settings back
    fs.writeFileSync(
      this.claudeSettingsPath,
      JSON.stringify(settings, null, 2),
      'utf8'
    );

    console.log('[HooksConfigurator] Legacy remote-cli security hook removed');
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
      return hook.hooks?.some(h => h.command.includes('security-guard'));
    });
  }
}
