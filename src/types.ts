import { GramJsClientManager } from './gramjs-client';

export type RuntimeMap = Map<string, GramJsClientManager>;

export type PluginConfig = {
  apiId: number;
  apiHash: string;
  sessionString: string;
  allowFrom: string[];
  groupPolicy: "open" | "mention";
  accountId?: string;
  enabled?: boolean;
};

export type ChatType = "direct" | "group" | "channel";

export type NormalizedInbound = {
  channel: "telegram-userbot";
  accountId: string;
  chatId: string;
  senderId?: string;
  senderUsername?: string;
  senderDisplay?: string;
  messageId: string;
  text?: string;
  replyToMessageId?: string;
  chatType: "direct" | "group" | "channel";
  timestamp?: number;
  isOutgoing: boolean;
  replyTarget?: unknown;
  raw: unknown;
};

export type ResolvedTelegramTarget = {
  raw: string;
  peer: string | number | bigint;
  chatId?: string;
  chatType?: "direct" | "group" | "channel";
};

export type SendTextArgs = {
  target: unknown;
  text: string;
  targetKind?: "user" | "group" | "channel";
  replyToMessageId?: number;
};

export type SendMediaArgs = {
  target: unknown;
  file: string;
  caption?: string;
  replyToMessageId?: number;
};
