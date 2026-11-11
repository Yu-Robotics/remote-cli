# Native scheduling eligibility recheck

> Historical intermediate review. The [confirmed verdicts](native-scheduling-inventory.md#confirmed-verdicts-for-all-eight-backends) supersede its unverified conclusions and DSH rejection. Keep the source pointers below as investigation history.

Reviewed 2026-11-11 against this checkout and `native-scheduling-inventory.md`.
Eligibility requires both backend-owned timing and autonomous result communication
over the existing transport. Native model tools are an acceptable management path;
missing direct CRUD RPCs alone do not disqualify a backend. Dedicated sessions and
new remote-cli listeners are acceptable; substituting an application scheduler,
periodic model prompts, or an unrelated runtime is not.

**Decision:** none of these six backends has an established complete adapter path
ready to enable now. Mark them **temporarily unsupported**, with the distinctions
below. This is not a claim that their products lack scheduling.

| Backend | Native timing | Existing transport | Decision now |
| --- | --- | --- | --- |
| Codex 0.167.0 | App/web tasks documented; standalone app-server timer/tool unestablished | Persistent app-server notifications and autonomous goals exist; timed occurrence provenance unestablished | Temporarily unsupported: scheduling boundary unknown |
| DSH 0.2.1-rc.5 | Verified first-party scheduler | ACP can emit idle assistant/tool updates, but shipped profile lacks scheduler/controller composition and an autonomous terminal notification is not established | Temporarily unsupported as shipped; custom native composition is a plausible next investigation |
| Kimi 2.5.0 | Verified native Cron tools | Installed ACP server filters autonomous turns out before transmission | Temporarily unsupported on current ACP |
| OpenCode 1.19.5 | Built-in scheduler unestablished; documented scheduler is third-party OS scheduling | ACP execution; native HTTP/SSE events also documented | Temporarily unsupported: native timing unestablished |
| Pi, unavailable locally | CLI-native scheduler unestablished; separate first-party durable runtime has timers | Upstream RPC forwards session events, including extension-initiated activity | Temporarily unsupported: extension/runtime capability is not a verified CLI scheduler |
| ZCode, unavailable locally | Desktop scheduled tasks documented | Local adapter denies Cron tools and ignores idle session events; native headless behavior unknown | Temporarily unsupported pending native verification; do not classify as intrinsically impossible |

## Codex

Official documentation was fetched before inspecting Codex's local implementation:
[CLI scheduling](https://learn.chatgpt.com/docs/automations.md?surface=cli)
explicitly says the CLI lacks the Scheduled management interface and directs users
to web/desktop. [App scheduling](https://learn.chatgpt.com/docs/automations.md?surface=app)
documents task creation from chats and local project execution with the app running.
Neither statement proves that native model-tool scheduling is absent from
app-server. The fetched [app-server reference](https://learn.chatgpt.com/docs/app-server.md)
establishes persistent thread/turn notifications, but no timed occurrence contract.

`codex --version` returned 0.167.0; `codex app-server --help` confirms persistent
stdio/Unix/WebSocket transport. Targeted inspection of the installed binary found
`scheduled_tasks` in remote-plugin metadata and `thread/goal/set`, not an identified
timer-management route. These string checks are supporting evidence, not proof of
absence. `packages/cli/src/executor/CodexAppServerExecutor.ts:1433-1468` already
handles autonomous goal turns. Goals are not timed schedules. Next gate: identify
a native timer tool/service and its occurrence IDs in this exact standalone
app-server, without borrowing the desktop scheduler or introducing polling.

## DSH

Installed package manifest confirms 0.2.1-rc.5. All following pointers are relative
to its installed `node_modules/@deepseek-ai/` packages, not user configuration:

- `dsh-schedule/README.md`, “Use this package”: native after/at/every/daily/weekly/cron,
  persistent tasks, IANA zones, model tools `schedule_create/list/delete/update`.
  Lack of Remote `create` is therefore **not** a rejection reason.
- `dsh-app-boot/lib/index.js:550-556` and `dsh-acp-app/cordis.patch.yml`: shipped ACP
  composes base plus ACP, whereas `dsh-web-app/cordis.patch.yml:120-140` adds the
  Session controller and scheduler. Base already supplies JSONL persistence;
  claiming ACP lacks all persistence would be incorrect.
- `dsh-schedule/lib/index.js:1970-1975` requires `agents`, `sessions`, `storageDomain`,
  `sessionController`, and `sessionPersistence`; delivery resolves the original
  agent and requires a successful Session flush. A delivery receipt is not a
  completed model result.
- **Positive transport finding:** `dsh-acp/lib/index.js:879-927` forwards assistant
  messages and tool events without requiring `inflight`. However, `turn/end` only
  updates an existing prompt's state; no autonomous terminal update appears in
  that projection. `:929-930` joins prompt completion to its admitted message.

remote-cli uses `dsh acp` (`DshExecutor.ts:67`) and turn-scoped callbacks in
`AcpExecutor.ts:609,630,776-839`. A dedicated first-party composition could retain
native timing and ACP output: the controller can resolve a live ordinary ACP
agent (`dsh-api-session-controller/lib/index.js:365-368`). It is not proven that
composition is impossible. Before implementation, verify the supported composition,
tool availability, restart/session ownership, and an authoritative autonomous
completion/correlation signal. Merely mounting the schedule package is insufficient.

## Kimi

`kimi --version` returned 2.5.0. The fetched
[official tools reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/tools.html#scheduled-tasks)
documents CronCreate/List/Delete, one-shot/recurring timing, and session restoration.
Model-mediated create/list/cancel is therefore a viable management concept.

The blocker is upstream transport filtering, not missing CRUD:
[ACP source at commit 41c3414](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/acp-server/src/session.ts#L751)
clears the prompt driver on completion; `driverFor` at lines 758-764 requires the
matching active turn, and assistant/tool handlers at 767-778 drop all other turns.
The installed 2.5.0 executable contains these same `settleDriver`, `driverFor`, and
`onAssistantDelta` bodies, independently corroborating the versioned source.
[Native cron service](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/agent-core-v2/src/features/cron/cronService.ts)
has internal firing events, but those are not proof of ACP delivery.
`KimiExecutor.ts:46-47` uses `kimi acp`. A dedicated session or removal of remote-cli
idle filtering cannot recover events already discarded upstream. Require an
upstream ACP extension/change or a separately verified native transport.

## OpenCode

`opencode --version` returned 1.19.5; `OpenCodeExecutor.ts:77-78` uses ACP. The fetched
[v1.19.5 ecosystem](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/web/src/content/docs/ecosystem.mdx#L45)
lists `opencode-scheduler` as third-party launchd/systemd scheduling. That route
does not meet the native-timing requirement. The versioned
[server contract](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/web/src/content/docs/server.mdx)
provides `/event` and `/global/event` SSE; event communication is not itself a
timer. The fetched versioned tool registry and ACP entry point did not establish
a built-in scheduler. This remains unknown, not a proof of absence. A first-party
timing implementation and a reachable model tool or API are needed before an
adapter can be justified.

## Pi

No local executable was available; upstream v1.5.2 is a reference, not an installed
version claim. [RPC mode](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L362)
forwards subscribed session events without a prompt-only filter.
[Extensions](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/extensions.md)
can initiate idle turns; remote-cli's `PiExecutor.ts:1117-1118` currently discards
events without an active turn. That local limitation is fixable.
However, writing a timer extension would implement scheduling rather than expose
a verified CLI-native scheduler. The separate first-party
[durable harness](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md#sleeping-and-waking-up)
has persisted `sleepUntil` and native timers, but is not the current `pi --mode rpc`
runtime. Do not reject Pi for lack of notifications; the missing gate is native
scheduling in the actual CLI distribution.

## ZCode

The fetched [official automations page](https://zcode.z.ai/en/docs/automations)
documents recurring/one-time tasks and original-chat results, with the app open
and computer awake. It does not establish that headless app-server owns those timers.
No installed version was available to inspect or verify.

`zcode/ZCodeCommand.ts:72` explicitly denies CronCreate/List/Update/Delete.
`zcode/ZCodeClient.ts:375-397` receives session events but returns when no prompt
exists, before handling `turn.started`, streaming, and terminal events. Both are
remote-cli policy/adapter restrictions, not native protocol impossibility.
A dedicated process permitting native Cron tools plus a permanent session-event
listener is a plausible route under the same standard as Claude. First establish
that headless native timers fire and emit those events without the desktop app,
with trustworthy tool receipts and occurrence/terminal correlation. Removing deny
flags alone is not enough, but missing direct CRUD alone must not block this route.

## Verification limits

Read executor code, installed package/source or binary sections, version/help
output, and the linked official/versioned sources. No credentials, user configuration,
or history were read; no models, schedules, installs, or external messages were
run. No native closed-loop or platform tests were performed. Only this report was
added; the inventory and runtime sources remain unchanged.
