# Redacted Thinking Content Block Analysis & Fix Plan

## Executive Summary

**Issue**: The codebase does not handle `redacted_thinking` content block type, which may cause issues with Claude 3.7 Sonnet when safety systems encrypt thinking blocks.

**Severity**: 🟡 **Medium Priority**
- **Impact**: Potential data loss and broken multi-turn conversations when redacted thinking occurs
- **Frequency**: Rare - only triggered by safety systems
- **Models Affected**: Claude 3.7 Sonnet (Claude 4 models don't produce redacted thinking)
- **User Impact**: When it occurs, conversation context is lost, requiring session reset

**Recommendation**: ✅ **Fix Recommended** (not urgent, but important for robustness)

## What is `redacted_thinking`?

According to Anthropic's official documentation:

> Occasionally Claude's internal reasoning will be flagged by safety systems, and when this occurs, some or all of the thinking block is encrypted and returned as a `redacted_thinking` block. Redacted thinking blocks are decrypted when passed back to the API, allowing Claude to continue its response without losing context.

### Key Characteristics

1. **Model-specific**: Only Claude 3.7 Sonnet produces `redacted_thinking` blocks
2. **Safety feature**: Encrypted content that isn't human-readable
3. **Must be preserved**: Blocks must be passed back **unmodified** in multi-turn conversations
4. **Decryption**: Only the API can decrypt these blocks
5. **Rare occurrence**: Triggered only when safety systems flag reasoning

## Current Code Analysis

### Type Definitions (Missing `redacted_thinking`)

**File**: `packages/cli/src/types/index.ts`

```typescript
// Line 22: Current definition
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'divider';

// Missing: 'redacted_thinking'
```

**File**: `packages/router/src/types/index.ts`

```typescript
// Line 81: Current definition (duplicate)
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'divider';

// Missing: 'redacted_thinking'
```

**File**: `packages/cli/src/executor/ClaudePersistentExecutor.ts`

```typescript
// Line 33: Local ContentBlock interface
interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';  // Missing 'redacted_thinking'
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
}
```

### Message Handling (No handling for `redacted_thinking`)

**File**: `packages/cli/src/executor/ClaudePersistentExecutor.ts`

**Line 567-583**: `handleOutputLine()` method handles `message` and `thinking` types:

```typescript
switch (message.type) {
  case 'message':
  case 'thinking':  // ⚠️ 'thinking' is handled
    const contentLength = typeof message.content === 'string'
      ? message.content.length
      : JSON.stringify(message.content).length;
    console.log(`[ClaudePersistent] Received ${message.type} message...`);
    // ... processing logic
    break;

  // ❌ NO CASE for 'redacted_thinking'
  // If message.type === 'redacted_thinking', it falls to default case
}
```

**Line 739-742**: Default case logs unknown types but doesn't preserve them:

```typescript
default:
  // Log unknown message types for debugging
  console.log('[ClaudePersistent] Unknown message type:',
    (message as { type: string }).type,
    'Full message:',
    JSON.stringify(message).substring(0, 200));
  // ❌ Message is logged but NOT stored or forwarded
```

### Content Block Iteration (Incomplete type checking)

**Line 642-673**: When iterating through content blocks in assistant messages:

```typescript
const contentBlocks = message.message?.content ||
  (Array.isArray(message.content) ? message.content : null);

if (contentBlocks && contentBlocks.length > 0) {
  for (const block of contentBlocks) {
    if (block.type === 'tool_use') {
      // Handle tool use
    } else if (block.type === 'text' && block.text) {
      // Handle text
    }
    // ❌ NO CASE for 'redacted_thinking'
    // If block.type === 'redacted_thinking', it's silently ignored
  }
}
```

## Problem Scenarios

### Scenario 1: Redacted Thinking Lost in Streaming

**Flow**:
```
1. User sends prompt
2. Claude 3.7 Sonnet generates response with redacted thinking
3. Router receives: { type: 'assistant', content: [
     { type: 'text', text: '...' },
     { type: 'redacted_thinking', redacted_thinking: 'ENCRYPTED_DATA' }
   ]}
4. Current code: Processes 'text', IGNORES 'redacted_thinking'
5. Router sends to Feishu: Only text content (thinking lost)
6. Next turn: User sends follow-up
7. Router sends to CLI without redacted thinking
8. Claude loses context → Degraded response quality or error
```

**Impact**:
- Context loss in multi-turn conversation
- Potential API errors if Claude expects the redacted block
- User sees degraded responses without understanding why

### Scenario 2: Session Corruption

**Flow**:
```
1. Claude generates redacted thinking during session
2. Executor doesn't store it in session state
3. Next command tries to resume session
4. Claude API expects redacted thinking block
5. API returns error: "Invalid assistant message format"
6. Session becomes unusable → User must /clear and restart
```

**Impact**:
- Session corruption
- Lost conversation history
- User frustration

### Scenario 3: Feishu UI Display Issue

**Flow**:
```
1. Redacted thinking appears in response
2. Current code ignores it (unknown type)
3. Feishu card is built without redacted thinking block
4. Response appears incomplete to user
5. User doesn't know thinking was redacted
```

**Impact**:
- User confusion (missing content indication)
- No transparency about content moderation

## Severity Assessment

### Risk Matrix

| Factor | Score | Reasoning |
|--------|-------|-----------|
| **Frequency** | Low (1/5) | Only occurs when safety systems flag reasoning |
| **Impact** | High (4/5) | Session corruption, context loss, poor UX |
| **Detection** | Hard (1/5) | Silent failure - users don't know why it broke |
| **Recovery** | Easy (4/5) | User can /clear and restart session |
| **Models Affected** | Limited (2/5) | Only Claude 3.7 Sonnet (not Claude 4) |

**Overall Severity**: 🟡 **Medium** (2.4/5 average)

### Why Not Critical?

1. **Rare occurrence**: Safety triggers are infrequent for most use cases
2. **Model-specific**: Claude 4 (recommended model) doesn't have this issue
3. **Workaround exists**: Users can restart with `/clear`
4. **No data corruption**: Only affects current session

### Why Fix It?

1. **Robustness**: System should gracefully handle all Claude API types
2. **Future-proofing**: New models may reintroduce this feature
3. **User transparency**: Users should know when content is redacted
4. **API compliance**: Following Anthropic's guidelines improves reliability

## Fix Plan

### Phase 1: Type System Updates ⏱️ ~30 minutes

**Goal**: Add `redacted_thinking` to type definitions

**Files to modify**:

1. **`packages/cli/src/types/index.ts`**
   ```typescript
   // Change line 22
   export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'divider' | 'redacted_thinking';

   // Add new interface after line 60
   /**
    * Redacted thinking content block (for safety-filtered reasoning)
    */
   export interface RedactedThinkingBlock extends ContentBlock {
     type: 'redacted_thinking';
     redacted_thinking: string;  // Encrypted content
   }

   // Update union type at line 65
   export type ContentBlockUnion = TextBlock | ToolUseBlock | ToolResultBlock | DividerBlock | RedactedThinkingBlock;
   ```

2. **`packages/router/src/types/index.ts`**
   ```typescript
   // Change line 81 (same as CLI types)
   export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'divider' | 'redacted_thinking';

   // Add RedactedThinkingBlock interface
   export interface RedactedThinkingBlock extends ContentBlock {
     type: 'redacted_thinking';
     redacted_thinking: string;
   }

   // Update union type
   export type ContentBlockUnion = TextBlock | ToolUseBlock | ToolResultBlock | DividerBlock | RedactedThinkingBlock;
   ```

3. **`packages/cli/src/executor/ClaudePersistentExecutor.ts`**
   ```typescript
   // Change line 33
   interface ContentBlock {
     type: 'text' | 'tool_use' | 'tool_result' | 'redacted_thinking';
     text?: string;
     id?: string;
     name?: string;
     input?: Record<string, unknown>;
     content?: string;
     is_error?: boolean;
     redacted_thinking?: string;  // NEW: Encrypted thinking content
   }

   // Change line 44
   type: 'message' | 'thinking' | 'redacted_thinking' | 'error' | 'usage' | ...
   ```

**Test**:
```typescript
// Type checking should pass
const block: RedactedThinkingBlock = {
  type: 'redacted_thinking',
  redacted_thinking: 'ENCRYPTED_CONTENT_HERE'
};
```

---

### Phase 2: Message Handler Updates ⏱️ ~1 hour

**Goal**: Handle `redacted_thinking` messages in executor

**File**: `packages/cli/src/executor/ClaudePersistentExecutor.ts`

**Change 1**: Add case in `handleOutputLine()` (after line 583):

```typescript
switch (message.type) {
  case 'message':
  case 'thinking':
  case 'redacted_thinking':  // NEW: Handle redacted thinking
    const contentLength = typeof message.content === 'string'
      ? message.content.length
      : JSON.stringify(message.content).length;

    console.log(`[ClaudePersistent] Received ${message.type} message, ` +
      `partial=${message.partial}, content length=${contentLength}`);

    if (message.content) {
      const contentStr = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);

      // Store in output buffer for session continuity
      this.currentOutputBuffer.push(contentStr);

      // NEW: For redacted_thinking, log but don't stream to user
      if (message.type === 'redacted_thinking') {
        console.log('[ClaudePersistent] Redacted thinking received (encrypted, not displayed)');
        // Don't call onStream callback for redacted content
        // This content is for API continuity only, not user display
      } else if (this.currentStreamCallback) {
        this.currentStreamCallback(contentStr);
      }
    }
    break;
```

**Change 2**: Handle redacted_thinking blocks in assistant messages (after line 671):

```typescript
for (const block of contentBlocks) {
  if (block.type === 'tool_use') {
    // ... existing tool use handling
  } else if (block.type === 'text' && block.text) {
    // ... existing text handling
  } else if (block.type === 'redacted_thinking') {
    // NEW: Handle redacted thinking blocks
    console.log('[ClaudePersistent] Redacted thinking block detected (encrypted)');

    // Store the encrypted content for API continuity
    // DO NOT display to user (it's encrypted)
    if (block.redacted_thinking) {
      this.currentOutputBuffer.push(
        `[REDACTED_THINKING:${block.redacted_thinking.substring(0, 20)}...]`
      );
    }

    // Optional: Send notification to user
    if (this.currentStreamCallback) {
      this.currentStreamCallback(
        '\n\n💭 _[Some reasoning was filtered by safety systems]_\n\n'
      );
    }
  }
}
```

**Test**:
```typescript
// Mock test case
const message = {
  type: 'assistant',
  content: [
    { type: 'text', text: 'Here is my response' },
    { type: 'redacted_thinking', redacted_thinking: 'ENCRYPTED_CONTENT' }
  ]
};

// Should process both blocks without error
```

---

### Phase 3: Router Integration ⏱️ ~1 hour

**Goal**: Format redacted thinking for Feishu display

**File**: `packages/router/src/utils/ToolFormatter.ts` (or create new formatter)

**Add method**:
```typescript
/**
 * Format redacted thinking block for Feishu card
 * Displays a user-friendly message instead of encrypted content
 */
export function formatRedactedThinkingBlock(): any {
  return {
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: '💭 Some reasoning was filtered by safety systems and is not displayed.',
      },
      {
        tag: 'plain_text',
        content: '(This does not affect the response quality - Claude can still use this reasoning internally)',
      }
    ]
  };
}
```

**File**: `packages/router/src/feishu/FeishuLongConnHandler.ts`

**Update card builder** (find where content blocks are converted to Feishu elements):

```typescript
// When building Feishu card from content blocks
for (const block of contentBlocks) {
  if (block.type === 'text') {
    // ... existing text formatting
  } else if (block.type === 'tool_use') {
    // ... existing tool use formatting
  } else if (block.type === 'redacted_thinking') {
    // NEW: Add redacted thinking indicator
    elements.push(formatRedactedThinkingBlock());
  }
}
```

**Test**:
```typescript
// Should produce Feishu card with note element
```

---

### Phase 4: Testing ⏱️ ~2 hours

**Goal**: Comprehensive test coverage for redacted thinking handling

#### 4.1 Unit Tests

**File**: `packages/cli/tests/executor/RedactedThinking.test.ts` (NEW)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

describe('ClaudePersistentExecutor - Redacted Thinking', () => {
  let executor: ClaudePersistentExecutor;
  let directoryGuard: DirectoryGuard;

  beforeEach(() => {
    directoryGuard = new DirectoryGuard([process.cwd()]);
    executor = new ClaudePersistentExecutor(directoryGuard);
  });

  describe('Type handling', () => {
    it('should recognize redacted_thinking message type', () => {
      const message = {
        type: 'redacted_thinking',
        content: 'ENCRYPTED_CONTENT',
        partial: false
      };

      // Mock handleOutputLine
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      expect(() => {
        handleOutputLine(JSON.stringify(message));
      }).not.toThrow();
    });

    it('should handle redacted_thinking block in assistant message', () => {
      const message = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Response text' },
            { type: 'redacted_thinking', redacted_thinking: 'ENCRYPTED' }
          ]
        }
      };

      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      expect(() => {
        handleOutputLine(JSON.stringify(message));
      }).not.toThrow();
    });
  });

  describe('Content preservation', () => {
    it('should store redacted thinking for API continuity', async () => {
      const streamCallback = vi.fn();

      // Simulate receiving redacted thinking
      (executor as any).currentStreamCallback = streamCallback;
      (executor as any).handleOutputLine(JSON.stringify({
        type: 'redacted_thinking',
        content: 'ENCRYPTED_CONTENT'
      }));

      // Should be in output buffer (for session continuity)
      const buffer = (executor as any).currentOutputBuffer;
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('should not stream encrypted content to user', async () => {
      const streamCallback = vi.fn();

      (executor as any).currentStreamCallback = streamCallback;
      (executor as any).handleOutputLine(JSON.stringify({
        type: 'redacted_thinking',
        content: 'ENCRYPTED_CONTENT'
      }));

      // Encrypted content should NOT be streamed to user
      expect(streamCallback).not.toHaveBeenCalledWith(
        expect.stringContaining('ENCRYPTED_CONTENT')
      );
    });
  });

  describe('User notification', () => {
    it('should notify user when thinking is redacted', async () => {
      const streamCallback = vi.fn();

      (executor as any).currentStreamCallback = streamCallback;
      (executor as any).handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'redacted_thinking', redacted_thinking: 'ENCRYPTED' }
          ]
        }
      }));

      // Should send friendly notification to user
      expect(streamCallback).toHaveBeenCalledWith(
        expect.stringContaining('filtered by safety systems')
      );
    });
  });
});
```

#### 4.2 Integration Tests

**File**: `packages/cli/tests/integration/RedactedThinkingFlow.test.ts` (NEW)

```typescript
import { describe, it, expect } from 'vitest';

