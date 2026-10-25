# Illustrated Scenario Tips

## Scope

Version 1.6.178 adds 17 reviewed Chinese scenario tips; 1.6.179 enables daily
delivery by default. Each card teaches one
small decision through a recognizable problem, a concrete benefit, a short action,
a copyable example, and its own static PNG illustration. Content is bundled;
there are no runtime model calls, translation, provider probes, or external content
fetches. The [preview gallery](docs/tips-preview.html) shows the complete library.

## Interaction

`/tips`, `/tips next`, and `/tips list` provide on-demand reading. `/tips settings`
opens subscription controls. Daily delivery is enabled by default. Users can choose
`/tips daily` or `/tips weekly`, with weekly delivery on Tuesday and Thursday.
`/tips mute N` accepts 1-365 days; settings buttons offer 1, 3, 7, or 14 days.
`/tips unmute` only clears mute and cannot resubscribe an opted-out user.
`/tips off` disables automatic delivery until a new explicit subscription.
`/tips timezone <IANA>` selects the user's schedule timezone.

Tips actions only browse content, mark progress, or change Tips preferences.
They never execute the examples or switch backend, model, effort, thread, or device.
Manual browsing requires a current binding but does not require an online CLI.
Commands in examples retain their normal backend/version requirements; old clients
receive a text-command alternative where settings-card support matters.

## Content and illustrations

`packages/router/src/tips/catalog.zh-CN.json` contains the reviewed Chinese
scenario text. `ui.zh-CN.json` contains card labels and messages. Other source,
tests, comments, and technical documentation remain English. Tests use imported
resources or Unicode escapes for localized assertions.

Each of the 17 tips has a stable identifier and a distinct image in
`packages/router/src/tips/assets/`. Each 1600-by-1120 PNG reconstructs the relevant
Feishu settings panel, message, or task-card surface with synthetic content.
Settings illustrations use the actual `SettingsCards` builder with synthetic
fixtures; no account probes, screenshot pixels, or private business data enter
the renderer. Other task-card reconstructions follow the current source labels.
Generate assets with `python3 packages/router/scripts/generate-tip-images.py`.
Development rendering uses a CJK font, Pillow, librsvg/Cairo, and the installed
Node development dependencies; the published Router needs none of these tools.
Editable SVGs are stored in `docs/tips/svg/`. The generator also emits the local
`docs/tips-preview.html` gallery, a contact sheet, and a portable archive containing
all 17 PNG/SVG pairs and an offline gallery. Runtime delivery uses only the PNGs.
`build-tips.cjs` validates bounded content, safe image paths, PNG dimensions, and
asset identity before copying illustrations into the published `dist/tips/assets`.
Every delivered tip requires a successful image upload. An upload failure is a
failed delivery attempt, not a text-only tip.

## Schedule and quiet delivery

The Router evaluates subscribed bound users once per minute. The local target is
10:30; eligible catch-up is limited to 10:30-19:00, inside a 10:00-19:00 daytime
window. The default timezone is explicitly Asia/Shanghai, never the host timezone.
Per-user IANA overrides are supported. At most one automatic attempt is consumed
per local day, with a 20-hour cooldown even across timezone changes.

Automatic delivery requires a currently bound online device, user bot activity
within seven days, and two minutes without new user activity. Router-visible
streaming tasks block delivery across all of the user's devices. This is a
conservative Router observation, not a claim that every backend-local operation,
queue, or approval is idle. No new CLI protocol is introduced.
New activity is observed before waiting for a per-user storage lock, including
while an illustration is uploading, and checked again immediately before dispatch.

Registration and reconnect do not trigger a send. There is no offline backlog.
Seen and mastered tips are skipped; exhausting the catalog stops automatic tips.
The scheduler starts after the Feishu handler starts and stops before transport
shutdown. `tips.enabled: false` globally blocks automatic delivery while preserving
manual browsing, and `tips.timezone` sets the default schedule timezone.

## Persistence and failure behavior

State is per Feishu user, not device or thread. Private preference files live in
the Router configuration directory's `tips/` subdirectory, under hashed names.
Writes are serialized and atomic. Card controls are bound to owner, message,
nonce, expiration, and current preference generation; stale controls cannot
silently restore an old subscription.
Existing records that were off only because of the previous default adopt daily
delivery. Explicit opt-outs remain off; existing mute deadlines, chosen frequencies,
timezones, progress, and delivery cooldowns are preserved.
An old mute button cannot shorten a newer pause; deliberate shorter pauses require
the current settings card or a fresh text command.

Delivery intent is durably reserved before dispatch and marked dispatching before
calling Feishu. Confirmed results retain the card identity. Missing acknowledgements,
exceptions, and a crash during dispatch consume the automatic day/cooldown and
suppress the affected tip rather than replaying an uncertain side effect. Failures
before dispatch can release a reservation. These guarantees assume one Router
process per storage directory; they do not provide multi-replica exactly-once
messaging. Feishu's message UUID is an additional idempotency aid.

Images use an in-memory successful-upload cache. Each cached attempt has a
10-second deadline; failed or hung attempts are evicted so later requests can retry,
and their late results cannot replace a newer cached image.
Card payload history is bounded. Sensitive runtime identifiers remain in private
state and are not copied into catalog, images, examples, or diagnostic messages.

## Verification and rollout

Tests use fake clocks, temporary private storage, and mocked Feishu transport.
They exercise subscription/mute scheduling, deduplication, cross-user controls,
stale cards, uncertain dispatch and restart, image failures, shutdown, content
bounds, and Router command routing. No real user messages or provider calls are
part of development verification. Package builds validate and copy all PNG assets.

Deployment remains an operator action: install the new Router package and restart
the Router manually. Daily delivery is enabled for new users and legacy default-off
records, while explicit opt-outs and existing mute deadlines remain effective.
The runtime Feishu integration needs normal application message/image permissions;
live tenant rendering and delivery are not established by mocked tests.
