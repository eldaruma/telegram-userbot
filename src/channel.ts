import {
  buildChannelOutboundSessionRoute,
  createSubsystemLogger,
  jsonResult,
  readStringParam,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
} from "openclaw/plugin-sdk/core";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-runtime";
import { readStringOrNumberParam } from "openclaw/plugin-sdk/param-readers";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import {
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from "openclaw/plugin-sdk/direct-dm";
import {
  buildMentionRegexes,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import { buildInboundReplyDispatchBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { readFileSync } from "node:fs";
import { NewMessage } from "telegram/events";
import { GramJsClientManager } from "./gramjs-client";
import { normalizeTelegramEvent } from "./normalize";
import type { PluginConfig, RuntimeMap } from "./types";

const CHANNEL_ID = "telegram-userbot";
const GROUP_REPLY_ADDRESS_TTL_MS = 10 * 60 * 1000;
const GROUP_REPLY_LATEST_ID = "__latest__";
const actionLog = createSubsystemLogger("channels/telegram-userbot");

const groupReplyAddresses = new Map<string, { address: string; expiresAt: number }>();

function resolveConfiguredAccountId(cfg: any, preferred?: string | null): string | undefined {
  if (preferred?.trim()) {
    return preferred.trim();
  }

  const accounts = cfg?.channels?.[ CHANNEL_ID ]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }

  return Object.keys(accounts).find((accountId) => accounts?.[ accountId ]?.enabled !== false);
}

function normalizeOutboundTarget(rawTarget: string): string {
  const withoutChannel = stripChannelTargetPrefix(rawTarget, CHANNEL_ID, "tguserbot", "telegram", "tg");
  return stripTargetKindPrefix(withoutChannel).trim();
}

function inferOutboundTargetKind(rawTarget: string, resolvedKind?: "user" | "group" | "channel"): "user" | "group" | "channel" | undefined {
  if (resolvedKind) {
    return resolvedKind;
  }

  const withoutChannel = stripChannelTargetPrefix(rawTarget, CHANNEL_ID, "tguserbot", "telegram", "tg").trim();
  const prefix = withoutChannel.match(/^(user|channel|group|conversation|room|dm):/i)?.[ 1 ]?.toLowerCase();
  if (prefix === "group" || prefix === "room" || prefix === "conversation") {
    return "group";
  }
  if (prefix === "channel") {
    return "channel";
  }
  if (prefix === "user" || prefix === "dm") {
    return "user";
  }

  const target = normalizeOutboundTarget(rawTarget);
  if (target.startsWith("-")) {
    return "group";
  }

  return undefined;
}

function routeKindFromChatType(chatType?: "direct" | "group" | "channel"): "direct" | "group" | "channel" {
  return chatType === "group" || chatType === "channel" ? chatType : "direct";
}

function buildConversationTarget(chatId: string): string {
  return `${CHANNEL_ID}:${chatId}`;
}

function buildScopedGroupPeerId(accountId: string | undefined, chatId: string): string {
  const scopedAccountId = (accountId ?? "default").trim() || "default";
  return `${scopedAccountId}:${chatId}`;
}

function normalizeGroupReplyTarget(rawTarget: unknown): string {
  if (typeof rawTarget !== "string") {
    return String(rawTarget ?? "").trim();
  }

  return normalizeOutboundTarget(rawTarget) || rawTarget.trim();
}

function stripReplyDirectiveTags(text: string): string {
  return text
    .replace(/\[\[\s*reply_to_current\s*\]\]/gi, " ")
    .replace(/\[\[\s*reply_to\s*:\s*[^\]\n]+\s*\]\]/gi, " ")
    .replace(/\[\[\s*audio_as_voice\s*\]\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readLatestAssistantFallbackFromTranscript(sessionKey: string): string | undefined {
  try {
    const rawStore = readFileSync("/root/.openclaw/agents/main/sessions/sessions.json", "utf8");
    const store = JSON.parse(rawStore) as Record<string, { sessionFile?: string }>;
    const sessionFile = typeof store?.[ sessionKey ]?.sessionFile === "string" ? store[ sessionKey ]?.sessionFile : undefined;
    if (!sessionFile) {
      return undefined;
    }

    const lines = readFileSync(sessionFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[ index ]) as {
          type?: string;
          message?: {
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
          };
        };

        if (entry?.type !== "message" || entry?.message?.role !== "assistant" || !Array.isArray(entry.message.content)) {
          continue;
        }

        const textPart = entry.message.content.find((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
        if (!textPart?.text) {
          continue;
        }

        const cleaned = stripReplyDirectiveTags(textPart.text);
        if (cleaned) {
          return cleaned;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveActionTarget(params: Record<string, unknown>, toolContext?: {
  currentChannelId?: string;
}): string {
  const explicitTo = readStringParam(params, "to") ?? readStringParam(params, "target");
  if (explicitTo?.trim()) {
    return explicitTo.trim();
  }

  const contextTarget = toolContext?.currentChannelId?.trim();
  if (contextTarget) {
    return contextTarget;
  }

  throw new Error("telegram-userbot: message target is required");
}

function resolveReplyToMessageIdForTarget(rawTarget: string, replyToId?: string | number | null): number | undefined {
  if (replyToId === null || replyToId === undefined || replyToId === "") {
    return undefined;
  }

  const targetKind = inferOutboundTargetKind(rawTarget);
  if (targetKind === "group" || targetKind === "channel") {
    return Number(replyToId);
  }

  return undefined;
}

function buildGroupReplyAddressKey(input: {
  accountId?: string | null;
  chatId: unknown;
  replyToId?: string | number | null;
}): string | undefined {
  const chatId = normalizeGroupReplyTarget(input.chatId);
  const replyToId = input.replyToId === null || input.replyToId === undefined ? "" : String(input.replyToId).trim();
  if (!chatId || !replyToId) {
    return undefined;
  }

  return [ input.accountId ?? "", chatId, replyToId ].join("\n");
}

function rememberGroupReplyAddress(input: {
  accountId?: string | null;
  chatId: unknown;
  replyToId?: string | number | null;
  address?: string;
}): void {
  if (!input.address) {
    return;
  }

  const key = buildGroupReplyAddressKey(input);
  if (!key) {
    return;
  }

  groupReplyAddresses.set(key, {
    address: input.address,
    expiresAt: Date.now() + GROUP_REPLY_ADDRESS_TTL_MS,
  });

  const latestKey = buildGroupReplyAddressKey({
    ...input,
    replyToId: GROUP_REPLY_LATEST_ID,
  });
  if (latestKey) {
    groupReplyAddresses.set(latestKey, {
      address: input.address,
      expiresAt: Date.now() + GROUP_REPLY_ADDRESS_TTL_MS,
    });
  }
}

function consumeGroupReplyAddress(input: {
  accountId?: string | null;
  chatId: unknown;
  replyToId?: string | number | null;
}): string | undefined {
  const latestKey = buildGroupReplyAddressKey({
    ...input,
    replyToId: GROUP_REPLY_LATEST_ID,
  });
  const key = buildGroupReplyAddressKey(input) ?? latestKey;
  if (!key) {
    return undefined;
  }

  const stored = groupReplyAddresses.get(key);
  if (!stored) {
    return undefined;
  }

  groupReplyAddresses.delete(key);
  if (latestKey) {
    groupReplyAddresses.delete(latestKey);
  }
  if (stored.expiresAt < Date.now()) {
    return undefined;
  }

  return stored.address;
}

function readMessageText(params: Record<string, unknown>): string {
  const message = readStringParam(params, "message", { allowEmpty: true });
  if (typeof message === "string") {
    return message;
  }

  const text = readStringParam(params, "text", { allowEmpty: true });
  if (typeof text === "string") {
    return text;
  }

  return "";
}

function resolveAllowFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [ "*" ];
  }

  const entries = value.map((entry) => String(entry).trim()).filter(Boolean);
  return entries.length > 0 ? entries : [ "*" ];
}

function resolveGroupPolicy(value: unknown): "open" | "mention" {
  return value === "open" ? "open" : "mention";
}

function resolveActiveUsername(source: any): string | undefined {
  if (typeof source?.username === "string" && source.username.trim()) {
    return source.username.trim();
  }

  const activeUsername = Array.isArray(source?.usernames)
    ? source.usernames.find((entry: any) => entry?.active !== false && typeof entry?.username === "string")?.username
    : undefined;

  return typeof activeUsername === "string" && activeUsername.trim() ? activeUsername.trim() : undefined;
}

function normalizeAllowEntry(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function isSenderAllowed(input: {
  allowFrom: string[];
  senderId?: string;
  senderUsername?: string;
}): boolean {
  if (input.allowFrom.includes("*")) {
    return true;
  }

  const senderIds = [
    input.senderId,
    input.senderUsername,
    input.senderUsername ? `@${input.senderUsername}` : undefined,
  ].filter((value): value is string => Boolean(value)).map(normalizeAllowEntry);

  return input.allowFrom.map(normalizeAllowEntry).some((entry) => senderIds.includes(entry));
}

function hasTelegramMention(input: {
  cfg: any;
  agentId?: string;
  selfUsername?: string;
  text: string;
  message?: any;
}): boolean {
  const normalizedText = input.text.trim();
  const message = input.message;
  const mentionRegexes = buildMentionRegexes(input.cfg, input.agentId);
  const selfUsername = input.selfUsername?.replace(/^@/, "").trim();
  const entities = Array.isArray(message?.entities) ? message.entities : [];
  const hasAnyMention = Boolean(message?.mentioned) ||
    entities.some((entity: any) => {
      const kind = typeof entity?.className === "string" ? entity.className : entity?.type;
      return kind === "MessageEntityMention" || kind === "mention" || kind === "MessageEntityMentionName" || kind === "InputMessageEntityMentionName";
    }) ||
    /(^|\s)@[a-zA-Z0-9_]{5,}\b/.test(normalizedText);
  const entityExplicitMention = Boolean(selfUsername) && entities.some((entity: any) => {
    const kind = typeof entity?.className === "string" ? entity.className : entity?.type;
    if (kind !== "MessageEntityMention" && kind !== "mention") {
      return false;
    }

    const offset = typeof entity?.offset === "number" ? entity.offset : -1;
    const length = typeof entity?.length === "number" ? entity.length : 0;
    if (offset < 0 || length <= 0) {
      return false;
    }

    return normalizedText.slice(offset, offset + length).replace(/^@/, "").trim().toLowerCase() === selfUsername.toLowerCase();
  });
  const explicitlyMentioned = Boolean(selfUsername) &&
    (
      message?.mentioned === true ||
      entityExplicitMention ||
      new RegExp(`(^|\\s)@${selfUsername?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(normalizedText)
    );

  return matchesMentionWithExplicit({
    text: normalizedText,
    mentionRegexes,
    explicit: {
      hasAnyMention,
      isExplicitlyMentioned: explicitlyMentioned,
      canResolveExplicit: Boolean(selfUsername),
    },
  });
}

function toDisplayName(input: {
  username?: string;
  firstName?: string;
  lastName?: string;
  fallback?: string;
}): string {
  if (input.username) {
    return `@${input.username}`;
  }

  const fullName = [ input.firstName, input.lastName ].filter(Boolean).join(" ").trim();
  return fullName || input.fallback || "Telegram";
}

function buildGroupReplyAddress(input: {
  senderUsername?: string;
  senderDisplay?: string;
  senderId?: string;
}): string | undefined {
  const username = input.senderUsername?.replace(/^@/, "").trim();
  if (username) {
    return `@${username}`;
  }

  const display = input.senderDisplay?.trim();
  if (display && display !== "Telegram") {
    return display;
  }

  return input.senderId;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function prefixReplyTextToAddress(text: string, address?: string): string {
  const outboundText = text.trim();
  if (!address) {
    return outboundText;
  }

  const lowerText = outboundText.toLowerCase();
  const lowerAddress = address.toLowerCase();
  if (
    lowerText === lowerAddress ||
    lowerText.startsWith(`${lowerAddress},`) ||
    lowerText.startsWith(`${lowerAddress}:`) ||
    lowerText.startsWith(`${lowerAddress} `)
  ) {
    return outboundText;
  }

  return `${address}, ${outboundText}`;
}

async function resolveReplyTarget(message: any): Promise<unknown> {
  const directInputSender =
    typeof message?.getInputSender === "function"
      ? await message.getInputSender().catch(() => undefined)
      : undefined;
  if (directInputSender) {
    return directInputSender;
  }

  const sender =
    typeof message?.getSender === "function"
      ? await message.getSender().catch(() => undefined)
      : undefined;
  if (sender) {
    return sender;
  }

  const directInputChat =
    typeof message?.getInputChat === "function"
      ? await message.getInputChat().catch(() => undefined)
      : undefined;
  if (directInputChat) {
    return directInputChat;
  }

  const chat =
    typeof message?.getChat === "function"
      ? await message.getChat().catch(() => undefined)
      : undefined;
  if (chat) {
    return chat;
  }

  return message?.inputSender ?? message?._inputSender ?? message?.sender ?? message?._sender ?? message?.inputChat ?? message?._inputChat ?? message?.chat ?? message?._chat ?? message?.peerId;
}

async function resolveChatTarget(message: any): Promise<unknown> {
  const directInputChat =
    typeof message?.getInputChat === "function"
      ? await message.getInputChat().catch(() => undefined)
      : undefined;
  if (directInputChat) {
    return directInputChat;
  }

  const chat =
    typeof message?.getChat === "function"
      ? await message.getChat().catch(() => undefined)
      : undefined;
  if (chat) {
    return chat;
  }

  return message?.inputChat ?? message?._inputChat ?? message?.chat ?? message?._chat ?? message?.peerId;
}

async function isReplyToSelfMessage(message: any, selfId?: string): Promise<boolean> {
  if (!selfId) {
    return false;
  }

  const replyToMessageId = message?.replyTo?.replyToMsgId ?? message?.replyToMsgId;
  if (!replyToMessageId) {
    return false;
  }

  const replied =
    typeof message?.getReplyMessage === "function"
      ? await message.getReplyMessage().catch(() => undefined)
      : undefined;
  if (!replied) {
    return false;
  }

  if (replied.out === true) {
    return true;
  }

  const replySenderId =
    replied.senderId ??
    replied.fromId?.userId ??
    replied.fromId?.channelId;
  return replySenderId !== undefined && String(replySenderId) === selfId;
}

async function resolveSenderProfile(message: any, input?: {
  senderId?: string;
  client?: any;
}): Promise<{
  username?: string;
  display?: string;
}> {
  const pickProfile = (source: any): {
    username?: string;
    firstName?: string;
    lastName?: string;
  } => {
    const activeUsername = Array.isArray(source?.usernames)
      ? source.usernames.find((entry: any) => entry?.active !== false && typeof entry?.username === "string")?.username
      : undefined;

    return {
      username: typeof source?.username === "string" ? source.username : activeUsername,
      firstName: typeof source?.firstName === "string" ? source.firstName : undefined,
      lastName: typeof source?.lastName === "string" ? source.lastName : undefined,
    };
  };

  const sender =
    typeof message?.getSender === "function"
      ? await message.getSender().catch(() => undefined)
      : undefined;
  const inputSender =
    typeof message?.getInputSender === "function"
      ? await message.getInputSender().catch(() => undefined)
      : undefined;
  const inputSenderEntity =
    inputSender && typeof input?.client?.getEntity === "function"
      ? await input.client.getEntity(inputSender).catch(() => undefined)
      : undefined;
  const fromEntity =
    message?.fromId && typeof input?.client?.getEntity === "function"
      ? await input.client.getEntity(message.fromId).catch(() => undefined)
      : undefined;
  const numericSenderId =
    input?.senderId && /^\d+$/.test(input.senderId) && Number.isSafeInteger(Number(input.senderId))
      ? Number(input.senderId)
      : undefined;
  const entity =
    input?.senderId && typeof input?.client?.getEntity === "function"
      ? await input.client.getEntity(numericSenderId ?? input.senderId).catch(() => undefined)
      : undefined;
  const profiles = [
    pickProfile(sender),
    pickProfile(inputSenderEntity),
    pickProfile(fromEntity),
    pickProfile(entity),
    pickProfile(message?.sender),
    pickProfile(message?._sender),
  ];
  const profile =
    profiles.find((candidate) => candidate.username) ??
    profiles.find((candidate) => candidate.firstName || candidate.lastName);

  const username = profile?.username;

  const display = toDisplayName({
    username,
    firstName: profile?.firstName,
    lastName: profile?.lastName,
  });

  return {
    username,
    display,
  };
}

async function resolveSenderProfileWithTimeout(message: any, input?: {
  senderId?: string;
  client?: any;
}, timeoutMs = 1500): Promise<{
  username?: string;
  display?: string;
}> {
  return await withTimeout(resolveSenderProfile(message, input), timeoutMs) ?? {};
}

export const createChannelPlugin = (runtimes: RuntimeMap) => {
  const resolveRuntimeAccountId = (cfg: any, preferred?: string | null): string | undefined => {
    const configured = resolveConfiguredAccountId(cfg, preferred);
    if (configured && runtimes.has(configured)) {
      return configured;
    }

    if (preferred?.trim()) {
      return preferred.trim();
    }

    return configured ?? runtimes.keys().next().value;
  };

  return {
    id: "telegram-userbot",

    meta: {
      id: "telegram-userbot",
      label: "Telegram Userbot",
      selectionLabel: "Telegram Userbot (GramJS)",
      docsPath: "/channels/telegram-userbot",
      blurb:
        "Connect your personal Telegram account to OpenClaw via MTProto. Your AI assistant responds as you.",
      aliases: [ "tguserbot" ],
    },

    capabilities: {
      chatTypes: [ "direct", "group" ] as const,
      reactions: true,
      threads: true,
      media: true,
      nativeCommands: false,
      blockStreaming: false,
    },

    agentPrompt: {
      messageToolHints: () => [
        "Use telegram-userbot to send Telegram replies from the connected personal account.",
        "When replying in the current Telegram chat, omit `to`/`target` and telegram-userbot will send to the current conversation automatically.",
        "Explicit targets may be @username, numeric Telegram user id, phone/contact resolvable by Telegram, group chat ids, or telegram-userbot:<target>.",
      ],
      messageToolCapabilities: () => [
        "telegram-userbot can reply in the current Telegram conversation when no explicit target is provided.",
        "telegram-userbot can send text messages to direct chats and groups from the connected personal account.",
      ],
    },

    config: {
      listAccountIds(cfg: any): string[] {
        const accounts = cfg?.channels?.[ "telegram-userbot" ]?.accounts;
        if (!accounts || typeof accounts !== "object") {
          return [];
        }

        return Object.keys(accounts);
      },

      resolveAccount(cfg: any, accountId: string): PluginConfig {
        const account = cfg?.channels?.[ "telegram-userbot" ]?.accounts?.[ accountId ];

        return {
          apiId: Number(account?.apiId),
          apiHash: String(account?.apiHash ?? ""),
          sessionString: String(account?.sessionString ?? ""),
          allowFrom: resolveAllowFrom(account?.allowFrom),
          groupPolicy: resolveGroupPolicy(account?.groupPolicy),
          enabled: account?.enabled,
          accountId,
        };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { account, accountId, channelRuntime, cfg, log } = ctx;

        if (!channelRuntime) {
          throw new Error("telegram-userbot: channelRuntime is required");
        }

        if (runtimes.has(accountId)) {
          log?.warn?.("telegram-userbot stale runtime detected, reconnecting", { accountId });
          await runtimes.get(accountId)?.stop().catch(() => undefined);
          runtimes.delete(accountId);
        }

        const gram = new GramJsClientManager(account);
        await gram.start();
        runtimes.set(accountId, gram);
        const pairing = createChannelPairingController({
          core: { channel: channelRuntime },
          channel: "telegram-userbot",
          accountId,
        });

  const me = await gram.getMe();
  const selfId = me?.id ? String(me.id) : undefined;
  const selfUsername = resolveActiveUsername(me);
  const selfLabel = toDisplayName({
    username: selfUsername,
    firstName: typeof (me as any)?.firstName === "string" ? (me as any).firstName : undefined,
    lastName: typeof (me as any)?.lastName === "string" ? (me as any).lastName : undefined,
    fallback: selfId,
        });

        log?.info?.("telegram-userbot connected ------------------------------------------", {
          accountId,
          selfId,
          username: selfUsername,
        });

        const client = gram.getClient();
        const eventBuilder = new NewMessage({});
        const eventHandler = async (event: unknown) => {
          try {
            const rawMessage = (event as any)?.message;
            const rawPeerUserId = rawMessage?.peerId?.userId;
            const rawPeerChatId = rawMessage?.peerId?.chatId;
            const rawPeerChannelId = rawMessage?.peerId?.channelId;
            const directLike = rawPeerUserId !== undefined ||
              (typeof rawMessage?.chatId === "number" && rawMessage.chatId > 0);
            if (directLike) {
              log?.info?.("telegram-userbot raw direct-like event", {
                accountId,
                messageId: String(rawMessage?.id ?? ""),
                chatId: String(rawMessage?.chatId ?? ""),
                peerUserId: String(rawPeerUserId ?? ""),
                peerChatId: String(rawPeerChatId ?? ""),
                peerChannelId: String(rawPeerChannelId ?? ""),
                senderId: String(rawMessage?.senderId ?? rawMessage?.fromId?.userId ?? ""),
                out: rawMessage?.out === true,
                textLength: typeof rawMessage?.message === "string" ? rawMessage.message.length : typeof rawMessage?.text === "string" ? rawMessage.text.length : 0,
              });
            }
            const normalized = normalizeTelegramEvent(event, accountId);
            if (!normalized) {
              if (directLike) {
                log?.info?.("telegram-userbot normalize returned null", {
                  accountId,
                  messageId: String(rawMessage?.id ?? ""),
                  chatId: String(rawMessage?.chatId ?? ""),
                  peerUserId: String(rawPeerUserId ?? ""),
                });
              }
              return;
            }

            const directReplyTarget = normalized.chatType === "direct"
              ? undefined
              : await resolveReplyTarget(rawMessage);
            const senderProfile = normalized.chatType === "direct"
              ? await resolveSenderProfileWithTimeout(rawMessage, {
                  senderId: normalized.senderId,
                  client,
                }, 1500)
              : await resolveSenderProfile(rawMessage, {
                  senderId: normalized.senderId,
                  client,
                });

            const replyTarget =
              normalized.chatType === "direct"
                ? normalized.chatId
                : await resolveChatTarget(rawMessage);

            if (replyTarget) {
              normalized.replyTarget = replyTarget;
            }

            if (!normalized.senderUsername && senderProfile.username) {
              normalized.senderUsername = senderProfile.username;
            }

            if (!normalized.senderDisplay && senderProfile.display) {
              normalized.senderDisplay = senderProfile.display;
            }

            if (normalized.isOutgoing) {
              if (normalized.chatType === "direct") {
                log?.info?.("telegram-userbot skipping outgoing direct event", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                  senderId: normalized.senderId,
                });
              }
              return;
            }

            if (normalized.chatType === "channel") {
              console.log("telegram-userbot skipping channel inbound", {
                accountId,
                chatId: normalized.chatId,
                chatType: normalized.chatType,
                messageId: normalized.messageId,
              });
              return;
            }

            const text = normalized.text?.trim();
            if (!text) {
              console.log("telegram-userbot skipping empty inbound text", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
              });
              return;
            }

            const senderId = normalized.senderId ?? normalized.chatId;
            const senderUsername = normalized.senderUsername;
            const senderLabel = normalized.senderDisplay || normalized.senderUsername || senderId;
            const conversationTarget = normalized.chatType === "direct"
              ? normalized.chatId
              : normalized.replyTarget ?? normalized.chatId;
            const conversationFallbackTargets = [
              normalized.chatType === "direct" ? directReplyTarget : undefined,
              normalized.chatType === "direct" ? normalized.replyTarget : undefined,
              normalized.chatType === "direct" && normalized.senderUsername ? `@${normalized.senderUsername}` : undefined,
              normalized.chatId,
            ].filter((target, index, items): target is string | unknown => {
              if (!target || target === conversationTarget) {
                return false;
              }

              return items.findIndex((candidate) => candidate === target) === index;
            });
          const sendTextToConversation = async (args: {
            text: string;
            replyToMessageId?: number;
          }) => {
            const targets = [ conversationTarget, ...conversationFallbackTargets ];
            let lastError: unknown;

            for (const target of targets) {
              try {
                return await gram.sendText({
                  target,
                  text: args.text,
                  replyToMessageId: args.replyToMessageId,
                });
              } catch (error) {
                lastError = error;
              }
            }

            throw lastError;
          };
          const accountConfig =
            cfg?.channels?.[ "telegram-userbot" ]?.accounts?.[ accountId ] ??
            cfg?.channels?.[ "telegram-userbot" ] ??
            {};
          const allowFrom = resolveAllowFrom(accountConfig?.allowFrom ?? account?.allowFrom);
          const groupPolicy = resolveGroupPolicy(accountConfig?.groupPolicy ?? account?.groupPolicy);

            if (!isSenderAllowed({
              allowFrom,
              senderId,
              senderUsername: normalized.senderUsername,
            })) {
              if (normalized.chatType === "direct") {
                log?.info?.("telegram-userbot direct allowFrom mismatch", {
                  accountId,
                  senderId,
                  senderUsername: normalized.senderUsername,
                  allowFrom,
                });
              }
              log?.info?.("telegram-userbot blocking inbound from non-allowlisted sender", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
              senderId,
              username: normalized.senderUsername,
            });
            return;
          }

          const dmPolicy = "open";

            if (normalized.chatType === "group") {
              const scopedGroupPeerId = buildScopedGroupPeerId(accountId, normalized.chatId);
              const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
                cfg,
                channel: "telegram-userbot",
                accountId,
                peer: {
                  kind: "group",
                  id: scopedGroupPeerId,
                },
                runtime: channelRuntime,
                sessionStore: cfg?.session?.store,
              });
              const wasMentioned = hasTelegramMention({
                cfg,
                agentId: route.agentId,
                selfUsername,
                text,
                message: rawMessage,
              });
              const wasReplyToSelf = await isReplyToSelfMessage(rawMessage, selfId);
              const mentionDecision = resolveInboundMentionDecision({
                facts: {
                  canDetectMention: true,
                  wasMentioned,
                  hasAnyMention: /(^|\s)@[a-zA-Z0-9_]{5,}\b/.test(text),
                },
                policy: {
                  isGroup: true,
                  requireMention: groupPolicy === "mention",
                  allowTextCommands: false,
                  hasControlCommand: false,
                  commandAuthorized: true,
                },
              });

              log?.info?.("telegram-userbot group mention gate", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                selfUsername,
                mentionedFlag: rawMessage?.mentioned === true,
                hasEntities: Array.isArray(rawMessage?.entities) ? rawMessage.entities.length : 0,
                wasMentioned,
                wasReplyToSelf,
                shouldSkip: mentionDecision.shouldSkip,
                text,
              });

              if (groupPolicy === "mention" && mentionDecision.shouldSkip && !wasReplyToSelf) {
                console.log("telegram-userbot skipping group message without mention", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                  senderId,
                });
                return;
              }

              const { storePath, body } = buildEnvelope({
                channel: "Telegram",
                from: senderLabel,
                body: text,
                timestamp: normalized.timestamp,
              });
              const conversationRouteTarget = buildConversationTarget(normalized.chatId);
              const ctxPayload = channelRuntime.reply.finalizeInboundContext({
                Body: body,
                BodyForAgent: text,
                RawBody: text,
                CommandBody: text,
                From: conversationRouteTarget,
                To: conversationRouteTarget,
                SessionKey: route.sessionKey,
                AccountId: route.accountId ?? accountId,
                ChatType: "group",
                ConversationLabel: senderLabel,
                SenderId: senderId,
                SenderUsername: normalized.senderUsername,
                SenderName: normalized.senderDisplay,
                GroupId: normalized.chatId,
                GroupSubject: normalized.chatId,
                WasMentioned: mentionDecision.effectiveWasMentioned || wasReplyToSelf,
                WasReplyToSelf: wasReplyToSelf,
                Provider: "telegram",
                Surface: "telegram-userbot",
                MessageSid: normalized.messageId,
                MessageSidFull: normalized.messageId,
                Timestamp: normalized.timestamp,
                ReplyToId: normalized.replyToMessageId,
                NativeChannelId: normalized.chatId,
                OriginatingChannel: "telegram-userbot",
                OriginatingTo: conversationRouteTarget,
              });
              const groupReplyAddress = buildGroupReplyAddress({
                senderUsername: normalized.senderUsername,
                senderDisplay: normalized.senderDisplay,
                senderId,
              });
              rememberGroupReplyAddress({
                accountId: route.accountId ?? accountId,
                chatId: normalized.chatId,
                replyToId: normalized.messageId,
                address: groupReplyAddress,
              });

              await gram.withTyping(conversationTarget, async () => {
                await channelRuntime.session.recordInboundSession({
                  storePath,
                  sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
                  ctx: ctxPayload,
                  updateLastRoute: {
                    sessionKey: route.sessionKey,
                    channel: CHANNEL_ID,
                    to: conversationRouteTarget,
                    accountId: route.accountId ?? accountId,
                  },
                  onRecordError: (err) => {
                    console.log("telegram-userbot failed to update group last route", {
                      accountId,
                      chatId: normalized.chatId,
                      messageId: normalized.messageId,
                      error: String(err),
                    });
                  },
                });

                log?.info?.("telegram-userbot dispatching group reply", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                  routeSessionKey: route.sessionKey,
                  storePath,
                });

                const dispatchBase = buildInboundReplyDispatchBase({
                  cfg,
                  channel: "telegram-userbot",
                  accountId: route.accountId ?? accountId,
                  route,
                  storePath,
                  ctxPayload,
                  core: { channel: channelRuntime },
                });
                const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
                  cfg,
                  agentId: route.agentId,
                  channel: "telegram-userbot",
                  accountId: route.accountId ?? accountId,
                });
                const dispatchResult = await dispatchBase.dispatchReplyWithBufferedBlockDispatcher({
                  ctx: ctxPayload,
                  cfg,
                  dispatcherOptions: {
                    ...replyPipeline,
                    deliver: async (payload) => {
                      const outboundText = typeof payload.text === "string" ? payload.text.trim() : "";
                      log?.info?.("telegram-userbot deliver group payload", {
                        accountId,
                        chatId: normalized.chatId,
                        messageId: normalized.messageId,
                        payloadText: outboundText,
                        payloadReplyToId: payload.replyToId ?? null,
                      });
                      if (!outboundText) {
                        return;
                      }

                      const replyToMessageId = payload.replyToId ? Number(payload.replyToId) : Number(normalized.messageId);
                      const rememberedAddress = consumeGroupReplyAddress({
                        accountId: route.accountId ?? accountId,
                        chatId: normalized.chatId,
                        replyToId: payload.replyToId ?? normalized.messageId,
                      });

                      await sendTextToConversation({
                        text: prefixReplyTextToAddress(outboundText, rememberedAddress ?? groupReplyAddress),
                        replyToMessageId,
                      });
                    },
                    onError: (err, info) => {
                      log?.error?.("telegram-userbot failed to dispatch group reply", {
                        accountId,
                        chatId: normalized.chatId,
                        messageId: normalized.messageId,
                        kind: info.kind,
                        error: String(err),
                      });
                    },
                  },
                  replyOptions: {
                    onModelSelected,
                  },
                });

                log?.info?.("telegram-userbot group dispatch completed", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                  queuedFinal: dispatchResult?.queuedFinal ?? null,
                  counts: dispatchResult?.counts ?? null,
                });

                const dispatchCounts = dispatchResult?.counts ?? { tool: 0, block: 0, final: 0 };
                const nothingDelivered = dispatchResult?.queuedFinal !== true &&
                  (dispatchCounts.tool ?? 0) === 0 &&
                  (dispatchCounts.block ?? 0) === 0 &&
                  (dispatchCounts.final ?? 0) === 0;

                if (nothingDelivered) {
                  const fallbackText = readLatestAssistantFallbackFromTranscript(route.sessionKey);
                  if (fallbackText) {
                    log?.warn?.("telegram-userbot using transcript fallback reply", {
                      accountId,
                      chatId: normalized.chatId,
                      messageId: normalized.messageId,
                      routeSessionKey: route.sessionKey,
                      fallbackText,
                    });

                    await sendTextToConversation({
                      text: prefixReplyTextToAddress(fallbackText, groupReplyAddress),
                      replyToMessageId: Number(normalized.messageId),
                    });
                  } else {
                    log?.warn?.("telegram-userbot transcript fallback unavailable", {
                      accountId,
                      chatId: normalized.chatId,
                      messageId: normalized.messageId,
                      routeSessionKey: route.sessionKey,
                    });
                  }
                }
              }, {
                readMessageId: Number(normalized.messageId),
              });

              console.log("telegram-userbot group inbound handled", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                senderId,
                senderLabel,
                wasMentioned: mentionDecision.effectiveWasMentioned,
                wasReplyToSelf,
              });
              return;
            }

            const access = await resolveInboundDirectDmAccessWithRuntime({
              cfg,
              channel: "telegram-userbot",
              accountId,
              dmPolicy,
              allowFrom,
              senderId,
              rawBody: text,
              runtime: channelRuntime.commands,
              isSenderAllowed: (_candidateSenderId, allowEntries) => isSenderAllowed({
                allowFrom: allowEntries,
                senderId,
                senderUsername,
              }),
              readStoreAllowFrom: pairing.readStoreForDmPolicy,
            });

            if (access.access.decision === "block") {
              console.log("telegram-userbot blocking inbound direct message", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                senderId,
                reason: access.access.reason,
                reasonCode: access.access.reasonCode,
              });
              return;
            }

            if (access.access.decision === "pairing") {
              await pairing.issueChallenge({
                senderId,
                senderIdLine: `Your Telegram user id: ${senderId}`,
                meta: {
                  username: normalized.senderUsername,
                  name: normalized.senderDisplay,
                },
                sendPairingReply: async (pairingText) => {
                  await sendTextToConversation({
                    text: pairingText,
                  });
                },
                onReplyError: (err) => {
                  console.log("telegram-userbot pairing reply failed", {
                    accountId,
                    chatId: normalized.chatId,
                    senderId,
                    error: String(err),
                  });
                },
              });

              console.log("telegram-userbot pairing required for inbound direct message", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                senderId,
              });
              return;
            }

            await gram.withTyping(conversationTarget, async () => {
              await dispatchInboundDirectDmWithRuntime({
                cfg,
                runtime: { channel: channelRuntime },
                channel: "telegram-userbot",
                channelLabel: "Telegram",
                accountId,
                peer: {
                  kind: "direct",
                  id: senderId,
                },
                senderId,
                senderAddress: `telegram:${senderId}`,
                recipientAddress: selfId ? `telegram:${selfId}` : `telegram:${accountId}`,
                conversationLabel: senderLabel,
                rawBody: text,
                messageId: normalized.messageId,
                timestamp: normalized.timestamp,
                commandAuthorized: access.commandAuthorized,
                provider: "telegram",
                surface: "telegram-userbot",
                originatingChannel: "telegram-userbot",
                originatingTo: senderId,
                extraContext: {
                  SenderUsername: normalized.senderUsername,
                  SenderName: normalized.senderDisplay,
                  ReplyToId: normalized.replyToMessageId,
                  NativeChannelId: normalized.chatId,
                },
                deliver: async (payload) => {
                  const outboundText = typeof payload.text === "string" ? payload.text.trim() : "";
                  if (!outboundText) {
                    return;
                  }

                  await sendTextToConversation({
                    text: outboundText,
                    replyToMessageId: payload.replyToId ? Number(payload.replyToId) : undefined,
                  });
                },
                onRecordError: (err) => {
                  console.log("telegram-userbot failed to record inbound session", {
                    accountId,
                    chatId: normalized.chatId,
                    messageId: normalized.messageId,
                    error: String(err),
                  })
                },
                onDispatchError: (err, info) => {
                  console.log("telegram-userbot failed to dispatch reply", {
                    accountId,
                    chatId: normalized.chatId,
                    messageId: normalized.messageId,
                    kind: info.kind,
                    error: String(err),
                  });
                },
              });
            }, {
              readMessageId: Number(normalized.messageId),
            });

            console.log("telegram-userbot inbound handled", {
              accountId,
              chatId: normalized.chatId,
              messageId: normalized.messageId,
              senderId,
              senderLabel,
            });

          } catch (error) {
            const rawMessage = (event as any)?.message;
            log?.error?.("telegram-userbot inbound handling failed", {
              accountId,
              chatId: String(rawMessage?.chatId ?? rawMessage?.peerId?.userId ?? rawMessage?.peerId?.chatId ?? rawMessage?.peerId?.channelId ?? ""),
              messageId: String(rawMessage?.id ?? ""),
              error: String(error),
            });
            console.log("telegram-userbot inbound preflight failed", {
              accountId,
              chatId: String(rawMessage?.chatId ?? rawMessage?.peerId?.userId ?? rawMessage?.peerId?.chatId ?? rawMessage?.peerId?.channelId ?? ""),
              messageId: String(rawMessage?.id ?? ""),
              error: String(error),
            });
          }
        };
        client.addEventHandler(eventHandler, eventBuilder);

        await waitUntilAbort(ctx.abortSignal, async () => {
          client.removeEventHandler(eventHandler, eventBuilder);

          const runtime = runtimes.get(accountId);
          if (!runtime) {
            return;
          }

          await runtime.stop();
          runtimes.delete(accountId);

          console.info("telegram-userbot disconnected", {
            accountId,
            selfLabel,
          });
        });
      },
    },

    messaging: {
      async resolveOutboundSessionRoute(params: {
        cfg: any;
        agentId: string;
        accountId?: string | null;
        target: string;
        resolvedTarget?: {
          to: string;
          kind: "user" | "group" | "channel";
          display?: string;
          source: "normalized" | "directory";
        };
        threadId?: string | number | null;
      }) {
        const rawTarget = params.resolvedTarget?.to ?? params.target;
        const targetKind = inferOutboundTargetKind(rawTarget, params.resolvedTarget?.kind);
        const target = normalizeOutboundTarget(rawTarget);
        if (!target) {
          return null;
        }

        const accountId = resolveRuntimeAccountId(params.cfg, params.accountId);
        const gram = accountId ? runtimes.get(accountId) : undefined;
        const resolved = gram ? await gram.resolvePeer(target, { kind: targetKind }).catch(() => undefined) : undefined;
        const peerId = resolved?.chatId ?? target;
        const chatType = resolved?.chatType === "group" || targetKind === "group"
          ? "group"
          : resolved?.chatType === "channel" || targetKind === "channel"
            ? "channel"
            : "direct";
        const scopedPeerId = chatType === "group" || chatType === "channel"
          ? buildScopedGroupPeerId(accountId, peerId)
          : peerId;

        return buildChannelOutboundSessionRoute({
          cfg: params.cfg,
          agentId: params.agentId,
          channel: CHANNEL_ID,
          accountId,
          peer: {
            kind: routeKindFromChatType(chatType),
            id: scopedPeerId,
          },
          chatType,
          from: accountId ?? "default",
          to: target,
          threadId: params.threadId ?? undefined,
        });
      },

      formatTargetDisplay(params: {
        target: string;
        display?: string;
        kind?: "user" | "group" | "channel";
      }) {
        const display = params.display?.trim();
        if (display) {
          return display;
        }

        const target = normalizeOutboundTarget(params.target);
        return target.startsWith("@") ? target : `telegram:${target}`;
      },
    },

    actions: {
      describeMessageTool: ({ cfg, accountId }: { cfg: any; accountId?: string | null }) => {
        const resolvedAccountId = resolveRuntimeAccountId(cfg, accountId);
        if (!resolvedAccountId) {
          return null;
        }

        return {
          actions: [ "send" ],
          capabilities: [],
        };
      },

      extractToolSend: ({ args }: { args: Record<string, unknown> }) => extractToolSend(args, "sendMessage"),

      handleAction: async ({ action, params, cfg, accountId, dryRun, toolContext }: {
        action: string;
        params: Record<string, unknown>;
        cfg: any;
        accountId?: string | null;
        dryRun?: boolean;
        toolContext?: {
          currentChannelId?: string;
        };
      }) => {
        if (action !== "send") {
          throw new Error(`telegram-userbot: unsupported message action ${action}`);
        }

        const rawTo = resolveActionTarget(params, toolContext);
        const targetKind = inferOutboundTargetKind(rawTo);
        const to = normalizeOutboundTarget(rawTo);
        const replyToId = readStringOrNumberParam(params, "replyToId") ?? readStringOrNumberParam(params, "replyTo");
        actionLog.info("telegram-userbot handleAction send", {
          requestedAccountId: accountId,
          dryRun: dryRun === true,
          rawTo,
          to,
          targetKind,
          replyToId: replyToId ?? null,
          toolContextCurrentChannelId: toolContext?.currentChannelId ?? null,
        });

        const resolvedAccountId = resolveRuntimeAccountId(cfg, accountId);
        if (!resolvedAccountId) {
          throw new Error("telegram-userbot: no configured account found");
        }
        const groupReplyAddress = consumeGroupReplyAddress({
          accountId: resolvedAccountId,
          chatId: to,
          replyToId,
        });
        const text = prefixReplyTextToAddress(
          readMessageText(params).replaceAll("\\n", "\n"),
          groupReplyAddress,
        );
        if (!text) {
          throw new Error("telegram-userbot: message text is required");
        }

        if (dryRun) {
          return jsonResult({
            ok: true,
            dryRun: true,
            to,
            accountId: resolvedAccountId,
          });
        }

        const gram = runtimes.get(resolvedAccountId);
        if (!gram) {
          throw new Error(`telegram-userbot: runtime not found for account ${resolvedAccountId}`);
        }

        const sent = await gram.sendText({
          target: to,
          text,
          targetKind,
          replyToMessageId: resolveReplyToMessageIdForTarget(rawTo, replyToId),
        });

        actionLog.info("telegram-userbot handleAction send completed", {
          accountId: resolvedAccountId,
          to,
          replyToId: replyToId ?? null,
          sentMessageId: String((sent as any)?.id ?? ""),
        });

        return jsonResult({
          ok: true,
          to,
          accountId: resolvedAccountId,
          messageId: String((sent as any)?.id ?? ""),
        });
      },
    },

    outbound: {
      async resolveTarget(ctx: { accountId: string; to: string }) {
        actionLog.info("telegram-userbot outbound resolveTarget", {
          accountId: ctx.accountId,
          rawTo: ctx.to,
        });
        const gram = runtimes.get(ctx.accountId);
        if (!gram) {
          throw new Error(`telegram-userbot: runtime not found for account ${ctx.accountId}`);
        }

        const targetKind = inferOutboundTargetKind(ctx.to);
        const target = normalizeOutboundTarget(ctx.to);

        return {
          ok: true,
          to: (await gram.resolvePeer(target, { kind: targetKind })).chatId ?? target,
        };
      },

      async sendText(ctx: {
        accountId: string;
        to: string;
        text: string;
        replyToId?: string | null;
      }) {
        actionLog.info("telegram-userbot outbound sendText", {
          accountId: ctx.accountId,
          rawTo: ctx.to,
          replyToId: ctx.replyToId ?? null,
          text: ctx.text,
        });
        const gram = runtimes.get(ctx.accountId);
        if (!gram) {
          throw new Error(`telegram-userbot: runtime not found for account ${ctx.accountId}`);
        }

        const groupReplyAddress = consumeGroupReplyAddress({
          accountId: ctx.accountId,
          chatId: ctx.to,
          replyToId: ctx.replyToId,
        });
        const targetKind = inferOutboundTargetKind(ctx.to);
        const target = normalizeOutboundTarget(ctx.to);

        const sent = await gram.sendText({
          target,
          text: prefixReplyTextToAddress(ctx.text, groupReplyAddress),
          targetKind,
          replyToMessageId: resolveReplyToMessageIdForTarget(ctx.to, ctx.replyToId),
        });

        actionLog.info("telegram-userbot outbound sendText completed", {
          accountId: ctx.accountId,
          to: target,
          targetKind,
          replyToId: ctx.replyToId ?? null,
          sentMessageId: String((sent as any)?.id ?? ""),
        });

        return {
          ok: true,
          messageId: String((sent as any)?.id ?? ""),
        };
      },

      async sendMedia(ctx: {
        accountId: string;
        to: string;
        mediaUrl?: string;
        filePath?: string;
        text?: string;
        caption?: string;
        replyToId?: string | null;
      }) {
        const gram = runtimes.get(ctx.accountId);
        if (!gram) {
          throw new Error(`telegram-userbot: runtime not found for account ${ctx.accountId}`);
        }

        actionLog.info("telegram-userbot outbound sendMedia", {
          accountId: ctx.accountId,
          to: ctx.to,
          replyToId: ctx.replyToId ?? null,
          filePath: ctx.filePath ?? null,
          mediaUrl: ctx.mediaUrl ?? null,
          hasText: Boolean(ctx.text),
          hasCaption: Boolean(ctx.caption),
        });

        const file = ctx.filePath ?? ctx.mediaUrl;
        if (!file) {
          throw new Error("telegram-userbot: sendMedia requires filePath or mediaUrl");
        }

        const sent = await gram.sendMedia({
          target: ctx.to,
          file,
          caption: ctx.caption ?? ctx.text,
          replyToMessageId: resolveReplyToMessageIdForTarget(ctx.to, ctx.replyToId),
        });

        actionLog.info("telegram-userbot outbound sendMedia completed", {
          accountId: ctx.accountId,
          to: ctx.to,
          replyToId: ctx.replyToId ?? null,
          sentMessageId: String((sent as any)?.id ?? ""),
        });

        return {
          ok: true,
          messageId: String((sent as any)?.id ?? ""),
        };
      },
    },
  };
};