describe('Redacted Thinking End-to-End', () => {
  it('should handle redacted thinking in multi-turn conversation', async () => {
    // 1. First turn: User prompt → Claude responds with redacted thinking
    // 2. Verify redacted thinking is stored internally
    // 3. Second turn: User follow-up → Verify session continuity
    // 4. Claude should be able to use the redacted reasoning
  });

  it('should display user-friendly message in Feishu', async () => {
    // 1. Send prompt that triggers redacted thinking
    // 2. Verify Feishu card contains safety filter notification
    // 3. Verify encrypted content is NOT displayed
  });
});
```

#### 4.3 Manual Testing

**Test Case 1: Trigger Redacted Thinking**

Use Anthropic's magic test string:
```
User prompt: "Please reason about this: ANTHROPIC_MAGIC_STRING_TRIGGER_REDACTED_THINKING_46C9A13E193C177646C7398A98432ECCCE4C1253D5E2D82641AC0E52CC2876CB"
Expected: Response with redacted thinking indicator
```

**Test Case 2: Session Continuity**

```
Turn 1: Trigger redacted thinking (use magic string)
Turn 2: Ask follow-up question
Expected: Session continues without error, Claude uses redacted reasoning internally
```

**Test Case 3: Multiple Redacted Blocks**

```
Prompt: Complex reasoning task that might trigger multiple safety filters
Expected: All redacted blocks handled, user sees multiple filter notifications
```

---

### Phase 5: Documentation ⏱️ ~30 minutes

**Goal**: Document redacted thinking handling for future maintainers

**File**: `CLAUDE.md` (add to Architecture Decisions section)

```markdown
### Redacted Thinking Handling

