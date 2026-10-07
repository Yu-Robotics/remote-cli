import { sanitizeActivityText } from './Activity';

// Fit the existing compact heading so the Router cannot truncate the omission suffix.
const COMMAND_DESCRIPTION_LIMIT = 60;

/** Describe native command actions, without parsing commands or exposing search arguments. */
export function describeCodexCommandActions(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return;
  const labels: string[] = [];
  for (const action of value) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return;
    let label: string;
    switch (action.type) {
      case 'read': {
        const file = [action.path, action.name].find(item => typeof item === 'string' && item.trim());
        const basename = typeof file === 'string'
          ? sanitizeActivityText(file.split(/[\\/]/).filter(Boolean).at(-1) ?? '')
          : '';
        label = basename && basename !== '.' && basename !== '..' ? `Read ${basename}` : 'Read file';
        break;
      }
      case 'search':
        label = 'Search files';
        break;
      case 'listFiles':
        label = 'List directory';
        break;
      default:
        // A recognized prefix must not hide unknown actions in a compound command.
        return;
    }
    if (!labels.includes(label)) labels.push(label);
  }
  const preview = labels.slice(0, 3);
  const suffix = labels.length > preview.length ? ` / +${labels.length - preview.length} more` : '';
  const labelLimit = Math.floor((COMMAND_DESCRIPTION_LIMIT - suffix.length - (preview.length - 1) * 3) / preview.length);
  return preview.map(label => {
    const characters = Array.from(label);
    return characters.length > labelLimit ? `${characters.slice(0, labelLimit - 1).join('')}…` : label;
  }).join(' / ') + suffix;
}
