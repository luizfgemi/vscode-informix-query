# vscode-informix-query

VSCode extension to run Informix SQL queries through a Python `ibm-db` bridge.

## Badges

[![CI](https://github.com/luizfgemi/vscode-informix-query/actions/workflows/ci.yml/badge.svg)](https://github.com/luizfgemi/vscode-informix-query/actions/workflows/ci.yml)
[![Release](https://github.com/luizfgemi/vscode-informix-query/actions/workflows/release.yml/badge.svg)](https://github.com/luizfgemi/vscode-informix-query/actions/workflows/release.yml)

## Installation local (.vsix)

### Option 1: CI artifact (every push/PR)

1. Open the latest CI run: https://github.com/luizfgemi/vscode-informix-query/actions/workflows/ci.yml
2. Download artifact `vscode-informix-query-vsix`.
3. Install:

```bash
code --install-extension vscode-informix-query-<version>.vsix
```

### Option 2: GitHub Release asset (tag `vX.Y.Z`)

1. Open releases: https://github.com/luizfgemi/vscode-informix-query/releases
2. Download the `.vsix` attached to the tag.
3. Install:

```bash
code --install-extension vscode-informix-query-<version>.vsix
```

## Install in WSL

1. Open the project in a Remote-WSL window (`Remote-WSL: New Window`).
2. Install the `.vsix` in the WSL context:
3. UI: Extensions panel -> extension menu -> `Install in WSL`.
4. CLI inside WSL terminal:

```bash
code --install-extension ./vscode-informix-query-<version>.vsix
```

Requirements inside WSL:

- `python3`
- `python3-venv`

The extension runs as `workspace` extension kind, so runtime, Python venv, and bridge execution happen in WSL.

## Core capabilities

- Execute selected SQL, current statement, or full document
- Resolve target environment automatically using SQL comment and file name conventions
- Manage multiple profiles (`dev`, `stage`, `prod`, etc.)
- Enforce per-environment safety policies (`readOnly`, `confirmWrites`)
- Prompt for missing password and optionally store securely in VSCode SecretStorage
- Test connection using the same environment resolution logic used for query execution

## Environment resolution precedence

When running a query (or test connection), the extension resolves the target in this order:

1. Statement comment: `-- env: <name>` immediately above the statement
2. File name: `<anything>.<env>.sql`
3. Active profile: `informixQuery.activeProfile`
4. Legacy single-connection settings (`host/user/database/...`)

Important behavior:

- If a statement/file explicitly references an environment that does not exist, execution is blocked (no silent fallback).
- Environment matching is case-insensitive.

## SQL comment convention

Use this format:

```sql
-- env: prod
UPDATE orders SET status = 'closed' WHERE id = 42;
```

Supported key:

- `env`

## File naming convention

Use:

- `query.dev.sql`
- `orders.prod.sql`
- `cleanup.stage.sql`

The last segment before `.sql` is treated as the environment key.

## Profile configuration

Configure profiles in `settings.json`:

```json
{
  "informixQuery.profiles": [
    {
      "name": "local-dev",
      "environment": "dev",
      "host": "ifx-dev.local",
      "port": 9088,
      "database": "app_dev",
      "user": "app_user",
      "readOnly": false,
      "confirmWrites": false
    },
    {
      "name": "prod-main",
      "environment": "prod",
      "host": "ifx-prod.local",
      "port": 9088,
      "database": "app_prod",
      "user": "app_user",
      "readOnly": false,
      "confirmWrites": true
    }
  ],
  "informixQuery.activeProfile": "local-dev"
}
```

Profile fields:

- `name` (required): unique profile name
- `environment` (required): unique environment key used by comment/file resolution
- `host`, `port`, `database`, `user` (required except `port` default `9088`)
- `password` (optional): if omitted, runtime prompt is used
- `server` (optional)
- `readOnly` (optional, default `false`): blocks write/DDL SQL
- `confirmWrites` (optional): requires typed confirmation for risky SQL

Uniqueness rules:

- `name` must be unique (case-insensitive)
- `environment` must be unique (case-insensitive)

Default for production:

- In the profile wizard, when `environment=prod`, `confirmWrites` defaults to `true`.

## Password behavior (session vs SecretStorage)

Password resolution order:

1. `profiles[].password` (or legacy `informixQuery.password`)
2. VSCode SecretStorage
3. In-memory session cache
4. Prompt

When prompted, you can choose:

- `Save securely in VSCode` (persists in SecretStorage)
- `Use only this session` (memory only)

Commands to clear secrets:

- `Informix: Clear Saved Password`
- `Informix: Clear All Saved Passwords`

## Safety policies for write SQL

Risky SQL keywords (case-insensitive):

- `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `CREATE`, `ALTER`, `DROP`, `RENAME`, `GRANT`, `REVOKE`
- `SELECT ... INTO TEMP` is treated as risky

Policy behavior:

- `readOnly=true`: risky SQL is blocked
- `confirmWrites=true`: modal warning + typed environment confirmation required

## Commands

- `Informix: Run Query`
- `Informix: Run Current Statement`
- `Informix: Test Connection`
- `Informix: Select Profile`
- `Informix: Add Profile`
- `Informix: Edit Profile`
- `Informix: Remove Profile`
- `Informix: Open Profiles Config`
- `Informix: Save Query As Environment`
- `Informix: Insert Environment Comment (Statement)`
- `Informix: Insert Environment Comment (Top)`
- `Informix: Clear Saved Password`
- `Informix: Clear All Saved Passwords`

Keybindings:

- `Ctrl+Enter` / `Cmd+Enter`: run current statement
- `Ctrl+Shift+Enter` / `Cmd+Shift+Enter`: run selection/full document

## Status bar

The extension shows effective target as:

- `IFX: <env> [stmt]`
- `IFX: <env> [file]`
- `IFX: <env> [active]`
- `IFX: legacy [legacy]`

Click the status item to select active profile.

## Legacy mode (single connection)

If no profiles are configured, extension falls back to legacy settings:

- `informixQuery.host`
- `informixQuery.port`
- `informixQuery.database`
- `informixQuery.user`
- `informixQuery.password` (optional)
- `informixQuery.server`

## Runtime isolation (venv)

On first use, extension creates a dedicated Python virtual environment in VSCode global storage and installs `ibm-db` there.

Nothing is installed globally in system Python.

Typical paths:

- Linux: `~/.config/Code/User/globalStorage/local.vscode-informix-query/python-env/`
- macOS: `~/Library/Application Support/Code/User/globalStorage/local.vscode-informix-query/python-env/`
- Windows: `%APPDATA%\\Code\\User\\globalStorage\\local.vscode-informix-query\\python-env\\`

## Development

```bash
cd /home/fernando/repos/vscode-informix-query
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml run --rm dev npm install
docker compose -f docker-compose.dev.yml run --rm dev npm run compile
docker compose -f docker-compose.dev.yml run --rm dev npx @vscode/vsce package
```

Launch extension development host with `F5` in VSCode.

## Versioning and release flow

You do not need to manually edit `package.json` version every time.

Standard flow:

1. Choose version bump:
2. `patch` for fixes, `minor` for new backward-compatible features, `major` for breaking changes.
3. Run one command to bump version, create commit, and create tag:

```bash
npm run release:patch
# or: npm run release:minor
# or: npm run release:major
```

4. Push commit and tag:

```bash
npm run release:push
```

If you prefer containerized execution:

```bash
docker compose -f docker-compose.dev.yml run --rm --user "$(id -u):$(id -g)" dev npm run release:patch
npm run release:push
```

After pushing the tag (`vX.Y.Z`), GitHub Actions `Release` generates and attaches the `.vsix` asset automatically.
