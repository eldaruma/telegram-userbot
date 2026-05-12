# Telegram Userbot

Telegram Userbot plugin for [OpenClaw](https://github.com/openclaw/openclaw) — connects as a regular Telegram user account (not a bot) via MTProto using [GramJS](https://github.com/gram-js/gramjs)

> **WARNING**: Using a user account for automated messaging may violate Telegram's Terms of Service. Use a dedicated secondary account. Your account could be banned or restricted.


## Features

- **MTProto Client API** — operates as a user account, not a bot
- **DM & Group support** — private chats, groups, supergroups, forum topics
- **@Mention detection** — respond only when mentioned in groups (text, caption, and ID-based mentions)
- **Read receipts** — mark messages as read
- **Multi-account** — run multiple Telegram accounts simultaneously

## Requirements

- OpenClaw >= 2026.5.7
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)
- Node.js >= 22

## Installation

```bash
openclaw plugins install clawhub:telegram-userbot
```

## Setup

### 1. Get Telegram API credentials

- Go to https://my.telegram.org
- Log in with your phone number
- Go to "API development tools"
- Create a new application
- Copy the `api_id` and `api_hash`


### 2. Log in to your telegram account

Log in to your telegram account via cli using API credentials and phone number

```bash
openclaw telegram-userbot --auth
```

Follow the steps in the console

```bash
Starting Telegram Userbot authorization...
Please enter your apiId: 12345678
Please enter your apiHash: c4b9c0fde16342afe52907847df27596
[2026-05-10T16:01:24.570] [INFO] - [Running gramJS version 2.26.21]
[2026-05-10T16:01:24.578] [INFO] - [Connecting to x.x.x.x:80/TCPFull...]
[2026-05-10T16:01:25.804] [INFO] - [Connection to x.x.x.x:80/TCPFull complete!]
[2026-05-10T16:01:25.808] [INFO] - [Using LAYER 198 for initial connect]
Please enter your number: +1 XXX XXX XXXX
Please enter the code you received: 12345
[2026-05-10T16:01:56.384] [INFO] - [Signed in successfully as <USER>]
[2026-05-10T16:01:56.388] [WARN] - [Disconnecting...]
[2026-05-10T16:01:56.390] [INFO] - [Disconnecting from x.x.x.x:80/TCPFull...]
Telegram authorization completed successfully.

Session string:
1BAAOMTQ5LjE1NC4xNjcuOTEAUQZ1aeNwM6O5lSD+kX/irkoUFMj+nUy5hRhpVqbkuOhEP+JOT4FEobUVnUKPnpKPxXdwQ9e
js+tWQTto86Heab4XSfyOoWK5WDA/dMhFYBuFxms/FF946HerCM+i5nh0gu//YGmIEntw7gY8JQQNYuvLB5SGdsDpa50LcJ5fK
686qqUsnlqmRTONdVG3EOdnV8RbTFTHg5BWLztfD5uLt1lIr/bG+BWCPCLAaA85yPL8SgGRLtX4QYXrnaEVmKui8SWq5J/
Ol86oZGlrMcnj5DRQ/VeYY7yGcESwnoTSx44irCyk9GelCavzs/dfN6sAYfoZb6cN/L9jxEYXkkCQdig=
```

Since the plugin supports connecting multiple accounts, at this step the cli will ask you for the account ID, if you do not enter anything, the [default] key will be applied. You can also enter your own value.

```bash
Enter account id for config [default]: [2026-05-10T16:01:56.402] [INFO] - [connection closed]
[2026-05-10T16:02:02.096] [WARN] - [Disconnecting...]
[2026-05-10T16:02:02.103] [INFO] - [Disconnecting from x.x.x.x:80/TCPFull...]
```

In the next step, you must confirm or reject the automatic update of the openclaw.json configuration file. If you reject it or receive an error updating the file, the cli will display an openclaw.json configuration fragment that you must add manually.

Update **yes**
```bash
Update OpenClaw config automatically? [y/N]: y

Config overwrite: /root/.openclaw/openclaw.json (sha256 97c4b55e61901aa71ff40898b5ebfbadd0f8fb9cd0145f3a08a5e5163783258a -> 6447683c687ceeb0dba09b2ca5187967e979ad2663d901977c608b6a09c9c432, backup=/root/.openclaw/openclaw.json.bak)

OpenClaw config updated: /root/.openclaw/openclaw.json
Configured account id: default
Config backup created: /root/.openclaw/openclaw.json.bak-20260512-084914-telegram-userbot-auth

After applying config changes, restart OpenClaw:

openclaw gateway restart
```

Update **no**
```bash
Update OpenClaw config automatically? [y/N]: n

JSON fragment for manual insertion:
{
  "channels": {
    "telegram-userbot": {
      "accounts": {
        "default": {
          "enabled": true,
          "apiId": 12345678,
          "apiHash": "apiHash",
          "sessionString": "sessionString",
          "allowFrom": [
            "*"
          ],
          "groupPolicy": "mention"
        }
      }
    }
  }
}

After applying config changes, restart OpenClaw:

openclaw gateway restart
```

### 3. Restart OpenClaw gateway

```bash
openclaw gateway restart
```


## Configuration Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `apiId` | number | required | Telegram API ID |
| `apiHash` | string | required | Telegram API hash |
| `sessionString` | string | `""` | Authenticated StringSession |
| `allowFrom` | string[] | `["*"]` | Allowed sender IDs/usernames |
| `groupPolicy` | `"open"` \| `"mention"` | `"mention"` | Group message handling |


## Multi-Account

The plugin also supports adding multiple accounts. You can run the cli command many times

```bash
openclaw telegram-userbot --auth
```

And in the account ID step, enter a value other than the first [default] or your previously entered one.
account ID must be unique

```bash
Enter account id for config [default]: [2026-05-10T16:01:56.402] [INFO] - [connection closed]
[2026-05-10T16:02:02.096] [WARN] - [Disconnecting...]
[2026-05-10T16:02:02.103] [INFO] - [Disconnecting from x.x.x.x:80/TCPFull...]

second
```

```json
{
  "channels": {
    "telegram-userbot": {
      "accounts": {
        "default": {
          "enabled": true,
          "apiId": 12345678,
          "apiHash": "apiHash",
          "sessionString": "sessionString",
          "allowFrom": [
            "*"
          ],
          "groupPolicy": "mention"
        },
        "second": {
          "enabled": true,
          "apiId": 12345678,
          "apiHash": "apiHash",
          "sessionString": "sessionString",
          "allowFrom": [
            "*"
          ],
          "groupPolicy": "mention"
        }
      }
    }
  }
}
```


## Development

```bash
npm install          # install dependencies
npm run build        # run build script
```

## License

MIT
