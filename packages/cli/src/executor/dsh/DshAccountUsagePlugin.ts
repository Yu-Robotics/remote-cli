import { DSH_ACCOUNT_USAGE_PREFIX, formatDshAccountBalance } from './DshAccountUsage';

export const name = 'remote-cli-dsh-account-usage';
export const inject = ['deepseekAccount'];

interface AccountMetadata {
  version: string;
  locale: string;
  timezoneOffsetSeconds: number;
}

interface AccountContext {
  deepseekAccount: { getBalance(metadata: AccountMetadata): Promise<unknown> };
}

/** A one-shot native DSH plugin. Only the sanitized balance projection reaches stdout. */
export async function apply(context: AccountContext, metadata: AccountMetadata): Promise<void> {
  let output: string | null = null;
  try { output = formatDshAccountBalance(await context.deepseekAccount.getBalance(metadata)); } catch {
    // Missing authentication, quota-service failures, and provider details stay private.
  }
  process.stdout.write(`${DSH_ACCOUNT_USAGE_PREFIX}${JSON.stringify({ output })}\n`);
}
