import type { AcpTransport } from '../../src/executor/acp/AcpClient';
import type { AcpConfigOption, AcpSessionResult } from '../../src/executor/acp/AcpTypes';

/** Kimi 2.3.3 exposes manual approvals as the ACP "default" mode. */
export function kimiModeOption(currentValue = 'default'): AcpConfigOption {
  return { id: 'mode', name: 'Mode', type: 'select', currentValue,
    options: ['default', 'plan', 'auto', 'yolo'].map(value => ({ value, name: value })) };
}

/** Add native Kimi mode negotiation to generic output/lifecycle transport fixtures. */
export function withKimiModes(transport: AcpTransport): AcpTransport {
  let snapshot: AcpConfigOption[] = [];
  const session = (result: AcpSessionResult): AcpSessionResult => {
    snapshot = result.configOptions ?? [];
    return { ...result, configOptions: [...snapshot, kimiModeOption()] };
  };
  return {
    initialize: () => transport.initialize(),
    newSession: async (...args) => session(await transport.newSession(...args)),
    loadSession: async (...args) => session(await transport.loadSession(...args)),
    setConfigOption: async (...args) => {
      const result = await transport.setConfigOption(...args);
      return args[1] === 'mode' ? { configOptions: [...snapshot, kimiModeOption(args[2])] } : result;
    },
    prompt: (...args) => transport.prompt(...args),
    deleteSession: (...args) => transport.deleteSession(...args),
    sendCancel: (...args) => transport.sendCancel(...args),
    destroy: () => transport.destroy(),
    ...(transport.waitForExit ? { waitForExit: () => transport.waitForExit!() } : {}),
    ...(transport.waitForManagedProcessGroupExit ? { waitForManagedProcessGroupExit: () => transport.waitForManagedProcessGroupExit!() } : {}),
  };
}
