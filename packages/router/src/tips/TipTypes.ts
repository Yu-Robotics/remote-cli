/** Reviewed static educational content. Examples are displayed, never executed. */
export interface TipDefinition {
  id: string;
  topic: string;
  title: string;
  problem: string;
  benefit: string;
  action: string;
  example: string;
  detail: string;
  image: string;
}

export interface TipAction {
  action: 'tips';
  id: string;
  op: string;
  value?: string;
}

/** All transport calls are injected so tests never contact Feishu. */
export interface TipServiceOptions {
  directory: string;
  catalog: readonly TipDefinition[];
  timezone?: string;
  now?: () => number;
  users: () => Promise<string[]>;
  isBound: (openId: string) => Promise<boolean>;
  canDeliver: (openId: string) => Promise<boolean>;
  image: (tip: TipDefinition) => Promise<string | null>;
  create: (openId: string, elements: any[], header: Record<string, unknown>, deliveryKey: string) => Promise<string | null>;
  update: (cardId: string, elements: any[], header: Record<string, unknown>) => Promise<void>;
}
