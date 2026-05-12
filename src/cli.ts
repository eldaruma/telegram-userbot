import readline from "node:readline";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { readConfigFileSnapshotForWrite, updateConfig, type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

const CHANNEL_ID = "telegram-userbot";
const CLI_COMMAND = "telegram-userbot";

type TelegramAuthResult = {
  apiId: number;
  apiHash: string;
  sessionString: string;
};

type PromptApi = {
  ask: (question: string) => Promise<string>;
  askRequired: (question: string) => Promise<string>;
  askPositiveInteger: (question: string) => Promise<number>;
  askYesNo: (question: string, defaultValue?: boolean) => Promise<boolean>;
  close: () => void;
};

function formatBackupTimestamp(date: Date): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function buildConfigBackupPath(configPath: string): string {
  const dir = path.dirname(configPath);
  const fileName = path.basename(configPath);
  const suffix = `${formatBackupTimestamp(new Date())}-telegram-userbot-auth`;
  return path.join(dir, `${fileName}.bak-${suffix}`);
}

async function createConfigBackup(configPath: string): Promise<string | null> {
  const raw = await fs.readFile(configPath, "utf8").catch(() => null);
  if (raw === null) {
    return null;
  }

  const backupPath = buildConfigBackupPath(configPath);
  await fs.writeFile(backupPath, raw, "utf8");
  return backupPath;
}

function printRestartNotice(): void {
  console.log("");
  console.log("After applying config changes, restart OpenClaw:");
  console.log("openclaw gateway restart");
}

function createPrompt(): PromptApi {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, resolve);
    });

  return {
    ask,
    async askRequired(question: string): Promise<string> {
      for (;;) {
        const answer = (await ask(question)).trim();
        if (answer) {
          return answer;
        }

        console.log("Value is required.");
      }
    },
    async askPositiveInteger(question: string): Promise<number> {
      for (;;) {
        const answer = (await ask(question)).trim();
        if (!/^[1-9]\d*$/.test(answer)) {
          console.log("Enter a positive integer.");
          continue;
        }

        const parsed = Number(answer);
        if (!Number.isSafeInteger(parsed)) {
          console.log("Number is too large.");
          continue;
        }

        return parsed;
      }
    },
    async askYesNo(question: string, defaultValue = false): Promise<boolean> {
      for (;;) {
        const answer = (await ask(question)).trim().toLowerCase();
        if (!answer) {
          return defaultValue;
        }

        if ([ "y", "yes", "да", "д" ].includes(answer)) {
          return true;
        }

        if ([ "n", "no", "нет", "н" ].includes(answer)) {
          return false;
        }

        console.log("Please answer yes or no.");
      }
    },
    close(): void {
      rl.close();
    },
  };
}

function resolveDefaultAccountId(config: OpenClawConfig): string {
  const accounts = config?.channels?.[ CHANNEL_ID ]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return "default";
  }

  const firstAccountId = Object.keys(accounts).find((accountId) => accountId.trim());
  return firstAccountId?.trim() || "default";
}

function buildAccountPayload(auth: TelegramAuthResult): Record<string, unknown> {
  return {
    enabled: true,
    apiId: auth.apiId,
    apiHash: auth.apiHash,
    sessionString: auth.sessionString,
  };
}

function buildAccountConfigFragment(auth: TelegramAuthResult): Record<string, unknown> {
  return {
    ...buildAccountPayload(auth),
    allowFrom: [ "*" ],
    groupPolicy: "mention",
  };
}

function buildConfigFragment(accountId: string, auth: TelegramAuthResult): Record<string, unknown> {
  return {
    channels: {
      [ CHANNEL_ID ]: {
        accounts: {
          [ accountId ]: buildAccountConfigFragment(auth),
        },
      },
    },
  };
}

function applyAuthToConfig(config: OpenClawConfig, accountId: string, auth: TelegramAuthResult): OpenClawConfig {
  const channels = config.channels && typeof config.channels === "object" ? config.channels : {};
  const channelConfig = channels[ CHANNEL_ID ] && typeof channels[ CHANNEL_ID ] === "object" ? channels[ CHANNEL_ID ] : {};
  const accounts = channelConfig.accounts && typeof channelConfig.accounts === "object" ? channelConfig.accounts : {};
  const existingAccount = accounts[ accountId ] && typeof accounts[ accountId ] === "object" ? accounts[ accountId ] : {};

  return {
    ...config,
    channels: {
      ...channels,
      [ CHANNEL_ID ]: {
        ...channelConfig,
        accounts: {
          ...accounts,
          [ accountId ]: {
            ...existingAccount,
            ...buildAccountPayload(auth),
            enabled: existingAccount.enabled ?? true,
            allowFrom: existingAccount.allowFrom ?? [ "*" ],
            groupPolicy: existingAccount.groupPolicy ?? "mention",
          },
        },
      },
    },
  };
}

