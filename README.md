# LSRP Number Bot

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

A Discord bot that automatically assigns sequential badge numbers to members with a specific role. Built for FiveM roleplay communities—originally for Los Santos State Roleplay (LSRP)—it manages member identification, welcome messages, and nickname formatting with full persistence via MariaDB/MySQL.

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Discord Setup](#discord-setup)
- [Slash Commands](#slash-commands)
- [Project Structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

| Feature | Description |
|---------|-------------|
| **Automatic numbering** | Assigns sequential badge numbers (e.g., 2000, 2001, 2002) to members with the numbering role |
| **Nickname formatting** | Sets nicknames to `{number} | {username}` format for easy identification |
| **Welcome messages** | Sends customizable DM embeds to new members with their badge number |
| **Number reservation** | Reserve specific numbers (e.g., 2000, 3000) for special members—assign manually via `/adduser` |
| **Role-based permissions** | Director, management, admin, and moderator role hierarchy for command access |
| **Rate limiting** | Configurable command throttling to prevent abuse |
| **Health monitoring** | `/health` command for uptime, latency, and database status checks |
| **MariaDB/MySQL persistence** | All member numbers and bot state stored in database |
| **Periodic validation** | Auto-corrects next number and cleans up departed members |

---

## Prerequisites

- **Node.js** 18 or higher
- **MariaDB** or **MySQL** (MariaDB 10.5+ recommended for full schema support)
- **Discord Bot** with appropriate permissions and intents

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/daaruski/lsrp-number-bot.git
cd lsrp-number-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Environment variables

Copy the example file and fill in your values:

```bash
# Windows
copy .env.example .env

# Linux / macOS
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Required
DISCORD_TOKEN=your_discord_bot_token
DATABASE_PASSWORD=your_database_password

# Optional (defaults shown)
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_NAME=lsrp_bot
DATABASE_USER=root

# Optional overrides
# STARTING_NUMBER=2000
# SKIP_ROLE_IDS=role_id_1,role_id_2
```

### 4. Configuration file

Copy the example and fill in your Discord IDs:

```bash
# Windows
copy config.example.json config.json

# Linux / macOS
cp config.example.json config.json
```

Edit `config.json` with your values. See [Configuration](#configuration) for the full schema.

### 5. Database setup

Create the database and import the schema:

```bash
mysql -u root -p your_database < database.sql
```

Or import `database.sql` via phpMyAdmin, HeidiSQL, DBeaver, or your preferred MySQL client.

### 6. Start the bot

```bash
npm start
```

---

## Configuration

Create `config.json` with the following structure:

```json
{
  "startingNumber": 2000,
  "clientId": "YOUR_DISCORD_APPLICATION_ID",
  "guildId": "YOUR_DISCORD_GUILD_ID",
  "numberingRoleId": "ROLE_ID_THAT_TRIGGERS_NUMBERING",
  "skipRoleIds": ["ROLE_ID_1", "ROLE_ID_2"],
  "reservedNumbers": [2000, 3000],
  "status": {
    "cycleInterval": 5000,
    "presets": [
      { "text": "LSRP", "type": "Playing" },
      { "text": "Next: #{nextNumber}", "type": "Watching" }
    ]
  },
  "rateLimit": {
    "enabled": true,
    "maxCommands": 10,
    "windowMs": 60000,
    "exemptCommands": ["ping", "health"]
  },
  "rolePermissions": {
    "director": "ROLE_ID",
    "management": "ROLE_ID",
    "admin": "ROLE_ID",
    "moderator": "ROLE_ID"
  },
  "welcomeMessage": {
    "enabled": true,
    "embed": {
      "color": "d46815",
      "title": "Welcome!",
      "description": "Hello **{username}**, your badge number is **{badgeNumber}**.",
      "fields": [],
      "footer": { "text": "Thank you for joining!" },
      "thumbnail": "",
      "image": ""
    },
    "sendToNewMembers": true,
    "sendToExistingMembers": true,
    "delayBeforeSending": 1000
  }
}
```

### Configuration reference

| Key | Description |
|-----|-------------|
| `startingNumber` | First badge number to assign (e.g., 2000) |
| `clientId` | Discord Application ID (Developer Portal → Application → General Information) |
| `guildId` | Your server's ID (right-click server icon → Copy ID, with Developer Mode on) |
| `numberingRoleId` | Role that triggers number assignment when added to a member |
| `skipRoleIds` | Members with these roles are excluded from numbering (e.g., staff) |
| `reservedNumbers` | Numbers skipped during auto-assignment; assign via `/adduser` for special members |
| `status.presets` | Use `{nextNumber}` and `{memberCount}` as placeholders |
| `rateLimit` | Throttle commands per user; `exemptCommands` bypass rate limit |
| `rolePermissions` | Maps role names to IDs for command access |
| `welcomeMessage.embed` | Use `{username}` and `{badgeNumber}` in text fields |

---

## Discord Setup

### Bot permissions

Invite the bot with these permissions:

- **Manage Nicknames** – Required for setting `{number} | {username}` format
- **View Server** – See members and roles
- **View Channel** – Required for slash commands
- **Send Messages** – Command responses

### Developer Portal intents

Enable in [Discord Developer Portal](https://discord.com/developers/applications) → Your Application → Bot:

- **Server Members Intent**
- **Presence Intent**

### Getting IDs

1. Enable **Developer Mode** in Discord (Settings → App Settings → Advanced)
2. **Application ID**: Developer Portal → General Information
3. **Guild ID**: Right-click server icon → Copy ID
4. **Role IDs**: Server Settings → Roles → Right-click role → Copy ID

---

## Slash Commands

### Public commands (everyone)

| Command | Description |
|---------|-------------|
| `/ping` | Test if the bot is responding |
| `/health` | Health check: uptime, Discord latency, database status |
| `/reserved` | List reserved badge numbers and next auto-assign number |
| `/status` | Show member count, next number, reserved numbers, status cycling |
| `/permissions` | Check your access to each command |

### Staff commands (director, management, admin, moderator)

| Command | Description |
|---------|-------------|
| `/validate` | Correct next number if out of sync |
| `/refresh` | Force bot status update |
| `/adduser` | Add user with next available or specific badge number |
| `/edituser` | Edit a user's badge number or stored username |
| `/remove` | Remove a user's badge number (by user ID) |
| `/cleanup` | Remove members no longer in the server from the database |
| `/welcome` | Manually send welcome message to a user |
| `/testwelcome` | Send test welcome message to yourself |
| `/welcomeconfig` | Show welcome message configuration |
| `/previewwelcome` | Preview the welcome embed |

---

## Project Structure

```
lsrp-number-bot/
├── index.js          # Main bot logic, events, slash commands
├── config.json       # Configuration (create from template above)
├── .env              # Environment variables (create, do not commit)
├── database.sql      # MariaDB/MySQL schema
├── package.json
└── README.md
```

---

## Development

Run with auto-reload during development:

```bash
npm run dev
```

Requires `nodemon` (included in devDependencies).

---

## Troubleshooting

### Bot doesn't assign numbers

- Verify `numberingRoleId` is correct and the bot has **Manage Nicknames**
- Check `skipRoleIds`—members with these roles are excluded
- Guild owners cannot have nicknames modified by bots (Discord limitation)

### "Unknown interaction" or command timeout

- Long-running commands (`/cleanup`) use `deferReply`; ensure the bot responds within 3 seconds for others
- Check database connectivity if commands hang

### Welcome message not sent

- User may have DMs disabled
- Verify `welcomeMessage.enabled` and `sendToNewMembers` / `sendToExistingMembers`

### Database connection failed

- Ensure MariaDB/MySQL is running and `DATABASE_*` env vars are correct
- Run `database.sql` to create tables
- MariaDB 10.5+ required for `CREATE INDEX IF NOT EXISTS`

---

## License

MIT License. See [LICENSE](LICENSE) for details.
