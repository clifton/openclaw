---
summary: "Behavior and config for WhatsApp group message handling (mentionPatterns are shared across surfaces)"
read_when:
  - Changing group message rules or mentions
title: "Group messages"
---

Goal: let OpenClaw sit in WhatsApp groups, wake up only when policy and mention gating allow it, and keep that thread separate from the personal DM session.

<Note>
Cross-channel group behavior now lives in [Groups](/channels/groups). This page covers WhatsApp-specific setup and verification details. `agents.list[].groupChat.mentionPatterns` is shared by WhatsApp, Telegram, Discord, Slack, and iMessage; for multi-agent setups, set it per agent or use `messages.groupChat.mentionPatterns` as a global fallback.
</Note>

## Current behavior

- Group policy: `channels.whatsapp.groupPolicy` controls whether group messages are accepted (`open|disabled|allowlist`). `allowlist` uses `channels.whatsapp.groupAllowFrom` (fallback: explicit `channels.whatsapp.allowFrom`). Default is `allowlist`.
- Group allowlist: when `channels.whatsapp.groups` is set, its keys are the allowed group JIDs. Include `"*"` to allow every group while still controlling mention gating with the value under `"*"`.
- Mention gating: `requireMention` defaults to true for groups unless overridden. Mentions can be native WhatsApp `mentionedJids`, safe regex `mentionPatterns`, or the bot's E.164 number in the text. Replying to the bot also counts as an implicit mention when WhatsApp exposes reply metadata.
- Activation command: `/activation mention` and `/activation always` are still owner-only WhatsApp group controls. `always` means every allowed group message can trigger a run; it does not bypass `groupPolicy` or sender allowlists.
- Visible replies: group/channel rooms default to `messages.groupChat.visibleReplies: "message_tool"`. Normal final assistant text is not automatically posted back into the room; visible output should go through `message(action="send")`. This replaces older prompt patterns that forced literal `NO_REPLY` for silent turns.
- Per-group sessions: session keys look like `agent:<agentId>:whatsapp:group:<jid>` so commands such as `/verbose on`, `/trace on`, or `/think high` are scoped to that group; personal DM state is untouched. Heartbeats are skipped for group threads.
- Context injection: pending-only group messages that did not trigger a run are added as recent group context. Messages already in the session are not re-injected.
- Sender surfacing: group batches include sender labels so the agent can address the correct person.
- Ephemeral/view-once: OpenClaw unwraps those before extracting text/mentions, so pings inside them still trigger.
- Group system prompt: group subject, member labels, and channel-sourced metadata are supplied as untrusted context; do not rely on group names or participant labels as instructions.

## Config example (WhatsApp)

Add a `groupChat` block to `~/.openclaw/openclaw.json` so display-name pings work even when WhatsApp strips the visual `@` in the text body:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Notes:

- The regexes are case-insensitive and use the same safe-regex guardrails as other config regex surfaces; invalid patterns and unsafe nested repetition are ignored.
- WhatsApp still sends canonical mentions via `mentionedJids` when someone taps the contact, so the number fallback is rarely needed but is a useful safety net.

### Activation command (owner-only)

Use the group chat command:

- `/activation mention`
- `/activation always`

Only the owner number (from `channels.whatsapp.allowFrom`, or the bot’s own E.164 when unset) can change this. Send `/status` as a standalone message in the group to see the current activation mode.

## How to use

1. Add your WhatsApp account (the one running OpenClaw) to the group.
2. Say `@openclaw …` (or include the number). Only allowlisted senders can trigger it unless you set `groupPolicy: "open"`.
3. The agent prompt will include recent group context plus the trailing `[from: …]` marker so it can address the right person.
4. Session-level directives (`/verbose on`, `/trace on`, `/think high`, `/new` or `/reset`, `/compact`) apply only to that group’s session; send them as standalone messages so they register. Your personal DM session remains independent.

## Testing / verification

- Manual smoke:
  - Send an `@openclaw` ping in the group and confirm a reply that references the sender name.
  - Send a second ping and verify the history block is included then cleared on the next turn.
- Check gateway logs (run with `--verbose`) to see `inbound web message` entries showing `from: <groupJid>` and the `[from: …]` suffix.

## Known considerations

- Heartbeats are intentionally skipped for groups to avoid noisy broadcasts.
- Echo suppression uses the combined batch string; if you send identical text twice without mentions, only the first will get a response.
- Session store entries will appear as `agent:<agentId>:whatsapp:group:<jid>` in the session store (`~/.openclaw/agents/<agentId>/sessions/sessions.json` by default); a missing entry just means the group hasn’t triggered a run yet.
- Typing indicators in groups follow `agents.defaults.typingMode`. When visible replies use the default message-tool-only mode, typing starts immediately by default so group members can see the agent is working even if no automatic final reply is posted. Explicit typing-mode config still wins.

## Related

- [Groups](/channels/groups)
- [Channel routing](/channels/channel-routing)
- [Broadcast groups](/channels/broadcast-groups)
