import { describe, expect, it } from 'vitest';
import { formatDelegationStatus } from '../../src/delegation/DelegationStatusFormatter';
import type { BackendAvailability } from '../../src/delegation/BackendRegistry';

function availability(overrides: Partial<BackendAvailability>): BackendAvailability {
  return {
    backend: 'claude',
    installed: true,
    version: '2.1.267 (Claude Code)',
    authentication: 'unknown',
    coordinator: true,
    worker: true,
    readOnly: true,
    ...overrides,
  };
}

describe('delegation status formatter', () => {
  it('groups the enabled state, coordinator, backend availability, and operating rules', () => {
    const output = formatDelegationStatus({
      enabled: true,
      coordinatorBackend: 'claude',
      coordinatorSupported: true,
      backends: [
        availability({ backend: 'claude' }),
        availability({ backend: 'codex', version: 'codex-cli 0.159.2' }),
        availability({ backend: 'pi', installed: false, version: undefined, reason: 'Executable is missing or its version probe failed', coordinator: false, worker: false, readOnly: false }),
      ],
    });

    expect(output).toContain('🤝 **Cross-backend delegation**');
    expect(output).toContain("<text_tag color='green'>Enabled</text_tag> **Current thread**");
    expect(output).toContain('**Coordinator:** Claude Code');
    expect(output).toContain("<text_tag color='blue'>Coordinator</text_tag> **Claude Code** · <raw>2.1.267 (Claude Code)</raw>");
    expect(output).toContain("<text_tag color='green'>Installed</text_tag> **Codex CLI** · <raw>codex-cli 0.159.2</raw>");
    expect(output).toContain("<text_tag color='red'>Unavailable</text_tag> **Pi** · <raw>Executable is missing or its version probe failed</raw>");
    expect(output).toContain('Same-backend delegation is disabled');
    expect(output).toContain('Authentication and quota are checked when a task starts.');
    expect(output).toContain('Cross-backend delegation is unavailable while the coordinator sandbox is enabled.');
    expect(output).toContain('**Commands:** `/delegation on` · `/delegation off` · `/delegation reset [backend]`');
  });

  it('keeps executable output literal and marks an installed but ineligible worker as blocked', () => {
    const output = formatDelegationStatus({
      enabled: false,
      coordinatorBackend: 'codex',
      coordinatorSupported: true,
      backends: [
        availability({ backend: 'codex', version: '\u001b[31m</raw><at id=all></at>\n0.159.2\u001b[0m' }),
        availability({ backend: 'claude', worker: false, version: '2.1.267' }),
      ],
    });

    expect(output).toContain("<text_tag color='neutral'>Off</text_tag> **Current thread**");
    expect(output).toContain("<text_tag color='orange'>Blocked</text_tag> **Claude Code** · <raw>2.1.267</raw>");
    expect(output).toContain('<raw>&lt;/raw&gt;&lt;at id=all&gt;&lt;/at&gt; 0.159.2</raw>');
    expect(output).not.toContain('<at id=all>');
    expect(output).not.toContain('\u001b');
  });
});