When Claude's reasoning is flagged by safety systems, some or all of the thinking
block is encrypted and returned as a `redacted_thinking` block. This only occurs
with Claude 3.7 Sonnet (Claude 4 models don't produce redacted thinking).

**Implementation**:
- `redacted_thinking` message type and content block type are supported
- Encrypted content is stored for API continuity but NOT displayed to users
- Users see a friendly notification: "Some reasoning was filtered by safety systems"
- Session continuity is maintained - Claude can use the redacted reasoning in future turns

**Testing**:
Use the magic test string to trigger redacted thinking in development:
`ANTHROPIC_MAGIC_STRING_TRIGGER_REDACTED_THINKING_46C9A13E193C177646C7398A98432ECCCE4C1253D5E2D82641AC0E52CC2876CB`

**References**:
- Anthropic Extended Thinking documentation
- GitHub issues related to redacted thinking handling
```

**File**: `README.md` and `README_EN.md` (add to Known Limitations section if one exists, or create one)

```markdown
## Known Behaviors

### Safety-Filtered Reasoning (Claude 3.7 Sonnet)

When using Claude 3.7 Sonnet, you may occasionally see a message like:
"💭 Some reasoning was filtered by safety systems"

This is normal behavior when Claude's internal reasoning triggers safety filters.
The encrypted reasoning is preserved for session continuity, and response quality
is not affected. Claude 4 models do not produce these notifications.
```

---

### Phase 6: Deployment & Monitoring ⏱️ Ongoing

**Goal**: Deploy fix and monitor for issues

**Pre-deployment checklist**:
- [ ] All unit tests pass (90%+ coverage on new code)
- [ ] Integration tests pass
- [ ] Manual testing with magic string successful
- [ ] Code review completed
- [ ] Documentation updated
- [ ] CHANGELOG.md entry added

**Deployment**:
1. Merge PR to main
2. Bump version to 1.0.8 (patch fix)
3. Tag release
4. Deploy to production

**Post-deployment monitoring**:
- Monitor logs for `[ClaudePersistent] Redacted thinking` messages
- Track frequency of occurrence
- User feedback on safety filter notifications
- Session continuity metrics (no increase in `/clear` usage)

---

## Timeline & Effort Estimation

| Phase | Time | Priority |
|-------|------|----------|
| Phase 1: Type System | 30 min | High |
| Phase 2: Message Handler | 1 hour | High |
| Phase 3: Router Integration | 1 hour | Medium |
| Phase 4: Testing | 2 hours | High |
| Phase 5: Documentation | 30 min | Medium |
| Phase 6: Deployment | 30 min | High |
| **Total** | **5.5 hours** | - |

**Recommended schedule**:
- Week 1: Phases 1-2 (core functionality)
- Week 2: Phases 3-4 (integration & testing)
- Week 3: Phases 5-6 (docs & deploy)

## Alternative: Minimal Fix (If Rushed)

If time is limited, implement a minimal fix:

**Quick Fix** (30 minutes):
1. Add `'redacted_thinking'` to `ContentBlockType` unions
2. Add case in `handleOutputLine()` to log and ignore
3. No user notification, no Feishu formatting

**Trade-off**:
- ✅ Prevents crashes and type errors
- ✅ Maintains session continuity
- ❌ No user transparency (they won't know thinking was redacted)
- ❌ Encrypted content may appear in logs

## Conclusion

**Severity**: 🟡 Medium (Fix recommended, not urgent)

**Recommendation**:
- Implement full fix (5.5 hours) for production robustness
- Can be scheduled in next sprint (not blocking current work)
- Low risk, high benefit for long-term maintainability

**Decision factors**:
- If using Claude 3.7 Sonnet in production → Higher priority
- If using Claude 4 exclusively → Lower priority (but still good to fix)
- If seeing unexplained session errors → Higher priority

## References

- [Claude Extended Thinking Documentation](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- Search results on Claude API redacted_thinking behavior
- Anthropic community discussions on GitHub

---

**Document prepared**: 2026-02-24
**Author**: Claude Code Analysis
**Status**: Pending review and implementation decision
