import * as lark from '@larksuiteoapi/node-sdk';
import { v4 as uuidv4 } from 'uuid';
import { BindingManager } from '../binding/BindingManager';
import { ConnectionHub } from '../websocket/ConnectionHub';
import { MessageType } from '../types';
import { JsonStore } from '../storage/JsonStore';

/**
 * Feishu Long Connection Handler configuration
 */
export interface FeishuLongConnHandlerConfig {
  appId: string;
  appSecret: string;
  store: JsonStore;
}

/**
 * Feishu Long Connection Handler
 * Uses Feishu SDK's WSClient for WebSocket long connection
 */
export class FeishuLongConnHandler {
  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private bindingManager: BindingManager;
  private connectionHub: ConnectionHub | null = null;
  private appId: string;
  private appSecret: string;
  // Feishu message size limit (4000 chars per message) - DEPRECATED for Card 2.0
  private readonly FEISHU_MESSAGE_LIMIT = 4000;
  // Feishu Card 2.0 limits (from official docs)
  // Note: Using conservative limits - official says 200, we use 150 with proper recursive counting
  // The 150 limit leaves a 50-node safety buffer while still being practical
  private readonly CARD_ELEMENT_LIMIT = 150; // Conservative: 150 tagged nodes per card (official: 200)
  private readonly CARD_DATA_SIZE_LIMIT = 3000000; // Max 3MB (3,000,000 chars) for data field
  private readonly CARD_SIZE_BUFFER = 100000; // Safety buffer: use 2.9MB instead of 3MB
  // Track message chains: messageId -> [messageId1, messageId2, ...]
  private messageChains: Map<string, string[]> = new Map();
  // Track the last processed text length for each message chain
  // This helps us only send NEW content to existing messages, preventing duplication
  private lastProcessedLengths: Map<string, number> = new Map();
  // Per-message serialization locks to prevent concurrent updates from creating duplicates
  private messageLocks: Map<string, Promise<any>> = new Map();
  // Pattern to match tool use separator lines
  private readonly TOOL_USE_PATTERN = /─+ TOOL USE ─+/;
  private readonly TOOL_SEPARATOR_PATTERN = /─{20,}/;

  constructor(config: FeishuLongConnHandlerConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.bindingManager = new BindingManager(config.store);

    // Initialize Feishu SDK client for API calls
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });
  }

  /**
   * Set ConnectionHub (called from RouterServer)
   */
  setConnectionHub(hub: ConnectionHub): void {
    this.connectionHub = hub;
  }

  /**
   * Callback to register streaming message with RouterServer
   */
  private onStartStreaming?: (messageId: string, openId: string, feishuMessageId: string | null, deviceId: string) => void;

  /**
   * Set streaming start callback
   */
  setOnStartStreaming(callback: (messageId: string, openId: string, feishuMessageId: string | null, deviceId: string) => void): void {
    this.onStartStreaming = callback;
  }

  /**
   * Handle message event
   */
  private async handleMessageEvent(data: any): Promise<void> {
    try {
      const message = data.message;
      const sender = data.sender;

      // Skip non-text messages
      if (message.message_type !== 'text') {
        return;
      }

      const openId = sender.sender_id.open_id;
      const messageId = message.message_id;
      const content = this.parseMessageContent(message);

      console.log(`[FeishuHandler] Received message from ${openId}: ${content}, msgId=${messageId}`);

      // Check if it's a command
      if (this.isCommand(content)) {
        await this.handleCommand(openId, messageId, content);
      } else {
        console.log(`[FeishuHandler] Handling regular command, msgId=${messageId}`);
        await this.handleRegularCommand(openId, messageId, content);
        console.log(`[FeishuHandler] Finished handling regular command, msgId=${messageId}`);
      }
    } catch (error) {
      console.error('Error in handleMessageEvent:', error);
    }
  }

  /**
   * Parse message content
   */
  private parseMessageContent(message: any): string {
    try {
      const content = JSON.parse(message.content);
      return (content.text || '').trim();
    } catch (error) {
      return '';
    }
  }

  /**
   * Check if it's a command
   */
  private isCommand(content: string): boolean {
    return content.startsWith('/');
  }

  /**
   * Handle command
   */
  private async handleCommand(openId: string, messageId: string, content: string): Promise<void> {
    const parts = content.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case '/bind':
        if (parts.length >= 2) {
          await this.handleBindCommand(openId, messageId, parts[1]);
        } else {
          await this.replyToMessage(messageId, 'Please provide binding code, format: /bind ABC-123-XYZ');
        }
        break;

      case '/status':
        await this.handleStatusCommand(openId, messageId);
        break;

      case '/unbind':
        await this.handleUnbindCommand(openId, messageId);
        break;

      case '/device':
        await this.handleDeviceCommand(openId, messageId, parts.slice(1));
        break;

      case '/help':
        await this.handleHelpCommand(openId, messageId);
        break;

      default:
        // Pass through unknown slash commands to the client
        // This allows users to use their local Claude Code custom commands
        await this.handleSlashCommandPassthrough(openId, messageId, content, command);
    }
  }

  /**
   * Handle slash command passthrough to client
   * Passes unknown slash commands to the local Claude Code instance
   */
  private async handleSlashCommandPassthrough(
    openId: string,
    messageId: string,
    content: string,
    command: string
  ): Promise<void> {
    try {
      // Find user binding
      const binding = await this.bindingManager.getUserBinding(openId);
      if (!binding) {
        await this.replyToMessage(
          messageId,
          '❌ You have not bound a device yet, please send /bind <binding-code> to bind first'
        );
        return;
      }

      // Get active device
      const activeDevice = await this.bindingManager.getActiveDevice(openId);
      if (!activeDevice) {
        await this.replyToMessage(
          messageId,
          '❌ No active device found. Please use /device list to view your devices'
        );
        return;
      }

      // Check if ConnectionHub is available
      if (!this.connectionHub) {
        await this.replyToMessage(messageId, '❌ Server error: ConnectionHub not initialized');
        return;
      }

      // Check if device is online
      if (!this.connectionHub.isDeviceOnline(activeDevice.deviceId)) {
        await this.replyToMessage(
          messageId,
          `❌ Device ${activeDevice.deviceName} is currently offline, please ensure the device is started and connected to the server`
        );
        return;
      }

      console.log(`[FeishuHandler] Passing through slash command: ${command}`);

      // Generate message ID first
      const commandMessageId = uuidv4();

      // Register streaming session BEFORE sending command
      const feishuMessageId = await this.sendStreamingStart(openId, `🤔 Executing ${command}...`);
      console.log(`[FeishuHandler] Created card ${feishuMessageId} for slash command ${commandMessageId}`);
      if (this.onStartStreaming) {
        this.onStartStreaming(commandMessageId, openId, feishuMessageId, activeDevice.deviceId);
      }

      // Send slash command to device - the client will execute it locally
      const success = await this.connectionHub.sendToDevice(activeDevice.deviceId, {
        type: MessageType.COMMAND,
        messageId: commandMessageId,
        timestamp: Date.now(),
        content, // Send the full command including arguments
        openId,
        isSlashCommand: true, // Flag to indicate this is a slash command
      });

      if (!success) {
        await this.replyToMessage(messageId, '❌ Command sending failed, please try again later');
      }
    } catch (error) {
      console.error('Error handling slash command passthrough:', error);
      await this.replyToMessage(messageId, '❌ Error processing command, please try again later');
    }
  }

  /**
   * Handle bind command
   */
  private async handleBindCommand(openId: string, messageId: string, code: string): Promise<void> {
    try {
      // Verify binding code
      const bindingCode = await this.bindingManager.verifyBindingCode(code);
      if (!bindingCode) {
        await this.replyToMessage(messageId, '❌ Binding code is invalid or expired, please generate a new one');
        return;
      }

      // Check if device is already bound
      const existingDevices = await this.bindingManager.getUserDevices(openId);
      const alreadyBound = existingDevices.some(d => d.deviceId === bindingCode.deviceId);

      if (alreadyBound) {
        await this.replyToMessage(messageId, '❌ This device is already bound to your account');
        return;
      }

      // Bind user
      const deviceName = 'Device'; // Will be updated by client later
      await this.bindingManager.bindUser(openId, bindingCode.deviceId, deviceName);

      const isFirstDevice = existingDevices.length === 0;
      const statusNote = isFirstDevice
        ? '\n\n📱 This is your first device and will be set as active.'
        : '\n\n📱 Use /device switch to activate this device.';

      await this.replyToMessage(
        messageId,
        `✅ Binding successful!\n\nDevice ID: ${bindingCode.deviceId}\n\nYou can now control your device through Feishu.${statusNote}\n\nUse /device list to view all your devices.`
      );
    } catch (error) {
      console.error('Error binding user:', error);
      await this.replyToMessage(messageId, '❌ Binding failed, please try again later');
    }
  }

  /**
   * Handle status command
   */
  private async handleStatusCommand(openId: string, messageId: string): Promise<void> {
    try {
      const binding = await this.bindingManager.getUserBinding(openId);
      if (!binding) {
        await this.replyToMessage(
          messageId,
          '❌ You have not bound a device yet, please send /bind <binding-code> to bind first'
        );
        return;
      }

      const devices = binding.devices;
      if (devices.length === 0) {
        await this.replyToMessage(messageId, '❌ No devices found');
        return;
      }

      // Build status message
      let message = `📊 Device Status\n\n`;

      for (const device of devices) {
        const isOnline = this.connectionHub?.isDeviceOnline(device.deviceId) || false;
        const status = isOnline ? '🟢 Online' : '🔴 Offline';
        const activeIndicator = device.isActive ? ' ⭐ ACTIVE' : '';

        message += `\n**${device.deviceName}**${activeIndicator}\n`;
        message += `Device ID: ${device.deviceId}\n`;
        message += `Status: ${status}\n`;
        message += `Bound: ${new Date(device.boundAt).toLocaleString('en-US')}\n`;
        message += `Last Active: ${new Date(device.lastActiveAt).toLocaleString('en-US')}\n`;
      }

      message += `\n\nTotal Devices: ${devices.length}`;

      await this.replyToMessage(messageId, message);
    } catch (error) {
      console.error('Error handling status command:', error);
      await this.replyToMessage(messageId, '❌ Status query failed, please try again later');
    }
  }

  /**
   * Handle unbind command
   * Usage: /unbind or /unbind all (unbind all devices)
   * For unbinding specific device, use /device unbind <device-id>
   */
  private async handleUnbindCommand(openId: string, messageId: string): Promise<void> {
    try {
      const binding = await this.bindingManager.getUserBinding(openId);
      if (!binding) {
        await this.replyToMessage(messageId, '❌ You have not bound a device yet');
        return;
      }

      const deviceCount = binding.devices.length;

      // Unbind all devices
      await this.bindingManager.unbindUser(openId);
      await this.replyToMessage(
        messageId,
        `✅ Successfully unbound ${deviceCount} device(s)`
      );
    } catch (error) {
      console.error('Error handling unbind command:', error);
      await this.replyToMessage(messageId, '❌ Unbinding failed, please try again later');
    }
  }

  /**
   * Handle device command
   * Usage:
   *   /device - List all bound devices (same as /device list)
   *   /device list - List all bound devices
   *   /device switch <device-id|index> - Switch active device (by ID or index number)
   *   /device <device-id|index> - Quick switch to device (by ID or index number)
   *   /device unbind <device-id|index> - Unbind a specific device (by ID or index number)
   */
  private async handleDeviceCommand(openId: string, messageId: string, args: string[]): Promise<void> {
    try {
      const binding = await this.bindingManager.getUserBinding(openId);
      if (!binding) {
        await this.replyToMessage(
          messageId,
          '❌ You have not bound a device yet, please send /bind <binding-code> to bind first'
        );
        return;
      }

      // No args - show device list
      if (args.length === 0) {
        await this.handleDeviceList(openId, messageId, binding);
        return;
      }

      const subcommand = args[0]?.toLowerCase();

      switch (subcommand) {
        case 'list':
          await this.handleDeviceList(openId, messageId, binding);
          break;

        case 'switch':
          if (args.length < 2) {
            await this.replyToMessage(messageId, '❌ Please provide device ID or index, format: /device switch <device-id-or-index>');
            return;
          }
          await this.handleDeviceSwitch(openId, messageId, args[1], binding);
          break;

        case 'unbind':
          if (args.length < 2) {
            await this.replyToMessage(messageId, '❌ Please provide device ID or index, format: /device unbind <device-id-or-index>');
            return;
          }
          await this.handleDeviceUnbind(openId, messageId, args[1], binding);
          break;

        default:
          // If the argument looks like a number (index) or device ID, treat it as a quick switch
          await this.handleDeviceSwitch(openId, messageId, args[0], binding);
      }
    } catch (error) {
      console.error('Error handling device command:', error);
      await this.replyToMessage(messageId, '❌ Error processing device command, please try again later');
    }
  }

  /**
   * Handle /device list
   */
  private async handleDeviceList(openId: string, messageId: string, binding: any): Promise<void> {
    const devices = binding.devices;
    if (devices.length === 0) {
      await this.replyToMessage(messageId, '❌ No devices found');
      return;
    }

    let message = `📱 Your Devices (${devices.length})\n\n`;

    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      const isOnline = this.connectionHub?.isDeviceOnline(device.deviceId) || false;
      const status = isOnline ? '🟢 Online' : '🔴 Offline';
      const activeIndicator = device.isActive ? ' ⭐ ACTIVE' : '';

      message += `${i + 1}. **${device.deviceName}**${activeIndicator}\n`;
      message += `   ID: \`${device.deviceId}\`\n`;
      message += `   Status: ${status}\n`;
      message += `   Bound: ${new Date(device.boundAt).toLocaleString('en-US')}\n\n`;
    }

    message += `\n💡 Quick switch: /device <index> or /device <device-id>`;
    message += `\n   Example: /device 1 or /device switch 1`;

    await this.replyToMessage(messageId, message);
  }

  /**
   * Resolve device identifier (ID or index) to device ID
   * @returns Resolved device ID or null if not found
   */
  private resolveDeviceIdentifier(identifier: string, binding: any): string | null {
    // Try to parse as index (1-based)
    const index = parseInt(identifier, 10);
    if (!isNaN(index) && index > 0 && index <= binding.devices.length) {
      return binding.devices[index - 1].deviceId;
    }

    // Treat as device ID - check if it exists
    const device = binding.devices.find((d: any) => d.deviceId === identifier);
    if (device) {
      return device.deviceId;
    }

    return null;
  }

  /**
   * Handle /device switch <device-id-or-index>
   * Also handles quick switch: /device <device-id-or-index>
   */
  private async handleDeviceSwitch(openId: string, messageId: string, identifier: string, binding?: any): Promise<void> {
    try {
      // Get binding if not provided
      const userBinding = binding || await this.bindingManager.getUserBinding(openId);
      if (!userBinding) {
        await this.replyToMessage(messageId, '❌ You have not bound a device yet');
        return;
      }

      // Resolve identifier to device ID
      const deviceId = this.resolveDeviceIdentifier(identifier, userBinding);

      if (!deviceId) {
        await this.replyToMessage(
          messageId,
          `❌ Device "${identifier}" not found. Use /device to see available devices and their indices.`
        );
        return;
      }

      const result = await this.bindingManager.switchActiveDevice(openId, deviceId);

      if (!result) {
        await this.replyToMessage(messageId, '❌ Device switch failed');
        return;
      }

      const device = await this.bindingManager.getActiveDevice(openId);
      if (!device) {
        await this.replyToMessage(messageId, '❌ Failed to get active device after switch');
        return;
      }

      await this.replyToMessage(
        messageId,
        `✅ Switched to device: **${device.deviceName}**\n\nDevice ID: \`${device.deviceId}\``
      );
    } catch (error) {
      console.error('Error switching device:', error);
      await this.replyToMessage(messageId, '❌ Failed to switch device, please try again later');
    }
  }

  /**
   * Handle /device unbind <device-id-or-index>
   */
  private async handleDeviceUnbind(openId: string, messageId: string, identifier: string, binding?: any): Promise<void> {
    try {
      // Get binding if not provided
      const userBinding = binding || await this.bindingManager.getUserBinding(openId);
      if (!userBinding) {
        await this.replyToMessage(messageId, '❌ You have not bound a device yet');
        return;
      }

      // Resolve identifier to device ID
      const deviceId = this.resolveDeviceIdentifier(identifier, userBinding);

      if (!deviceId) {
        await this.replyToMessage(
          messageId,
          `❌ Device "${identifier}" not found. Use /device to see available devices and their indices.`
        );
        return;
      }

      const device = userBinding.devices.find((d: any) => d.deviceId === deviceId);
      if (!device) {
        await this.replyToMessage(messageId, '❌ Device not found');
        return;
      }

      const wasActive = device.isActive;
      const result = await this.bindingManager.unbindDevice(openId, deviceId);

      if (!result) {
        await this.replyToMessage(messageId, '❌ Failed to unbind device');
        return;
      }

      let responseMessage = `✅ Device **${device.deviceName}** has been unbound`;

      // If we unbound the active device, inform about the new active device
      if (wasActive) {
        const newActiveDevice = await this.bindingManager.getActiveDevice(openId);
        if (newActiveDevice) {
          responseMessage += `\n\n📱 New active device: **${newActiveDevice.deviceName}**`;
        } else {
          responseMessage += `\n\n⚠️ No devices remaining. Use /bind to add a new device.`;
        }
      }

      await this.replyToMessage(messageId, responseMessage);
    } catch (error) {
      console.error('Error unbinding device:', error);
      await this.replyToMessage(messageId, '❌ Failed to unbind device, please try again later');
    }
  }

  /**
   * Handle help command
   */
  private async handleHelpCommand(openId: string, messageId: string): Promise<void> {
    const helpMessage = `📖 Feishu Remote Control Help

Device management commands:
/bind <binding-code> - Bind a new device
/unbind - Unbind all devices
/device - List all your devices
/device list - List all your devices
/device switch <device-id-or-index> - Switch active device
/device <device-id-or-index> - Quick switch to device
/device unbind <device-id-or-index> - Unbind a specific device
/status - View all device statuses
/help - Show help information

Claude Code commands (sent to active device):
/cd <directory> - Change working directory
/clear - Clear conversation context and start fresh session
/abort - Abort the currently executing command

Regular messages will be sent to your active device for execution.

Multi-device support:
• You can bind multiple devices to your account
• Only one device is active at a time
• Commands are sent to the active device
• Use /device or /device list to see your devices
• Switch by index: /device 1 or /device switch 2
• Switch by ID: /device <device-id>

Examples:
• "/device" - List all devices
• "/device 1" - Switch to device #1
• "/cd ~/projects/myapp" - Change to project directory
• "/clear" - Start a fresh Claude conversation
• "List files in current directory"
• "Run tests"
• "View recent git commits"`;

    await this.replyToMessage(messageId, helpMessage);
  }

  /**
   * Handle regular command (non-slash commands)
   */
  private async handleRegularCommand(openId: string, messageId: string, content: string): Promise<void> {
    try {
      // Find user binding
      const binding = await this.bindingManager.getUserBinding(openId);
      if (!binding) {
        await this.replyToMessage(
          messageId,
          '❌ You have not bound a device yet, please send /bind <binding-code> to bind first'
        );
        return;
      }

      // Get active device
      const activeDevice = await this.bindingManager.getActiveDevice(openId);
      if (!activeDevice) {
        await this.replyToMessage(
          messageId,
          '❌ No active device found. Please use /device list to view your devices'
        );
        return;
      }

      // Check if ConnectionHub is available
      if (!this.connectionHub) {
        await this.replyToMessage(messageId, '❌ Server error: ConnectionHub not initialized');
        return;
      }

      // Check if device is online
      if (!this.connectionHub.isDeviceOnline(activeDevice.deviceId)) {
        await this.replyToMessage(
          messageId,
          `❌ Device ${activeDevice.deviceName} is currently offline, please ensure the device is started and connected to the server`
        );
        return;
      }

      // Generate message ID first
      const commandMessageId = uuidv4();
      console.log(`[FeishuHandler] Creating streaming card for command ${commandMessageId}`);

      // Register streaming session BEFORE sending command to avoid race condition
      // where stream chunks arrive before registration
      const feishuMessageId = await this.sendStreamingStart(openId, '🤔 Processing...');
      console.log(`[FeishuHandler] Created card ${feishuMessageId} for command ${commandMessageId}`);
      if (this.onStartStreaming) {
        this.onStartStreaming(commandMessageId, openId, feishuMessageId, activeDevice.deviceId);
      }

      // Send command to device
      const success = await this.connectionHub.sendToDevice(activeDevice.deviceId, {
        type: MessageType.COMMAND,
        messageId: commandMessageId,
        timestamp: Date.now(),
        content,
        openId
      });

      if (!success) {
        // Send failed - delete the streaming session and notify user
        if (this.onStartStreaming) {
          // We need a way to clean up, for now just send error as new message
          await this.replyToMessage(messageId, '❌ Command sending failed, please try again later');
        }
      }
    } catch (error) {
      console.error('Error handling regular command:', error);
      await this.replyToMessage(messageId, '❌ Error processing command, please try again later');
    }
  }

  /**
   * Reply to a message
   */
  private async replyToMessage(messageId: string, text: string): Promise<void> {
    try {
      await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (error: any) {
      console.error('Failed to reply to message:', error?.message || error);
    }
  }

  /**
   * Send message to user
   */
  async sendMessage(openId: string, text: string): Promise<boolean> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      return true;
    } catch (error: any) {
      console.error('Failed to send message:', error?.message || error);
      return false;
    }
  }

  /**
   * Send streaming message with card update support
   * Returns message_id for updating
   */
  async sendStreamingStart(openId: string, initialText: string = '🤔 Thinking...'): Promise<string | null> {
    console.log(`[FeishuHandler] Creating interactive card v2 for ${openId}`);
    try {
      const result = await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'interactive',
          content: JSON.stringify({
            schema: '2.0',
            body: {
              elements: [
                {
                  tag: 'markdown',
                  content: initialText,
                },
              ],
            },
          }),
        },
      });
      return result?.data?.message_id || null;
    } catch (error: any) {
      console.error('Failed to send streaming start:', error?.message || error);
      return null;
    }
  }

  /**
   * Serialize async operations per messageId to prevent race conditions.
   * Concurrent calls for the same messageId will queue and execute in order.
   */
  private async withMessageLock<T>(messageId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.messageLocks.get(messageId) || Promise.resolve();
    const current = previous.then(fn, fn); // Run fn after previous completes (even if it failed)
    this.messageLocks.set(messageId, current);
    try {
      return await current;
    } finally {
      // Clean up lock if this is still the latest operation
      if (this.messageLocks.get(messageId) === current) {
        this.messageLocks.delete(messageId);
      }
    }
  }

  /**
   * Split text into chunks that fit within Feishu's message size limit
   * Tries to split at newlines to keep context intact
   *
   * Reserves space for continuation indicators:
   * - "~➡️ Continued in next message...~" (40 chars) at end of non-final chunks
   * - "~⬅️ Continued from previous message...~" (44 chars) at start of continuation chunks
   */
  private splitTextIntoChunks(text: string, limit: number = this.FEISHU_MESSAGE_LIMIT): string[] {
    // Reserve space for continuation indicator
    const continuationOverhead = 50; // "\n\n_➡️ Continued in next message..._"
    const effectiveLimit = limit - continuationOverhead;

    if (text.length <= limit) {
      return [text];
    }

    const chunks: string[] = [];
    let remainingText = text;

    while (remainingText.length > 0) {
      if (remainingText.length <= limit) {
        chunks.push(remainingText);
        break;
      }

      // Try to find a good split point (newline, space, or just at limit)
      let splitPoint = effectiveLimit;

      // Look for last newline before limit
      const lastNewline = remainingText.lastIndexOf('\n', effectiveLimit);
      if (lastNewline > effectiveLimit * 0.7) { // Only split at newline if it's not too far back
        splitPoint = lastNewline + 1;
      } else {
        // Look for last space before limit
        const lastSpace = remainingText.lastIndexOf(' ', effectiveLimit);
        if (lastSpace > effectiveLimit * 0.8) { // Only split at space if it's close to limit
          splitPoint = lastSpace + 1;
        }
      }

      chunks.push(remainingText.substring(0, splitPoint));
      remainingText = remainingText.substring(splitPoint);
    }

    return chunks;
  }

  /**
   * Split Card 2.0 elements into chunks based on Feishu limits
   *
   * Feishu Card 2.0 has two main limits:
   * 1. Element count: Max 200 tagged nodes per card (we use 150 for safety)
   * 2. Data size: Max 3,000,000 characters in the data field (JSON.stringify result)
   *
   * This function splits elements array into chunks that satisfy both limits,
   * and adds continuation indicators between chunks for better UX.
   *
   * Note: Element counting uses recursive tag counting - all nodes with 'tag' property
   * are counted, including nested components, text elements, and container children.
   *
   * @param elements Array of Feishu Card 2.0 elements
   * @returns Array of element chunks, each satisfying Feishu's limits
   */
  private splitElementsIntoChunks(elements: any[]): any[][] {
    // If empty or very small, return as-is
    if (elements.length === 0) {
      return [elements];
    }

    // Check if we need to split at all
    const needsSplitting = this.checkIfElementsNeedSplitting(elements);
    console.log(`[FeishuHandler] Elements check: count=${elements.length}, needsSplitting=${needsSplitting}`);

    if (!needsSplitting) {
      return [elements];
    }

    const chunks: any[][] = [];
    let currentChunk: any[] = [];
    let currentChunkSize = 0;
    let currentChunkTaggedNodes = 0;

    // Reserve elements for continuation indicators (they add ~2 elements and ~200 bytes)
    const continuationIndicatorSize = 200; // Approximate size of indicator element
    const continuationIndicatorCount = 2; // Maximum 2 indicators per chunk (start + end)

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      const elementSize = JSON.stringify(element).length;
      const elementTaggedNodes = this.countTaggedNodes(element);

      // Check if adding this element would exceed limits
      // Reserve space for continuation indicators
      const wouldExceedElementLimit =
        currentChunkTaggedNodes + elementTaggedNodes > (this.CARD_ELEMENT_LIMIT - continuationIndicatorCount);
      const wouldExceedSizeLimit =
        currentChunkSize + elementSize + continuationIndicatorSize >
        (this.CARD_DATA_SIZE_LIMIT - this.CARD_SIZE_BUFFER);

      if (currentChunk.length > 0 && (wouldExceedElementLimit || wouldExceedSizeLimit)) {
        // Start a new chunk
        chunks.push(currentChunk);
        console.log(`[FeishuHandler] Chunk finished: ${currentChunk.length} top-level elements, ${currentChunkTaggedNodes} tagged nodes, ${currentChunkSize} bytes`);
        currentChunk = [];
        currentChunkSize = 0;
        currentChunkTaggedNodes = 0;
      }

      currentChunk.push(element);
      currentChunkSize += elementSize;
      currentChunkTaggedNodes += elementTaggedNodes;
    }

    // Add the last chunk if not empty
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
      console.log(`[FeishuHandler] Chunk finished: ${currentChunk.length} top-level elements, ${currentChunkTaggedNodes} tagged nodes, ${currentChunkSize} bytes`);
    }

    console.log(`[FeishuHandler] Split ${elements.length} top-level elements into ${chunks.length} chunk(s)`);
    chunks.forEach((chunk, i) => {
      const chunkSize = JSON.stringify({ schema: '2.0', body: { elements: chunk } }).length;
      const chunkTaggedNodes = chunk.reduce((sum, el) => sum + this.countTaggedNodes(el), 0);
      console.log(`[FeishuHandler]   Chunk ${i + 1}: ${chunk.length} top-level, ${chunkTaggedNodes} tagged nodes, ${chunkSize} bytes`);
    });

    // Add continuation indicators between chunks
    if (chunks.length > 1) {
      for (let i = 0; i < chunks.length; i++) {
        const isFirst = i === 0;
        const isLast = i === chunks.length - 1;

        if (!isLast) {
          // Add "continued in next message" indicator at the end
          chunks[i].push({
            tag: 'markdown',
            content: '\n\n_➡️ Continued in next message..._',
          });
        }

        if (!isFirst) {
          // Add "continued from previous message" indicator at the start
          chunks[i].unshift({
            tag: 'markdown',
            content: '_⬅️ Continued from previous message..._\n\n',
          });
        }
      }
    }

    return chunks;
  }

  /**
   * Recursively count all nodes with 'tag' property in the element tree
   * According to Feishu docs, all nodes with 'tag' property count towards the 200 limit
   *
   * @param obj The object or array to count tags in
   * @returns Total count of nodes with 'tag' property
   */
  private countTaggedNodes(obj: any): number {
    if (!obj || typeof obj !== 'object') {
      return 0;
    }

    let count = 0;

    // If this object has a 'tag' property, count it
    if (obj.tag) {
      count = 1;
    }

    // Recursively count in all properties
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const value = obj[key];
        if (Array.isArray(value)) {
          // Recursively count in array elements
          for (const item of value) {
            count += this.countTaggedNodes(item);
          }
        } else if (typeof value === 'object' && value !== null) {
          // Recursively count in nested objects
          count += this.countTaggedNodes(value);
        }
      }
    }

    return count;
  }

  /**
   * Check if elements array needs to be split based on Feishu limits
   * @param elements Array of elements to check
   * @returns true if splitting is needed
   */
  private checkIfElementsNeedSplitting(elements: any[]): boolean {
    // Safety check: ensure elements is an array
    if (!Array.isArray(elements)) {
      console.error('[FeishuHandler] checkIfElementsNeedSplitting received non-array:', typeof elements);
      return false;
    }

    // Check element count limit - MUST count ALL nodes with 'tag' property recursively
    const totalTaggedNodes = elements.reduce((sum, element) => sum + this.countTaggedNodes(element), 0);

    console.log(`[FeishuHandler] Element count check: top-level=${elements.length}, total tagged nodes=${totalTaggedNodes}, limit=${this.CARD_ELEMENT_LIMIT}`);

    if (totalTaggedNodes > this.CARD_ELEMENT_LIMIT) {
      console.log(`[FeishuHandler] Total tagged nodes (${totalTaggedNodes}) exceeds limit (${this.CARD_ELEMENT_LIMIT})`);
      return true;
    }

    // Check data size limit
    const cardData = {
      schema: '2.0',
      body: { elements },
    };
    const jsonSize = JSON.stringify(cardData).length;
    const sizeLimit = this.CARD_DATA_SIZE_LIMIT - this.CARD_SIZE_BUFFER;

    console.log(`[FeishuHandler] Card data size: ${jsonSize} bytes, limit: ${sizeLimit} bytes`);

    // Use buffer for safety (2.9MB instead of 3MB)
    if (jsonSize > sizeLimit) {
      console.log(`[FeishuHandler] Data size (${jsonSize}) exceeds limit (${sizeLimit})`);
      return true;
    }

    return false;
  }

  /**
   * Create a continuation card message
   * Used when elements need to be split across multiple cards
   *
   * @param openId User's open_id to send the message to
   * @param elements Array of Feishu Card 2.0 elements
   * @returns The new message ID, or null on error
   */
  private async createContinuationCard(openId: string, elements: any[]): Promise<string | null> {
    try {
      const result = await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'interactive',
          content: JSON.stringify({
            schema: '2.0',
            body: {
              elements,
            },
          }),
        },
      });

      return result.data?.message_id || null;
    } catch (error: any) {
      console.error('Failed to create continuation card:', error?.message || error);
      return null;
    }
  }

  /**
   * Update streaming message content
   * Automatically creates new messages if content exceeds Feishu's size limit
   *
   * This method uses an incremental approach to prevent content duplication:
   * - Once a message (except the last one) is created, its content is frozen
   * - Only the last message in the chain gets updated with new content
   * - New messages are only created when the last message exceeds the limit
   *
   * @param messageId The Feishu message ID
   * @param elements Array of Feishu Card 2.0 elements
   * @param openId User's open_id for creating continuation messages
   */
  async updateStreamingMessage(messageId: string, elements: any[], openId?: string): Promise<boolean> {
    return this.withMessageLock(messageId, () => this._updateStreamingMessage(messageId, elements, openId));
  }

  private async _updateStreamingMessage(messageId: string, elements: any[], openId?: string): Promise<boolean> {
    try {
      // Get or initialize message chain
      let chain = this.messageChains.get(messageId);
      if (!chain) {
        chain = [messageId]; // First message in chain
        this.messageChains.set(messageId, chain);
      }

      // Split elements into chunks based on Feishu Card 2.0 limits
      const chunks = this.splitElementsIntoChunks(elements);
      console.log(`[FeishuHandler] Need ${chunks.length} card(s), currently have ${chain.length} card(s)`);

      // Update the first message with the first chunk
      await this.client.im.message.patch({
        path: { message_id: chain[0] },
        data: {
          content: JSON.stringify({
            schema: '2.0',
            body: {
              elements: chunks[0],
            },
          }),
        },
      });

      // Handle continuation chunks: only create new cards, never delete during streaming.
      // Deleting a card causes Feishu UI to show "message retracted" which is confusing.
      // Any excess continuation cards are left with stale content until finalize cleans them up.
      if (chunks.length > 1 && openId) {
        const existingContinuationCards = chain.slice(1);
        const neededContinuationCards = chunks.length - 1;

        // Update existing continuation cards
        for (let i = 0; i < Math.min(existingContinuationCards.length, neededContinuationCards); i++) {
          const cardMessageId = existingContinuationCards[i];
          const chunkIndex = i + 1;
          await this.client.im.message.patch({
            path: { message_id: cardMessageId },
            data: {
              content: JSON.stringify({
                schema: '2.0',
                body: {
                  elements: chunks[chunkIndex],
                },
              }),
            },
          });
        }

        // Create new continuation cards if needed
        if (neededContinuationCards > existingContinuationCards.length) {
          console.log(`[FeishuHandler] Creating ${neededContinuationCards - existingContinuationCards.length} new continuation card(s)`);
          for (let i = existingContinuationCards.length; i < neededContinuationCards; i++) {
            const chunkIndex = i + 1;
            const newMessageId = await this.createContinuationCard(openId, chunks[chunkIndex]);
            if (newMessageId) {
              chain.push(newMessageId);
            }
          }
        }

        this.messageChains.set(messageId, chain);
      }

      return true;
    } catch (error: any) {
      console.error('Failed to update streaming message:', error?.message || error);
      return false;
    }
  }

  /**
   * Finalize streaming message
   * Automatically creates new messages if content exceeds Feishu's size limit
   *
   * @param messageId The Feishu message ID
   * @param elements Array of Feishu Card 2.0 elements
   * @param sessionAbbr Optional session abbreviation
   * @param openId User's open_id for creating continuation messages
   */
  async finalizeStreamingMessage(messageId: string, elements: any[], sessionAbbr?: string, openId?: string, cwd?: string): Promise<boolean> {
    return this.withMessageLock(messageId, () => this._finalizeStreamingMessage(messageId, elements, sessionAbbr, openId, cwd));
  }

  private async _finalizeStreamingMessage(messageId: string, elements: any[], sessionAbbr?: string, openId?: string, cwd?: string): Promise<boolean> {
    try {
      // Build completion note
      let noteContent = '✅ Completed';
      if (sessionAbbr) {
        noteContent += ` · Session: ${sessionAbbr}`;
      }
      if (cwd) {
        const formattedCwd = cwd.replace(process.env.HOME || '/Users', '~');
        noteContent += `\n📂 **Working Directory:** \`${formattedCwd}\``;
      }

      const finalElements = [
        ...elements,
        { tag: 'markdown', content: noteContent },
      ];

      // Reuse streaming update logic: only create cards, never delete.
      // Whatever layout was built during streaming stays as-is.
      await this._updateStreamingMessage(messageId, finalElements, openId);

      // Clean up tracking state
      this.messageChains.delete(messageId);
      this.lastProcessedLengths.delete(messageId);

      return true;
    } catch (error: any) {
      console.error('Failed to finalize streaming message:', error?.message || error);
      return false;
    }
  }

  /**
   * Start the Feishu WebSocket long connection
   */
  async start(): Promise<void> {
    try {
      console.log('Starting Feishu WebSocket long connection...');

      // Create WSClient with event dispatcher
      this.wsClient = new lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });

      // Start WebSocket client with event handler
      await this.wsClient.start({
        eventDispatcher: new lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data: any) => {
            await this.handleMessageEvent(data);
          }
        })
      });

      console.log('✅ Feishu WebSocket long connection established');
      console.log('   Listening for messages from Feishu...');
    } catch (error) {
      console.error('Failed to start Feishu WebSocket connection:', error);
      throw error;
    }
  }

  /**
   * Stop the Feishu connection
   */
  async stop(): Promise<void> {
    try {
      console.log('Stopping Feishu WebSocket connection...');

      // Close WebSocket connection
      if (this.wsClient) {
        // The SDK doesn't provide a stop method, but closing the instance should work
        this.wsClient = null;
      }

      await this.bindingManager.close();
      console.log('✅ Feishu WebSocket connection stopped');
    } catch (error) {
      console.error('Error stopping Feishu WebSocket connection:', error);
      throw error;
    }
  }

  /**
   * Get BindingManager instance
   */
  getBindingManager(): BindingManager {
    return this.bindingManager;
  }
}
