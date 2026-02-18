/**
 * Security module exports
 */

export { DirectoryGuard } from './DirectoryGuard';
export { HooksConfigurator } from './HooksConfigurator';
export { validateToolUse, loadAllowedDirs } from './security-guard';
export type { ValidationResult, HookData } from './security-guard';
