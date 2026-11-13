# Overlooking Bot

A Slack workspace bot for archiving and oversight, built on [Bolt for JavaScript](https://slack.dev/bolt-js) (Socket Mode) and MongoDB.

## Features

| Module | What it does | Enabled by |
| --- | --- | --- |
| **Slack Storage** | Saves every message, edit and deletion the bot can see to MongoDB, and downloads shared files to disk. It can invite the bot into newly created channels, and it deletes the bot's own "joined the channel" message. | Always on; auto-join via `AUTO_JOIN_CHANNELS` |
| **App Home** | The bot's Home tab. Other modules add their own sections to it. | Always on |
| **Reaction Check** | Message shortcut `reaction_check` that lists workspace members who have not reacted to that message. | `USE_REACTION_CHECK=true` |
| **Google Drive compliance check** | Finds Google Drive / Docs links in messages and checks their sharing settings (public or domain-wide) and location (an approved Shared Drive or folder). Sends the result to the poster as an ephemeral message, and optionally to an audit channel, where reports can be rechecked. | `USE_GOOGLE_DRIVE_CHECK=true` |
| **Webhook relay** | A stand-in for Slack incoming webhooks: external systems POST Slack-webhook payloads to the bot, which posts them, so they do not use up app slots. Workspace owners create, edit, disable, rotate and delete webhooks from the App Home. | `USE_WEBHOOK_RELAY=true` |
| **REST API** | Read-only API over the stored messages and Drive check records. | Setting `API_KEY` |

## Requirements

- Node.js (LTS)
- MongoDB
- A Slack app with Socket Mode turned on, and:
  - a bot token (`xoxb-`)
  - an app-level token (`xapp-`) with `connections:write`
  - bot scopes including `reactions:write` (status reactions on audit reports) and the ones the modules already use
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
docker build -t overlooking-bot \
  --build-arg APP_VERSION=1.0.0 --build-arg APP_COMMIT=$(git rev-parse --short HEAD) .
docker run --env-file .env -p 8080:8080 overlooking-bot
```

`APP_VERSION` and `APP_COMMIT` are returned as the `X-App-Version` and `X-App-Commit` response headers. Publish the `LISTEN_ADDR` port (`-p`) when the REST API or webhook relay is on. Mount a volume at `SLACK_FILE_SAVE_PREFIX` to keep downloaded files.

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
| `GOOGLE_DRIVE_AUDIT_CHANNEL` | — | Channel ID that also receives each report; turns on rechecks and the App Home overview |
| `GOOGLE_DRIVE_RECHECK_ALLOWED` | `everyone` | Who may recheck and mark files handled: `everyone`, `admins` (workspace owners and admins), or `owners` (workspace owners only). Anything else fails at startup |

#### Rechecking

When `GOOGLE_DRIVE_AUDIT_CHANNEL` is set, each audit report has a "重新檢查" button. The poster's ephemeral message is unchanged and is never notified about rechecks. The audit message itself is never edited:

- It carries one status reaction for the latest overall state: `warning` (any violation), `question` (no violation, but some file could not be checked or accessed), `white_check_mark` (all compliant). `hourglass_flowing_sand` shows while a recheck runs.
- Each recheck posts a reply in the audit message's thread with every file's status, what changed since the previous check, who triggered it, the check time and another recheck button. A file whose recheck fails (Drive says it is not accessible or cannot be checked, or the check throws) keeps its stored result, `resolvedAt`, `lastCheckedAt` and job `status`: the reply shows "❗ 複查失敗，保留上次結果" for it, and only a history entry marked `failed: true` (with `errorMessage` when known) is added; `checkCount` is not bumped. Other files in the same report are updated normally. If every file fails, the reply says nothing was changed, and the reaction goes back to what it was before the hourglass. The same applies if the whole recheck throws.
- If the audit message was deleted, the person who clicked gets a private notice instead.
- Two rechecks of the same report cannot run at once: a report is locked all-or-nothing (a lock older than 2 minutes is ignored), and the second clicker is told to wait.

The App Home lists files whose latest result is not compliant and that were not marked handled (newest first, up to 20) with a link to the audit message and a menu with "🔄 重新檢查" and "✔️ 標記已處理", for everyone who is allowed to recheck. Rechecks are manual; nothing runs on a schedule.

##### Marking an item as handled

When an item can never turn compliant (the file was deleted, the bot lost access), someone who is allowed to recheck can mark that one file (one job document) as handled, from the App Home menu or from the button on its section in a recheck reply. A modal asks for a required explanation (up to 500 characters); the permission is checked on click and again on submit. This sets `manualResolution` (`{ by, at, note }`) on the job and appends a history entry with `kind: "manual_resolution"` and the `note`; the stored `result` is not changed. The audit thread gets a reply naming the person, the file and the explanation, and the status reaction is recomputed counting handled files as compliant. If the audit message was deleted, the mark is still saved and the person is told privately. Only open items (a non-compliant result, not yet handled) can be marked; the write is conditional on that, so a file that turned compliant or was handled meanwhile is refused with a message. Handled items leave the App Home list. A later recheck that finds violations again removes `manualResolution` ("已處理標記已清除" in the reply); a compliant or failed recheck leaves it in place.

Each `driveComplianceJobs` document (one per message and file) also stores: `user` (poster), `auditMessage` (`{ channel, ts }`), `result` (the latest result), `lastCheckedAt`, `checkCount`, `manualResolution`, `history` (`[{ kind?, checkedAt, checkedBy, status, violations, failed?, errorMessage?, note? }]`, the initial check first with `checkedBy: "system"`), `resolvedAt` (set when a non-compliant file turns compliant, cleared if it regresses) and a temporary `recheckingAt`/`recheckingToken` lock. Documents created before this feature lack these fields.

With neither approved-location variable set, only sharing settings are checked. The service account must be able to read a file to check it; otherwise the report says the file is not accessible or cannot be checked.

### HTTP server

The REST API and the webhook relay share one HTTP server. It starts only when at least one of them is on.

| Variable | Default | Description |
| --- | --- | --- |
| `LISTEN_ADDR` | `:8080` | Address to listen on, e.g. `:8080` or `127.0.0.1:8080`. Replaces the old `WEBHOOK_PORT` and `API_PORT`, which now stop the bot at startup if set |

### REST API

| Variable | Default | Description |
| --- | --- | --- |
| `API_KEY` | — | Turns the API on; requests must send `Authorization: Bearer <API_KEY>`. Must be base64 of at least 32 bytes (`openssl rand -base64 32`) |

### Webhook relay

| Variable | Default | Description |
| --- | --- | --- |
| `USE_WEBHOOK_RELAY` | `false` | Turn the module on |
| `WEBHOOK_PUBLIC_BASE_URL` | — | Public HTTPS URL that reaches `LISTEN_ADDR`, used to show full webhook URLs in the App Home (required when the relay is on) |

## REST API

All routes live under `/api/v1` and need the bearer token. The full contract is [`api/openapi.yaml`](api/openapi.yaml) (OpenAPI 3.1), generated from `src/web/schemas.ts`; run `npm run openapi` after changing the schemas (`npm test` fails while the file is stale).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/messages?collection=` | List messages; `collection` is `messages` (default), `changed_messages` or `deleted_messages` |
| `GET` | `/api/v1/messages/:id?collection=` | One message |
| `GET` | `/api/v1/drive/jobs?status=&complianceStatus=&open=` | List Drive check records; `status` is `pending`, `completed` or `error`; `complianceStatus` (the latest result) is `compliant`, `violations`, `cannot_check` or `not_accessible`; `open=true` keeps items that have a result which is not compliant and were not marked handled, `open=false` is the exact complement (including items with no result yet) |
| `GET` | `/api/v1/drive/jobs/:id` | One Drive check record |

Lists are sorted newest first and return `{ items, nextCursor }`. Pass `nextCursor` back as `?cursor=` for the next page; it is `null` on the last page. `limit` defaults to 50 and is clamped to 200.

Message records use camelCase fields (`threadTs`, `messageTs`, `previousText`, …). Each one also carries `slackEvent`, the Slack event exactly as stored, whose fields keep Slack's snake_case names.

Errors look like `{ "error": { "code": "invalid_request", "message": "…", "details": { "fields": { "limit": "…" } } } }`, with codes `invalid_request` (400), `unauthenticated` (401), `not_found` (404) and `internal_error` (500).

```sh
curl -H "Authorization: Bearer $API_KEY" "http://localhost:8080/api/v1/messages?limit=10"
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
└── web/              # shared HTTP server and REST API (Express); schemas.ts feeds api/openapi.yaml
```

### MongoDB collections

| Collection | Contents |
| --- | --- |
| `messages` | Every message received, including ones posted through webhooks |
| `changedMessages` | `message_changed` events |
| `deletedMessages` | `message_deleted` events |
| `driveComplianceJobs` | Drive check records |
| `webhooks` | Webhook settings (secrets are stored only as hashes) |
