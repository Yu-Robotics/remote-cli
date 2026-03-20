# Test Suite Review Findings

I have reviewed the current state of the test suite (which passes 100%, 859 tests total). However, I identified several areas for improvement:

1. **Console Noise (Expected Errors Leaking to stderr/stdout):**
   Many tests intentionally trigger error paths but fail to mock or suppress `console.error` and `console.warn`. This causes `npm test` output to be extremely noisy, making it difficult to spot real failures.
   *Affected files include:*
   - `packages/cli/tests/ClaudePersistentExecutor.parseError.test.ts`
   - `packages/cli/tests/ClaudePersistentExecutor.test.ts`
   - `packages/cli/tests/executor/GeminiExecutor.test.ts`
   - `packages/cli/tests/MessageHandler.test.ts`
   - `packages/router/tests/JsonStore.test.ts`
   - `packages/router/tests/FeishuLongConnHandler.test.ts`
   *Recommendation:* Use `vi.spyOn(console, 'error').mockImplementation(() => {})` in `beforeEach` (or within specific tests) and verify the errors are logged correctly without cluttering the test runner output.

2. **Flaky Async Behavior in GeminiExecutor:**
   In `packages/cli/tests/executor/GeminiExecutor.test.ts`, tests handling aborts or timeouts (e.g., `should return true on abort when in-flight and send ACP cancel before force-kill`) rely on hardcoded `setTimeout` delays rather than deterministic promise resolution or fake timers (vi.useFakeTimers).
   *Recommendation:* Migrate these to Vitest's fake timers to prevent flakiness in slower CI environments.

3. **Obsolete Terminology in Tests:**
   Since `GeminiExecutor` now uses persistent ACP sessions and dropped the old JSONL text-concatenation approach, the `compactWhenFull` method simply resets the context (destroys the client) rather than actually "compacting" history. While the tests accurately assert this new behavior, the descriptions still read `compactWhenFull() > should stream a status message during compaction`.
   *Recommendation:* Rename these test descriptions to better reflect the new reality (e.g., "should reset the session context when context is full").

Please review these findings. If you agree that these are valid testing issues that should be fixed, please modify the affected test files directly to implement the recommendations. Ensure that all tests still pass after your modifications.