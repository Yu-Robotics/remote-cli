# Fix Plan: Device ID Collision Bug

## Problem Statement

The router currently allows the same `deviceId` to be bound to multiple users simultaneously. This creates a **critical security and routing bug** where:
- Multiple users believe they control the same device
- Messages from different users are sent to the same device
- Device responses cannot be correctly attributed to the originating user
- This enables cross-user data leakage

## Proposed Solution

### Option 1: Strict One-Device-Per-User Policy (RECOMMENDED)

Prevent a device from being bound to multiple users. Each device can only be owned by one user at a time.

**Implementation**:
```typescript
// In BindingManager.ts:bindUser()

async bindUser(openId: string, deviceId: string, deviceName: string): Promise<void> {
  const now = Date.now();

  // CHECK: Is this device already bound to a DIFFERENT user?
  const existingOwner = this.store.getUserByDeviceId(deviceId);
  if (existingOwner && existingOwner !== openId) {
    throw new Error(
      `Device ${deviceId} is already bound to user ${existingOwner}. ` +
      `Please unbind it first or use a different device.`
    );
  }

  const existingBinding = await this.getUserBinding(openId);

  if (existingBinding) {
    const deviceIndex = existingBinding.devices.findIndex(d => d.deviceId === deviceId);

    if (deviceIndex >= 0) {
      // Update existing device entry (rebinding same device to same user)
      existingBinding.devices[deviceIndex].deviceName = deviceName;
      existingBinding.devices[deviceIndex].lastActiveAt = now;
    } else {
      // Add new device as inactive
      existingBinding.devices.push({
        deviceId,
        deviceName,
        boundAt: now,
        lastActiveAt: now,
        isActive: false,
      });
    }

    // Update device-to-user reverse mapping
    await this.store.setDeviceToUserMap(deviceId, openId);

    existingBinding.updatedAt = now;
    await this.store.setUserBinding(openId, existingBinding);
  } else {
    // First device for this user - set as active
    const binding: UserBinding = {
      openId,
      devices: [{
        deviceId,
        deviceName,
        boundAt: now,
        lastActiveAt: now,
        isActive: true,
      }],
      activeDeviceId: deviceId,
      createdAt: now,
      updatedAt: now,
    };

    // Set device-to-user reverse mapping
    await this.store.setDeviceToUserMap(deviceId, openId);

    await this.store.setUserBinding(openId, binding);
  }
}
```

**Pros**:
- Simple to implement
- Clear security boundaries
- Prevents data leakage
- Easy to reason about

**Cons**:
- Users cannot share devices
- If user A wants to transfer device to user B, must unbind first

### Option 2: Allow Device Sharing with Proper Routing

If device sharing is a required feature, implement proper request/response tracking.

**Implementation** (HIGH COMPLEXITY):
1. Add `originatingUserId` to every command message
2. Track command->user mapping in RouterServer:
   ```typescript
   private commandOwnership: Map<string, string>; // messageId -> openId
   ```
3. When sending command to device, store the mapping:
   ```typescript
   this.commandOwnership.set(messageId, openId);
   ```
4. When receiving response from device, look up the originating user:
   ```typescript
   const targetUserId = this.commandOwnership.get(responseMessageId);
   await this.feishuLongConnHandler.sendMessage(targetUserId, response);
   this.commandOwnership.delete(responseMessageId);
   ```

**Pros**:
- Allows device sharing
- Maintains proper isolation

**Cons**:
- Much more complex
- Requires significant refactoring
- Need to handle message timeouts (cleanup stale mappings)
- Streaming responses become ambiguous (which user sees which stream chunk?)

## Recommendation

**Implement Option 1 (Strict One-Device-Per-User Policy)**

Reasons:
1. Simple and secure
2. Matches current user expectations (each user has their own devices)
3. Can be implemented quickly
4. If device sharing is needed later, can add a "transfer device" feature

## Implementation Checklist

- [ ] Modify `BindingManager.bindUser()` to check for existing owner
- [ ] Add test for device collision prevention
- [ ] Update Feishu command handler to return friendly error message
- [ ] Update documentation to clarify one-device-per-user policy
- [ ] Add logging for collision attempts (security monitoring)

## Testing Plan

1. **Unit Test**: `BindingManager.test.ts`
   ```typescript
   it('should reject binding device that belongs to another user', async () => {
     await bindingManager.bindUser('user_001', 'dev_shared', 'Device-1');

     await expect(
       bindingManager.bindUser('user_002', 'dev_shared', 'Device-2')
     ).rejects.toThrow(/already bound/);
   });
   ```

2. **Integration Test**: Verify end-to-end behavior with Feishu binding flow

3. **Regression Test**: Ensure same user can still rebind their own device

## Migration Strategy

For existing deployments with shared devices:
1. Add migration script to detect device collisions
2. Assign each collided device to the user who bound it first
3. Notify other users their device binding was removed
4. Provide UI to re-bind with a different device ID

## Timeline

- Implementation: 2-4 hours
- Testing: 2-3 hours
- Code review + deployment: 1-2 hours
- **Total**: 0.5-1 day

## Related Files

- `packages/router/src/binding/BindingManager.ts` - Main fix
- `packages/router/src/storage/JsonStore.ts` - Already has `getUserByDeviceId()`
- `packages/router/tests/BindingManager.test.ts` - Add tests
- `packages/router/tests/integration/ConcurrentRouting.focused.test.ts` - Already has test case