async function runTelegramAuthorization(prompt: PromptApi): Promise<TelegramAuthResult> {
  const apiId = await prompt.askPositiveInteger("Please enter your apiId: ");
  const apiHash = await prompt.askRequired("Please enter your apiHash: ");
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.start({
      phoneNumber: async () => await prompt.askRequired("Please enter your number: "),
      password: async () => await prompt.askRequired("Please enter your password: "),
      phoneCode: async () => await prompt.askRequired("Please enter the code you received: "),
      onError: (error) => {
        console.log(error);
      },
    });

    return {
      apiId,
      apiHash,
      sessionString: String(client.session.save()),
    };
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

async function runTelegramUserbotAuth(config: OpenClawConfig): Promise<void> {
  const prompt = createPrompt();

  try {
    console.log("Starting Telegram Userbot authorization...");

    const auth = await runTelegramAuthorization(prompt);
    console.log("Telegram authorization completed successfully.");
    console.log("");
    console.log("Session string:");
    console.log(auth.sessionString);
    console.log("");

    const defaultAccountId = resolveDefaultAccountId(config);
    const rawAccountId = await prompt.ask(`Enter account id for config [${defaultAccountId}]: `);
    const accountId = rawAccountId.trim() || defaultAccountId;
    const shouldUpdateConfig = await prompt.askYesNo("Update OpenClaw config automatically? [y/N]: ", false);
    const { snapshot } = await readConfigFileSnapshotForWrite();

    if (!shouldUpdateConfig) {
      console.log("");
      console.log("JSON fragment for manual insertion:");
      console.log(JSON.stringify(buildConfigFragment(accountId, auth), null, 2));
      printRestartNotice();
      return;
    }

    if (!snapshot.valid) {
      console.log("");
      console.log("Automatic config update is unavailable because the current OpenClaw config is invalid.");
      if (snapshot.issues.length > 0) {
        console.log("Config issues:");
        for (const issue of snapshot.issues) {
          console.log(`- ${issue.path || "<root>"}: ${issue.message}`);
        }
      }
      console.log("");
      console.log("JSON fragment for manual insertion:");
      console.log(JSON.stringify(buildConfigFragment(accountId, auth), null, 2));
      printRestartNotice();
      return;
    }

    const backupPath = await createConfigBackup(snapshot.path);
    await updateConfig((currentConfig) => applyAuthToConfig(currentConfig, accountId, auth));

    console.log("");
    console.log(`OpenClaw config updated: ${snapshot.path}`);
    console.log(`Configured account id: ${accountId}`);
    if (backupPath) {
      console.log(`Config backup created: ${backupPath}`);
    }
    printRestartNotice();
  } finally {
    prompt.close();
  }
}

export function registerTelegramUserbotCli(program: any, config: OpenClawConfig): void {
  program
    .command(CLI_COMMAND)
    .description("Telegram Userbot CLI utilities")
    .option("--hello", "Print a greeting from the telegram-userbot plugin")
    .option("--auth", "Authorize a Telegram account for telegram-userbot")
    .action(async (options: { hello?: boolean; auth?: boolean }) => {
      const enabledFlags = [ options.hello, options.auth ].filter(Boolean).length;

      if (enabledFlags === 0) {
        console.log("Specify one flag: --hello or --auth");
        return;
      }

      if (enabledFlags > 1) {
        console.log("Use only one flag at a time: --hello or --auth");
        return;
      }

      if (options.hello) {
        console.log("Hello from telegram-userbot");
        return;
      }

      if (options.auth) {
        await runTelegramUserbotAuth(config);
      }
    });
}

export function getTelegramUserbotCliDescriptors(): Array<{
  name: string;
  description: string;
  hasSubcommands: boolean;
}> {
  return [
    {
      name: CLI_COMMAND,
      description: "Telegram Userbot CLI utilities",
      hasSubcommands: false,
    },
  ];
}
