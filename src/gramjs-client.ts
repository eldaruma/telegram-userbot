import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import type { PluginConfig, ResolvedTelegramTarget, SendMediaArgs, SendTextArgs, ChatType } from "./types.ts";

function toStringId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

function inferChatTypeFromRaw(raw: string): ChatType {
  if (raw.startsWith("-100")) return "channel";
  if (raw.startsWith("-")) return "group";
  return "direct";
}

function getChatIdFromPeer(peer: any, fallback?: string): string | undefined {
  const userId = toStringId(peer?.userId);
  if (userId) return userId;

  const chatId = toStringId(peer?.chatId);
  if (chatId) return `-${chatId.replace(/^-/, "")}`;

  const channelId = toStringId(peer?.channelId);
  if (channelId) return `-100${channelId.replace(/^-100|-/, "")}`;

  return fallback;
}

function toSafeInteger(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function uniqueCandidates(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];

  for (const value of values) {
    const key = typeof value === "object" ? String(value) : `${typeof value}:${String(value)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
}

function buildPeerCandidates(raw: string, kind?: "user" | "group" | "channel"): unknown[] {
  const candidates: unknown[] = [ raw ];
  const numeric = toSafeInteger(raw);
  if (numeric !== undefined) {
    candidates.push(numeric);
  }

  if ((kind === "group" || kind === "channel") && /^\d+$/.test(raw)) {
    const supergroupId = `-100${raw}`;
    const basicGroupId = `-${raw}`;
    candidates.push(supergroupId, toSafeInteger(supergroupId), basicGroupId, toSafeInteger(basicGroupId));
  }

  return uniqueCandidates(candidates.filter((value) => value !== undefined));
}

function collectDialogKeys(dialog: any): Set<string> {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const id = toStringId(value);
    if (id) {
      keys.add(id);
    }
  };

  add(dialog?.id);
  add(dialog?.inputEntity);
  add(dialog?.entity?.id);
  add(getChatIdFromPeer(dialog?.inputEntity));
  add(getChatIdFromPeer(dialog?.entity));

  const inputChatId = toStringId(dialog?.inputEntity?.chatId);
  if (inputChatId) {
    keys.add(inputChatId);
    keys.add(`-${inputChatId.replace(/^-/, "")}`);
  }

  const inputChannelId = toStringId(dialog?.inputEntity?.channelId);
  if (inputChannelId) {
    keys.add(inputChannelId);
    keys.add(`-100${inputChannelId.replace(/^-100|-/, "")}`);
  }

  return keys;
}

function buildTargetKeys(raw: string, kind?: "user" | "group" | "channel"): Set<string> {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const id = toStringId(value);
    if (id) {
      keys.add(id);
    }
  };

  add(raw);
  if ((kind === "group" || kind === "channel") && /^\d+$/.test(raw)) {
    add(`-100${raw}`);
    add(`-${raw}`);
  }
  if (raw.startsWith("-100")) {
    add(raw.replace(/^-100/, ""));
  } else if (raw.startsWith("-")) {
    add(raw.replace(/^-/, ""));
  }

  return keys;
}

export class GramJsClientManager {
  private client: TelegramClient;
  private started = false;

  constructor(private readonly config: PluginConfig) {
    this.client = new TelegramClient(
      new StringSession(config.sessionString),
      config.apiId,
      config.apiHash,
      {
        connectionRetries: 5
      }
    );
  }

  async start(): Promise<void> {
    if (this.started) return;

    await this.client.connect();

    const authorized = await this.client.checkAuthorization();
    if (!authorized) {
      throw new Error("GramJS client connected, but session is not authorized.");
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.client.disconnect();
    this.started = false;
  }

  getClient(): TelegramClient {
    return this.client;
  }

  async getMe() {
    return this.client.getMe();
  }

  private async resolveDialogPeer(raw: string, kind?: "user" | "group" | "channel"): Promise<ResolvedTelegramTarget | undefined> {
    const targetKeys = buildTargetKeys(raw, kind);
    const dialogs = await this.client.getDialogs({ limit: 200 }).catch(() => []);

    for (const dialog of dialogs as any[]) {
      if (kind === "user" && !dialog?.isUser) {
        continue;
      }
      if ((kind === "group" || kind === "channel") && !dialog?.isGroup && !dialog?.isChannel) {
        continue;
      }

      const dialogKeys = collectDialogKeys(dialog);
      const matched = [ ...targetKeys ].some((key) => dialogKeys.has(key));
      if (!matched) {
        continue;
      }

      const chatId = getChatIdFromPeer(dialog?.inputEntity) ?? toStringId(dialog?.id) ?? raw;
      const chatType =
        kind === "group"
          ? "group"
          : kind === "channel"
            ? "channel"
            : dialog?.isGroup
              ? "group"
              : dialog?.isChannel
                ? "channel"
                : "direct";

      return {
        raw,
        peer: dialog.inputEntity,
        chatId,
        chatType,
      };
    }

    return undefined;
  }

  async resolvePeer(rawTarget: unknown, options?: {
    kind?: "user" | "group" | "channel";
  }): Promise<ResolvedTelegramTarget> {
    if (typeof rawTarget !== "string") {
      const entity = await this.client.getInputEntity(rawTarget as any).catch(() => rawTarget);

      return {
        raw: String(rawTarget ?? ""),
        peer: entity as any
      };
    }

    const raw = rawTarget.trim();
    const kind = options?.kind;

    if (raw === "me" || raw === "self" || raw === "saved") {
      return {
        raw,
        peer: "me",
        chatId: "me",
        chatType: "direct"
      };
    }

    let entity: unknown;
    for (const candidate of buildPeerCandidates(raw, kind)) {
      entity = await this.client.getInputEntity(candidate as any).catch(() => undefined);
      if (entity) {
        break;
      }
    }

    if (!entity) {
      const dialogResolved = await this.resolveDialogPeer(raw, kind);
      if (dialogResolved) {
        return dialogResolved;
      }
    }

    if (!entity) {
      entity = await this.client.getInputEntity(raw);
    }

    const chatId = getChatIdFromPeer(entity, raw);

    return {
      raw,
      peer: entity as any,
      chatId,
      chatType: inferChatTypeFromRaw(chatId ?? raw)
    };
  }

  async sendText(args: SendTextArgs) {
    const resolved = await this.resolvePeer(args.target, { kind: args.targetKind });

    return this.client.sendMessage(resolved.peer as any, {
      message: args.text,
      replyTo: args.replyToMessageId
    });
  }

  async markRead(target: unknown, messageId?: number): Promise<void> {
    if (!messageId || !Number.isFinite(messageId)) {
      return;
    }

    const resolved = await this.resolvePeer(target);
    await this.client.markAsRead(resolved.peer as any, messageId).catch(() => undefined);
  }

  async withTyping<T>(target: unknown, fn: () => Promise<T>, options?: {
    readMessageId?: number;
  }): Promise<T> {
    let peer: unknown;
    let readMarked = false;

    const sendTyping = async () => {
      if (!peer) {
        peer = (await this.resolvePeer(target)).peer;
      }

      if (!readMarked) {
        readMarked = true;
        await this.markRead(peer, options?.readMessageId).catch(() => undefined);
      }

      await this.client.invoke(new Api.messages.SetTyping({
        peer: peer as any,
        action: new Api.SendMessageTypingAction(),
      }));
    };

    const tick = () => {
      void sendTyping().catch(() => undefined);
    };
    tick();
    const interval = setInterval(tick, 4000);

    try {
      return await fn();
    } finally {
      clearInterval(interval);

      if (peer) {
        await this.client.invoke(new Api.messages.SetTyping({
          peer: peer as any,
          action: new Api.SendMessageCancelAction(),
        })).catch(() => undefined);
      }
    }
  }

  async sendMedia(args: SendMediaArgs) {
    const resolved = await this.resolvePeer(args.target);

    return this.client.sendFile(resolved.peer as any, {
      file: args.file,
      caption: args.caption,
      replyTo: args.replyToMessageId
    });
  }
}
