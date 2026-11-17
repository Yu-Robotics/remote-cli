import { randomUUID } from 'crypto';
import type { AcpPermissionOption } from '../acp/AcpTypes';
import type { ExecuteOptions } from '../IExecutor';
import type { ApprovalAction } from '../../types';

/** AGY-local permission lifecycle. No persistent "always" grants are synthesized. */
export class AgyPermissions {
  private pending?: { id: string; choices: AcpPermissionOption[]; finish(index: number): void };
  get waiting(): boolean { return !!this.pending; }
  request(title: string, choices: AcpPermissionOption[], active: ExecuteOptions | undefined, automatic: boolean): Promise<number> {
    if (!active) return Promise.resolve(-1);
    const question = choices.some(choice => /^q\d+_/.test(choice.optionId));
    if (automatic && !question) return Promise.resolve(choices.findIndex(choice => choice.kind === 'allow_once'));
    this.cancel();
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = setTimeout(() => finish(-1, true), 120_000);
      const finish = (index: number, expired = false) => {
        if (this.pending?.id !== id) return;
        this.pending = undefined; clearTimeout(timer);
        active.onApprovalResolved?.(id, expired ? 'expired' : index >= 0 && choices[index].kind.startsWith('allow') ? 'approved' : 'denied');
        resolve(index);
      };
      this.pending = { id, choices, finish };
      // Questions preserve native choice identity and use the existing text-input channel.
      const card = !question && active.onApprovalRequest?.({ requestId: id, kind: 'permissions', description: title, canRemember: false });
      if (!card) active.onStream?.(question
        ? `\n${title}\n${choices.map((choice, index) => `${index + 1}. ${choice.name ?? choice.optionId}`).join('\n')}\nReply with an option number, no, or cancel.\n`
        : `\nApproval required for ${title}. Reply yes, no, or cancel.\n`);
    });
  }
  respond(id: string, action: ApprovalAction): boolean {
    if (this.pending?.id !== id || action === 'remember') return false;
    return this.input(action === 'approve' ? 'yes' : action === 'deny' ? 'no' : 'cancel');
  }
  input(text: string): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const value = text.trim().toLowerCase();
    if (['cancel', 'skip'].includes(value)) { pending.finish(-1); return true; }
    let index = ['yes', 'y', 'accept'].includes(value) ? pending.choices.findIndex(choice => choice.kind === 'allow_once')
      : ['no', 'n', 'decline'].includes(value) ? pending.choices.findIndex(choice => choice.kind === 'reject_once')
      : /^\d+$/.test(value) ? Number(value) - 1 : pending.choices.findIndex(choice => choice.name?.toLowerCase() === value);
    if (index < 0 || index >= pending.choices.length || pending.choices[index].kind.endsWith('always')) return false;
    pending.finish(index); return true;
  }
  cancel(): void { this.pending?.finish(-1); }
}
