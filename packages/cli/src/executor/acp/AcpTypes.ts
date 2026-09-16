export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

export interface AcpConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue?: string;
  options?: AcpConfigOptionValue[];
}

export interface AcpSessionResult {
  sessionId?: string;
  configOptions?: AcpConfigOption[];
}

export interface AcpPermissionOption {
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  optionId: string;
  name?: string;
}

export interface AcpJsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

export interface AcpJsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

export interface AcpJsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

export interface AcpJsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

export type AcpJsonRpcResponse = AcpJsonRpcSuccessResponse | AcpJsonRpcErrorResponse;

