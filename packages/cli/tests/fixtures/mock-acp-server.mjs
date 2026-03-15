#!/usr/bin/env node
/**
 * Mock ACP server for testing AcpClient.
 * Speaks JSON-RPC 2.0 over stdin/stdout.
 * Run with: node mock-acp-server.mjs
 *
 * Behavior:
 *  - Responds to initialize, session/new, session/prompt
 *  - Sends session/update notifications for text chunks
 *  - Sends session/request_permission before prompt response
 */

import * as readline from 'readline';

const rl = readline.createInterface({ input: process.stdin });
let sessionIdCounter = 1;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function sendResponse(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  switch (msg.method) {
    case 'initialize':
      sendResponse(msg.id, { protocolVersion: 1 });
      break;

    case 'session/new': {
      const sessionId = `test-session-${sessionIdCounter++}`;
      sendResponse(msg.id, { sessionId });
      break;
    }

    case 'session/prompt': {
      const { sessionId, prompt } = msg.params;

      // Send a permission request first (tests auto-approve)
      const permId = 9000 + msg.id;
      send({
        jsonrpc: '2.0',
        id: permId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'tc-1', title: 'read_file' },
          options: [
            { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'cancel',       name: 'Reject', kind: 'reject_once' },
          ],
        },
      });

      // Wait briefly to receive the permission response
      await sleep(50);

      // Extract text from content blocks array (ACP format)
      let promptText = '';
      if (Array.isArray(prompt)) {
        promptText = prompt.map(block => block.text || '').join('');
      } else {
        promptText = String(prompt);
      }

      // Send text chunks
      const words = `Response to: ${promptText}`.split(' ');
      for (const word of words) {
        sendNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: word + ' ' },
          },
        });
      }

      // Send tool call notification
      sendNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-2',
          title: 'list_files',
          kind: 'shell',
        },
      });

      // Send tool result
      sendNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-2',
          status: 'completed',
          content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
        },
      });

      // Respond to the original prompt request
      sendResponse(msg.id, { sessionId, stopReason: 'end_turn' });
      break;
    }

    case 'session/cancel':
      // Notification — no response needed
      break;

    default:
      // Return method_not_found for unhandled server requests (like fs/read_text_file)
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      }
      break;
  }
});
