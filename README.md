# Overlooking Bot

A Slack workspace bot for archiving and oversight, built on [Bolt for JavaScript](https://slack.dev/bolt-js) (Socket Mode) and MongoDB.

## Features

| Module | What it does | Enabled by |
| --- | --- | --- |
| **Slack Storage** | Saves every message, edit and deletion the bot can see to MongoDB, and downloads shared files to disk. It can invite the bot into newly created channels, and it deletes the bot's own "joined the channel" message. | Always on; auto-join via `AUTO_JOIN_CHANNELS` |
| **App Home** | The bot's Home tab. Other modules add their own sections to it. | Always on |
| **Reaction Check** | Message shortcut `reaction_check` that lists workspace members who have not reacted to that message. | `USE_REACTION_CHECK=true` |
| **Google Drive compliance check** | Finds Google Drive / Docs links in messages and checks their sharing settings (public or domain-wide) and location (an approved Shared Drive or folder). Sends the result to the poster as an ephemeral message, and optionally to an audit channel. | `USE_GOOGLE_DRIVE_CHECK=true` |
| **Webhook relay** | A stand-in for Slack incoming webhooks: external systems POST Slack-webhook payloads to the bot, which posts them, so they do not use up app slots. Workspace owners create, edit, disable, rotate and delete webhooks from the App Home. | `USE_WEBHOOK_RELAY=true` |
| **REST API** | Read-only API over the stored messages and Drive check records. | Setting `API_KEY` |

## Requirements

- Node.js (LTS)
- MongoDB
- A Slack app with Socket Mode turned on, and:
  - a bot token (`xoxb-`)
  - an app-level token (`xapp-`) with `connections:write`
  - a user token (`xoxp-`), used to delete the bot's join messages and to invite the bot into channels
- Optional: a Google service account with read-only Drive access

## Getting started

```sh
npm ci
cp .env.example .env   # then fill in the values
npm start              # compiles TypeScript and runs dist/app.js
```

Use `npm run build:watch` to recompile on change during development.

### Docker

```sh
docker build -t overlooking-bot .
docker run --env-file .env overlooking-bot
```

If the REST API or webhook relay is on, publish their ports with `-p`. Mount a volume at `SLACK_FILE_SAVE_PREFIX` to keep downloaded files.

## Configuration

All settings come from environment variables (a `.env` file is loaded). [`.env.example`](.env.example) lists every one of them.

### Required

| Variable | Description |
| --- | --- |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | The app's signing secret |
| `SLACK_APP_TOKEN` | App-level token (`xapp-…`) for Socket Mode |
| `SLACK_USER_TOKEN` | User token (`xoxp-…`) |
| `DB_CONN_STRING` | MongoDB connection string including the database name, e.g. `mongodb://localhost:27017/overlooking` |
| `SLACK_FILE_SAVE_PREFIX` | Root directory for downloaded files, saved as `<prefix>/<user>/<file id>/<name>` |

### General

| Variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | — | Bolt log level |
| `AUTO_JOIN_CHANNELS` | `false` | Invite the bot into newly created channels |

### Reaction Check

| Variable | Default | Description |
| --- | --- | --- |
| `USE_REACTION_CHECK` | `false` | Turn the module on |
| `REACTION_USER_IGN_LIST` | — | Comma-separated user IDs to leave out of the check |

### Google Drive compliance check

| Variable | Default | Description |
| --- | --- | --- |
| `USE_GOOGLE_DRIVE_CHECK` | `false` | Turn the module on |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | — | Path to the service account key file |
| `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` | — | Or the key JSON itself (one of the two is required when the module is on) |
| `GOOGLE_DRIVE_ALLOWED_SHARED_DRIVE_IDS` | — | Comma-separated approved Shared Drive IDs |
| `GOOGLE_DRIVE_ALLOWED_FOLDER_IDS` | — | Comma-separated approved folder IDs (parents are followed up to 10 levels) |
| `GOOGLE_DRIVE_ALLOW_DOMAIN_SHARING` | `false` | Allow "anyone in the organization" sharing |
| `GOOGLE_DRIVE_REPORT_ONLY_VIOLATIONS` | `true` | Send nothing when every link is compliant |
| `GOOGLE_DRIVE_AUDIT_CHANNEL` | — | Channel ID that also receives each report |

With neither approved-location variable set, only sharing settings are checked. The service account must be able to read a file to check it; otherwise the report says the file is not accessible or cannot be checked.

### REST API

| Variable | Default | Description |
| --- | --- | --- |
| `API_KEY` | — | Turns the API on; requests must send `Authorization: Bearer <API_KEY>` |
| `API_PORT` | `3001` | Port the API listens on |

### Webhook relay

| Variable | Default | Description |
| --- | --- | --- |
| `USE_WEBHOOK_RELAY` | `false` | Turn the module on |
| `WEBHOOK_PUBLIC_BASE_URL` | — | Public HTTPS URL that reaches `WEBHOOK_PORT`, used to show full webhook URLs in the App Home (required when the relay is on) |
| `WEBHOOK_PORT` | `3000` | Port the relay listens on; must differ from `API_PORT` |

## REST API

All routes live under `/api` and need the bearer token. Lists are sorted newest first and paginated with an `_id` cursor:

- `limit`: page size, default 50, max 200
- `before`: the `_id` of the last item on the previous page

Responses have the shape `{ data, total, hasMore }`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/messages?collection=` | List messages; `collection` is `messages` (default), `changedMessages` or `deletedMessages` |
| `GET` | `/api/messages/:id?collection=` | One message |
| `GET` | `/api/drive/jobs?status=` | List Drive check records; `status` is `pending`, `completed` or `error` |
| `GET` | `/api/drive/jobs/:id` | One Drive check record |

```sh
curl -H "Authorization: Bearer $API_KEY" "http://localhost:3001/api/messages?limit=10"
```

## Webhook relay

1. As a workspace owner, open the bot's App Home and click **New webhook**.
2. Pick a default channel, any other allowed channels, the display name and icon, and whether callers may override the name and icon.
3. Use the resulting `<WEBHOOK_PUBLIC_BASE_URL>/services/<id>/<secret>` URL exactly like a Slack incoming webhook:

```sh
curl -X POST -H 'Content-Type: application/json' \
  -d '{"text":"Hello from webhook"}' \
  https://bot.example.com/services/WXXXXXXXXXX/xxxxxxxx
```

Payloads support `text`, `blocks`, `attachments`, `thread_ts`, `channel`, `username`, `icon_emoji`, `icon_url` and the other Slack webhook fields, and error responses (`no_service`, `channel_not_found`, `invalid_payload`, …) match Slack's. The bot must already be in the target channel. Messages posted through a webhook are also archived in the `messages` collection.

## Scripts

### Add the bot to every channel

Lists the channels visible to `SLACK_USER_TOKEN` and invites the bot into each one that user has joined and the bot has not.

```sh
npx ts-node src/scripts/join-all-channels.ts --dry-run   # show what would be invited
npx ts-node src/scripts/join-all-channels.ts
```

`INVITE_DELAY_MS` sets the pause between invites (default 1500 ms).

## Development

```sh
npm test   # runs src/**/*.test.ts
```

### Layout

```
src/
├── app.ts            # entry point: loads config, connects to the DB, starts Bolt and the modules
├── config.ts         # environment variable parsing
├── db.ts             # MongoDB collections
├── modules/
│   ├── app-home/
│   ├── google-drive/
│   ├── reaction-check/
│   ├── slack-storage/
│   └── webhook-relay/
├── scripts/          # one-off maintenance scripts
├── utils/
└── web/              # REST API (Express)
```

### MongoDB collections

| Collection | Contents |
| --- | --- |
| `messages` | Every message received, including ones posted through webhooks |
| `changedMessages` | `message_changed` events |
| `deletedMessages` | `message_deleted` events |
| `driveComplianceJobs` | Drive check records |
| `webhooks` | Webhook settings (secrets are stored only as hashes) |
