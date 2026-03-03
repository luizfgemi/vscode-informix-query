import * as path from "path";
import * as vscode from "vscode";
import { ConnectionConfig, RunnerError, ensurePythonBridge, runQuery, testConnection } from "./runner";
import { showResults } from "./webview/resultsView";

const ENV_COMMENT_REGEX = /^\s*--\s*env\s*:\s*([A-Za-z0-9_-]+)\s*$/i;
const SECRET_KEY_REGISTRY_STATE = "informixQuery.secretKeyRegistry";

type ResolutionSource = "statement" | "filename" | "active" | "legacy";

interface ConnectionProfile {
  name: string;
  environment: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  server?: string;
  readOnly: boolean;
  confirmWrites?: boolean;
}

interface ResolvedConnection {
  connection: ConnectionConfig;
  profileName: string;
  profileLabel: string;
  environment: string;
  resolutionSource: ResolutionSource;
  readOnly: boolean;
  confirmWrites: boolean;
}

interface SqlExecutionInput {
  sql: string;
  range: vscode.Range;
  source: string;
}

interface ProfileIndexes {
  byName: Map<string, ConnectionProfile>;
  byEnvironment: Map<string, ConnectionProfile>;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Informix Query");
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const sessionPasswordCache = new Map<string, string>();

  statusItem.command = "informixQuery.selectProfile";
  context.subscriptions.push(output, statusItem);

  const refreshStatusBar = () => updateStatusBar(statusItem);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("informixQuery")) {
        refreshStatusBar();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => refreshStatusBar()),
    vscode.window.onDidChangeTextEditorSelection(() => refreshStatusBar())
  );

  refreshStatusBar();

  const runQueryDisposable = vscode.commands.registerCommand("informixQuery.runQuery", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active editor found.");
      return;
    }

    const input = getRunQueryInput(editor);
    if (!input.sql.trim()) {
      vscode.window.showErrorMessage("No SQL found. Select a query or add SQL to the active editor.");
      return;
    }

    await executeQuery(editor, input);
    refreshStatusBar();
  });

  const runCurrentStatementDisposable = vscode.commands.registerCommand("informixQuery.runCurrentStatement", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active editor found.");
      return;
    }

    const input = getCurrentStatementInput(editor);
    if (!input.sql.trim()) {
      vscode.window.showErrorMessage("Could not resolve current SQL statement.");
      return;
    }

    await executeQuery(editor, input);
    refreshStatusBar();
  });

  const testConnectionDisposable = vscode.commands.registerCommand("informixQuery.testConnection", async () => {
    const settings = vscode.workspace.getConfiguration("informixQuery");
    const target = getConfigurationTarget();

    const editor = vscode.window.activeTextEditor;
    const statementRange = editor ? getCurrentStatementRange(editor).range : undefined;

    const resolved = await resolveConnectionConfig({
      settings,
      target,
      editor,
      statementRange,
      sessionPasswordCache,
      context
    });

    if (!resolved) {
      refreshStatusBar();
      return;
    }

    const pythonPath = settings.get<string>("pythonPath", "python3");
    const queryTimeoutMs = settings.get<number>("queryTimeoutMs", 30000);
    const globalStoragePath = context.globalStorageUri.fsPath;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Testing Informix connection (${resolved.environment})`,
        cancellable: false
      },
      async () => {
        try {
          const bridgePythonPath = await ensurePythonBridge({
            globalStoragePath,
            pythonPath
          });

          const response = await testConnection({
            extensionPath: context.extensionPath,
            bridgePythonPath,
            timeoutMs: queryTimeoutMs,
            connection: resolved.connection
          });

          if (!response.ok) {
            logError(output, response.error_code, response.message, response.details, resolved.environment);
            vscode.window.showErrorMessage(`[${response.error_code}] ${response.message}`);
            return;
          }

          vscode.window.showInformationMessage(
            `Connection OK (${resolved.environment}) in ${response.elapsed_ms} ms.`
          );
        } catch (error: unknown) {
          const normalized = normalizeError(error);
          logError(output, normalized.code, normalized.message, normalized.details, resolved.environment);
          vscode.window.showErrorMessage(
            `[${normalized.code}] ${normalized.message}. See 'Informix Query' output for details.`
          );
        }
      }
    );

    refreshStatusBar();
  });

  const selectProfileDisposable = vscode.commands.registerCommand("informixQuery.selectProfile", async () => {
    const settings = vscode.workspace.getConfiguration("informixQuery");
    const target = getConfigurationTarget();
    await selectProfile(settings, target);
    refreshStatusBar();
  });

  const addProfileDisposable = vscode.commands.registerCommand("informixQuery.addProfile", async () => {
    const settings = vscode.workspace.getConfiguration("informixQuery");
    const target = getConfigurationTarget();
    const profiles = readProfiles(settings);

    const validationError = validateProfileUniqueness(profiles);
    if (validationError) {
      vscode.window.showErrorMessage(validationError);
      return;
    }

    const profile = await promptProfile(undefined, profiles);
    if (!profile) {
      return;
    }

    const nextProfiles = [...profiles, profile];
    const nextValidation = validateProfileUniqueness(nextProfiles);
    if (nextValidation) {
      vscode.window.showErrorMessage(nextValidation);
      return;
    }

    await settings.update("profiles", nextProfiles, target);
    await settings.update("activeProfile", profile.name, target);
    vscode.window.showInformationMessage(`Profile '${profile.name}' added and selected.`);
    refreshStatusBar();
  });

  const editProfileDisposable = vscode.commands.registerCommand("informixQuery.editProfile", async () => {
    const settings = vscode.workspace.getConfiguration("informixQuery");
    const target = getConfigurationTarget();
    const profiles = readProfiles(settings);

    if (profiles.length === 0) {
      vscode.window.showErrorMessage("No profiles configured. Use 'Informix: Add Profile' first.");
      return;
    }

    const validationError = validateProfileUniqueness(profiles);
    if (validationError) {
      vscode.window.showErrorMessage(validationError);
      return;
    }

    const selected = await pickProfile(profiles, "Select profile to edit");
    if (!selected) {
      return;
    }

    const updated = await promptProfile(selected, profiles.filter((p) => p.name !== selected.name));
    if (!updated) {
      return;
    }

    const nextProfiles = profiles.map((profile) => (profile.name === selected.name ? updated : profile));
    const nextValidation = validateProfileUniqueness(nextProfiles);
    if (nextValidation) {
      vscode.window.showErrorMessage(nextValidation);
      return;
    }

    await settings.update("profiles", nextProfiles, target);

    const activeProfile = (settings.get<string>("activeProfile", "") || "").trim();
    if (activeProfile.localeCompare(selected.name, undefined, { sensitivity: "accent" }) === 0) {
      await settings.update("activeProfile", updated.name, target);
    }

    await migrateCredentialReferences({
      context,
      sessionPasswordCache,
      from: selected,
      to: updated
    });

    vscode.window.showInformationMessage(`Profile '${selected.name}' updated.`);
    refreshStatusBar();
  });

  const removeProfileDisposable = vscode.commands.registerCommand("informixQuery.removeProfile", async () => {
    const settings = vscode.workspace.getConfiguration("informixQuery");
    const target = getConfigurationTarget();
    const profiles = readProfiles(settings);

    if (profiles.length === 0) {
      vscode.window.showErrorMessage("No profiles configured.");
      return;
    }

    const validationError = validateProfileUniqueness(profiles);
    if (validationError) {
      vscode.window.showErrorMessage(validationError);
      return;
    }

    const selected = await pickProfile(profiles, "Select profile to remove");
    if (!selected) {
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Remove profile '${selected.name}' (${selected.environment})?`,
      { modal: true },
      "Remove"
    );

    if (confirmation !== "Remove") {
      return;
    }

    const nextProfiles = profiles.filter((profile) => profile.name !== selected.name);
    await settings.update("profiles", nextProfiles, target);

    const activeProfile = (settings.get<string>("activeProfile", "") || "").trim();
    if (activeProfile === selected.name) {
      await settings.update("activeProfile", nextProfiles[0]?.name ?? "", target);
    }

    await clearProfileSecret(context, selected);
    sessionPasswordCache.delete(buildProfileCredentialKey(selected));

    vscode.window.showInformationMessage(`Profile '${selected.name}' removed.`);
    refreshStatusBar();
  });

  const openProfilesConfigDisposable = vscode.commands.registerCommand("informixQuery.openProfilesConfig", async () => {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      await vscode.commands.executeCommand("workbench.action.openWorkspaceSettingsFile");
    } else {
      await vscode.commands.executeCommand("workbench.action.openSettingsJson");
    }

    vscode.window.showInformationMessage(
      "Edit 'informixQuery.profiles' and 'informixQuery.activeProfile' in settings.json."
    );
  });

  const saveQueryAsEnvironmentDisposable = vscode.commands.registerCommand("informixQuery.saveQueryAsEnvironment", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active editor found.");
      return;
    }

    const settings = vscode.workspace.getConfiguration("informixQuery");
    const profiles = readProfiles(settings);
    const validationError = validateProfileUniqueness(profiles);
    if (validationError) {
      vscode.window.showErrorMessage(validationError);
      return;
    }

    const environments = getEnvironments(profiles);
    if (environments.length === 0) {
      vscode.window.showErrorMessage("No profiles configured with environment. Add a profile first.");
      return;
    }

    const envPick = await vscode.window.showQuickPick(
      environments.map((env) => ({ label: env })),
      { placeHolder: "Select environment for file name" }
    );
    if (!envPick) {
      return;
    }

    const env = envPick.label;
    const suggested = buildEnvFileName(editor.document.uri, env, environments);
    const defaultUri = buildDefaultSaveUri(editor.document.uri, suggested);

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        SQL: ["sql"]
      },
      saveLabel: "Save Query"
    });

    if (!saveUri) {
      return;
    }

    const content = editor.document.getText();
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, "utf8"));
    const savedDoc = await vscode.workspace.openTextDocument(saveUri);
    await vscode.window.showTextDocument(savedDoc, { preview: false });
  });

  const insertEnvCommentStatementDisposable = vscode.commands.registerCommand("informixQuery.insertEnvCommentStatement", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active editor found.");
      return;
    }

    const environment = await pickEnvironmentFromProfiles();
    if (!environment) {
      return;
    }

    const statement = getCurrentStatementInput(editor);
    if (!statement.sql.trim()) {
      vscode.window.showErrorMessage("Could not resolve current SQL statement.");
      return;
    }

    const startLine = firstNonEmptyLineInRange(editor.document, statement.range);
    if (startLine === undefined) {
      vscode.window.showErrorMessage("Current statement is empty.");
      return;
    }

    const commentText = `-- env: ${environment}`;
    await editor.edit((builder) => {
      const previousLine = startLine - 1;
      if (previousLine >= 0) {
        const prevText = editor.document.lineAt(previousLine).text;
        if (ENV_COMMENT_REGEX.test(prevText.trim())) {
          builder.replace(editor.document.lineAt(previousLine).range, commentText);
          return;
        }
      }

      builder.insert(new vscode.Position(startLine, 0), `${commentText}\n`);
    });
  });

  const insertEnvCommentTopDisposable = vscode.commands.registerCommand("informixQuery.insertEnvCommentTop", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active editor found.");
      return;
    }

    const environment = await pickEnvironmentFromProfiles();
    if (!environment) {
      return;
    }

    const doc = editor.document;
    const commentText = `-- env: ${environment}`;
    const firstMeaningfulLine = findFirstMeaningfulLine(doc);

    await editor.edit((builder) => {
      if (firstMeaningfulLine !== undefined) {
        const lineText = doc.lineAt(firstMeaningfulLine).text;
        if (ENV_COMMENT_REGEX.test(lineText.trim())) {
          builder.replace(doc.lineAt(firstMeaningfulLine).range, commentText);
          return;
        }
      }

      builder.insert(new vscode.Position(0, 0), `${commentText}\n`);
    });
  });

  const clearSavedPasswordDisposable = vscode.commands.registerCommand("informixQuery.clearSavedPassword", async () => {
    const settings = vscode.workspace.getConfiguration("informixQuery");
    const profiles = readProfiles(settings);

    const options: Array<{ label: string; description: string; key: string }> = profiles.map((profile) => ({
      label: profile.name,
      description: `${profile.environment} | ${profile.user}@${profile.host}:${profile.port}/${profile.database}`,
      key: buildProfileCredentialKey(profile)
    }));

    const legacyIdentity = getLegacyIdentity(settings);
    if (legacyIdentity) {
      options.push({
        label: "legacy",
        description: legacyIdentity.label,
        key: buildLegacyCredentialKey(legacyIdentity.label)
      });
    }

    if (options.length === 0) {
      vscode.window.showErrorMessage("No configured credential targets found.");
      return;
    }

    const picked = await vscode.window.showQuickPick(options, {
      placeHolder: "Select credential to clear from SecretStorage"
    });

    if (!picked) {
      return;
    }

    await context.secrets.delete(picked.key);
    await removeSecretKeyFromRegistry(context, picked.key);
    sessionPasswordCache.delete(picked.key);
    vscode.window.showInformationMessage(`Cleared saved credential for '${picked.label}'.`);
  });

  const clearAllSavedPasswordsDisposable = vscode.commands.registerCommand("informixQuery.clearAllSavedPasswords", async () => {
    const secretKeys = getSecretKeyRegistry(context);
    for (const key of secretKeys) {
      await context.secrets.delete(key);
    }

    await context.globalState.update(SECRET_KEY_REGISTRY_STATE, []);
    sessionPasswordCache.clear();
    vscode.window.showInformationMessage(`Cleared ${secretKeys.length} saved credential(s).`);
  });

  context.subscriptions.push(
    runQueryDisposable,
    runCurrentStatementDisposable,
    testConnectionDisposable,
    selectProfileDisposable,
    addProfileDisposable,
    editProfileDisposable,
    removeProfileDisposable,
    openProfilesConfigDisposable,
    saveQueryAsEnvironmentDisposable,
    insertEnvCommentStatementDisposable,
    insertEnvCommentTopDisposable,
    clearSavedPasswordDisposable,
    clearAllSavedPasswordsDisposable
  );

  async function executeQuery(editor: vscode.TextEditor, input: SqlExecutionInput): Promise<void> {
    const settings = vscode.workspace.getConfiguration("informixQuery");
    const target = getConfigurationTarget();

    const resolved = await resolveConnectionConfig({
      settings,
      target,
      editor,
      statementRange: input.range,
      sessionPasswordCache,
      context
    });

    if (!resolved) {
      return;
    }

    if (!await enforceWritePolicies(resolved, input.sql)) {
      return;
    }

    const pythonPath = settings.get<string>("pythonPath", "python3");
    const queryTimeoutMs = settings.get<number>("queryTimeoutMs", 30000);
    const maxRows = settings.get<number>("maxRows", 1000);
    const globalStoragePath = context.globalStorageUri.fsPath;

    output.appendLine(
      `[${new Date().toISOString()}] [env=${resolved.environment}] [${resolved.resolutionSource}] Running query (${input.source}) on ${resolved.profileLabel}`
    );

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running Informix query (${resolved.environment})`,
        cancellable: false
      },
      async () => {
        try {
          const bridgePythonPath = await ensurePythonBridge({
            globalStoragePath,
            pythonPath
          });

          const response = await runQuery({
            extensionPath: context.extensionPath,
            bridgePythonPath,
            timeoutMs: queryTimeoutMs,
            maxRows,
            connection: resolved.connection,
            sql: input.sql
          });

          if (!response.ok) {
            logError(output, response.error_code, response.message, response.details, resolved.environment);
            vscode.window.showErrorMessage(`[${response.error_code}] ${response.message}`);
            return;
          }

          if (response.truncated) {
            vscode.window.showWarningMessage(
              `Result was truncated to ${maxRows} rows. Increase informixQuery.maxRows if needed.`
            );
          }

          output.appendLine(
            `[${new Date().toISOString()}] [env=${resolved.environment}] Query OK rows=${response.row_count} elapsed=${response.elapsed_ms}ms`
          );

          showResults(context, response, input.sql);
        } catch (error: unknown) {
          const normalized = normalizeError(error);
          logError(output, normalized.code, normalized.message, normalized.details, resolved.environment);
          vscode.window.showErrorMessage(
            `[${normalized.code}] ${normalized.message}. See 'Informix Query' output for details.`
          );
        }
      }
    );
  }

  async function pickEnvironmentFromProfiles(): Promise<string | undefined> {
    const settings = vscode.workspace.getConfiguration("informixQuery");
    const profiles = readProfiles(settings);
    const validationError = validateProfileUniqueness(profiles);
    if (validationError) {
      vscode.window.showErrorMessage(validationError);
      return undefined;
    }

    const environments = getEnvironments(profiles);
    if (environments.length === 0) {
      vscode.window.showErrorMessage("No profile environments configured. Add a profile first.");
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      environments.map((environment) => ({ label: environment })),
      { placeHolder: "Select environment" }
    );

    return picked?.label;
  }

  async function enforceWritePolicies(resolved: ResolvedConnection, sql: string): Promise<boolean> {
    const risky = isRiskySql(sql);
    if (!risky) {
      return true;
    }

    if (resolved.readOnly) {
      vscode.window.showErrorMessage(
        `Execution blocked: environment '${resolved.environment}' is readOnly.`
      );
      return false;
    }

    if (resolved.confirmWrites) {
      const proceed = await vscode.window.showWarningMessage(
        `You are about to run write/DDL SQL on '${resolved.environment}' (${resolved.profileLabel}).`,
        { modal: true },
        "Continue"
      );

      if (proceed !== "Continue") {
        return false;
      }

      const typed = await vscode.window.showInputBox({
        title: "Confirm Environment",
        prompt: `Type environment name '${resolved.environment}' to confirm`,
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (value.trim().toLowerCase() !== resolved.environment.toLowerCase()) {
            return "Environment name does not match.";
          }

          return undefined;
        }
      });

      if (!typed || typed.trim().toLowerCase() !== resolved.environment.toLowerCase()) {
        vscode.window.showInformationMessage("Execution canceled.");
        return false;
      }
    }

    return true;
  }
}

export function deactivate(): void {
  // no-op
}

interface ResolveConnectionParams {
  settings: vscode.WorkspaceConfiguration;
  target: vscode.ConfigurationTarget;
  editor?: vscode.TextEditor;
  statementRange?: vscode.Range;
  sessionPasswordCache: Map<string, string>;
  context: vscode.ExtensionContext;
}

async function resolveConnectionConfig(params: ResolveConnectionParams): Promise<ResolvedConnection | undefined> {
  const profiles = readProfiles(params.settings);
  const validationError = validateProfileUniqueness(profiles);
  if (validationError) {
    vscode.window.showErrorMessage(validationError);
    return undefined;
  }

  if (profiles.length > 0) {
    const indexes = buildProfileIndexes(profiles);

    const statementEnvironment = resolveEnvironmentFromStatement(params.editor, params.statementRange);
    if (statementEnvironment) {
      const profile = indexes.byEnvironment.get(statementEnvironment.toLowerCase());
      if (!profile) {
        vscode.window.showErrorMessage(
          `Environment '${statementEnvironment}' from statement comment is not configured.`
        );
        return undefined;
      }

      return buildResolvedFromProfile(profile, "statement", params);
    }

    const fileEnvironment = resolveEnvironmentFromFilename(params.editor?.document.fileName);
    if (fileEnvironment) {
      const profile = indexes.byEnvironment.get(fileEnvironment.toLowerCase());
      if (!profile) {
        vscode.window.showErrorMessage(
          `Environment '${fileEnvironment}' from file name is not configured.`
        );
        return undefined;
      }

      return buildResolvedFromProfile(profile, "filename", params);
    }

    let activeProfileName = (params.settings.get<string>("activeProfile", "") || "").trim();
    let activeProfile = activeProfileName
      ? indexes.byName.get(activeProfileName.toLowerCase())
      : undefined;

    if (!activeProfile) {
      const picked = await pickProfile(profiles, "Select active Informix profile");
      if (!picked) {
        vscode.window.showErrorMessage("No active profile selected.");
        return undefined;
      }

      activeProfile = picked;
      activeProfileName = picked.name;
      await params.settings.update("activeProfile", activeProfileName, params.target);
    }

    return buildResolvedFromProfile(activeProfile, "active", params);
  }

  return buildLegacyResolvedConnection(params.settings, params.sessionPasswordCache, params.context);
}

async function buildResolvedFromProfile(
  profile: ConnectionProfile,
  resolutionSource: ResolutionSource,
  params: ResolveConnectionParams
): Promise<ResolvedConnection | undefined> {
  const profileLabel = `${profile.user}@${profile.host}:${profile.port}/${profile.database}`;
  const credentialKey = buildProfileCredentialKey(profile);
  const password = await resolvePassword({
    key: credentialKey,
    label: profileLabel,
    explicitPassword: profile.password,
    sessionPasswordCache: params.sessionPasswordCache,
    context: params.context
  });

  if (password === undefined) {
    return undefined;
  }

  return {
    profileName: profile.name,
    profileLabel,
    environment: profile.environment,
    resolutionSource,
    readOnly: profile.readOnly,
    confirmWrites: profile.confirmWrites ?? profile.environment.toLowerCase() === "prod",
    connection: {
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      password,
      server: profile.server
    }
  };
}

async function buildLegacyResolvedConnection(
  settings: vscode.WorkspaceConfiguration,
  sessionPasswordCache: Map<string, string>,
  context: vscode.ExtensionContext
): Promise<ResolvedConnection | undefined> {
  const host = (settings.get<string>("host", "") || "").trim();
  const database = (settings.get<string>("database", "") || "").trim();
  const user = (settings.get<string>("user", "") || "").trim();
  const password = settings.get<string>("password", "") || "";
  const server = (settings.get<string>("server", "") || "").trim();
  const port = settings.get<number>("port", 9088);

  const missing: string[] = [];
  if (!host) missing.push("informixQuery.host");
  if (!database) missing.push("informixQuery.database");
  if (!user) missing.push("informixQuery.user");

  if (missing.length > 0) {
    vscode.window.showErrorMessage(
      `Missing required legacy settings: ${missing.join(", ")}. Or configure informixQuery.profiles.`
    );
    return undefined;
  }

  const identity = `${user}@${host}:${port}/${database}`;
  const resolvedPassword = await resolvePassword({
    key: buildLegacyCredentialKey(identity),
    label: identity,
    explicitPassword: password,
    sessionPasswordCache,
    context
  });

  if (resolvedPassword === undefined) {
    return undefined;
  }

  return {
    profileName: "legacy",
    profileLabel: identity,
    environment: "legacy",
    resolutionSource: "legacy",
    readOnly: false,
    confirmWrites: false,
    connection: {
      host,
      port,
      database,
      user,
      password: resolvedPassword,
      server: server || undefined
    }
  };
}

interface ResolvePasswordParams {
  key: string;
  label: string;
  explicitPassword?: string;
  sessionPasswordCache: Map<string, string>;
  context: vscode.ExtensionContext;
}

async function resolvePassword(params: ResolvePasswordParams): Promise<string | undefined> {
  if (params.explicitPassword && params.explicitPassword.length > 0) {
    return params.explicitPassword;
  }

  const stored = await params.context.secrets.get(params.key);
  if (stored !== undefined) {
    params.sessionPasswordCache.set(params.key, stored);
    return stored;
  }

  if (params.sessionPasswordCache.has(params.key)) {
    return params.sessionPasswordCache.get(params.key);
  }

  const entered = await vscode.window.showInputBox({
    title: "Informix Password",
    prompt: `Enter password for ${params.label}`,
    placeHolder: "Password",
    password: true,
    ignoreFocusOut: true
  });

  if (entered === undefined) {
    vscode.window.showInformationMessage("Operation canceled: password prompt was dismissed.");
    return undefined;
  }

  const storageChoice = await vscode.window.showQuickPick(
    [
      {
        label: "Save securely in VSCode (Recommended)",
        value: "save",
        description: "Stored in SecretStorage and reused across sessions."
      },
      {
        label: "Use only this session",
        value: "session",
        description: "Kept in memory until VSCode is closed."
      }
    ],
    {
      placeHolder: "How should this password be stored?"
    }
  );

  if (!storageChoice) {
    vscode.window.showInformationMessage("Operation canceled.");
    return undefined;
  }

  if (storageChoice.value === "save") {
    await params.context.secrets.store(params.key, entered);
    await addSecretKeyToRegistry(params.context, params.key);
  }

  params.sessionPasswordCache.set(params.key, entered);
  return entered;
}

function getRunQueryInput(editor: vscode.TextEditor): SqlExecutionInput {
  const { selection, document } = editor;
  if (!selection.isEmpty) {
    return {
      sql: document.getText(selection),
      range: selection,
      source: "selection"
    };
  }

  return {
    sql: document.getText(),
    range: new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    source: "document"
  };
}

function getCurrentStatementInput(editor: vscode.TextEditor): SqlExecutionInput {
  const statement = getCurrentStatementRange(editor);
  return {
    sql: editor.document.getText(statement.range).trim(),
    range: statement.range,
    source: "current-statement"
  };
}

function getCurrentStatementRange(editor: vscode.TextEditor): { range: vscode.Range } {
  const { selection, document } = editor;
  if (!selection.isEmpty) {
    return { range: selection };
  }

  const fullText = document.getText();
  const cursorOffset = document.offsetAt(selection.active);
  const leftSeparator = fullText.lastIndexOf(";", Math.max(cursorOffset - 1, 0));
  const rightSeparator = fullText.indexOf(";", cursorOffset);

  let start = leftSeparator === -1 ? 0 : leftSeparator + 1;
  let end = rightSeparator === -1 ? fullText.length : rightSeparator;

  while (start < end && /\s/.test(fullText[start])) {
    start += 1;
  }

  while (end > start && /\s/.test(fullText[end - 1])) {
    end -= 1;
  }

  if (start >= end) {
    const line = document.lineAt(selection.active.line);
    return { range: line.range };
  }

  return {
    range: new vscode.Range(document.positionAt(start), document.positionAt(end))
  };
}

function resolveEnvironmentFromStatement(
  editor: vscode.TextEditor | undefined,
  range: vscode.Range | undefined
): string | undefined {
  if (!editor || !range) {
    return undefined;
  }

  const doc = editor.document;

  // Look for comment immediately above statement start, skipping blank lines.
  for (let line = range.start.line - 1; line >= 0; line -= 1) {
    const text = doc.lineAt(line).text.trim();
    if (!text) {
      continue;
    }

    const match = text.match(ENV_COMMENT_REGEX);
    if (match) {
      return match[1];
    }

    break;
  }

  // For whole-document runs, allow env comment at top comment header.
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    const text = doc.lineAt(line).text.trim();
    if (!text) {
      continue;
    }

    const match = text.match(ENV_COMMENT_REGEX);
    if (match) {
      return match[1];
    }

    if (text.startsWith("--")) {
      continue;
    }

    break;
  }

  return undefined;
}

function resolveEnvironmentFromFilename(fileName: string | undefined): string | undefined {
  if (!fileName) {
    return undefined;
  }

  const base = path.basename(fileName);
  const match = base.match(/^.+\.([A-Za-z0-9_-]+)\.sql$/i);
  return match?.[1];
}

function readProfiles(settings: vscode.WorkspaceConfiguration): ConnectionProfile[] {
  const rawProfiles = settings.get<unknown[]>("profiles", []);
  if (!Array.isArray(rawProfiles)) {
    return [];
  }

  const profiles: ConnectionProfile[] = [];
  for (const item of rawProfiles) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const environment = typeof record.environment === "string" ? record.environment.trim() : "";
    const host = typeof record.host === "string" ? record.host.trim() : "";
    const database = typeof record.database === "string" ? record.database.trim() : "";
    const user = typeof record.user === "string" ? record.user.trim() : "";
    const password = typeof record.password === "string" ? record.password : "";
    const server = typeof record.server === "string" ? record.server.trim() : "";
    const port = typeof record.port === "number" ? record.port : 9088;
    const readOnly = typeof record.readOnly === "boolean" ? record.readOnly : false;
    const confirmWrites = typeof record.confirmWrites === "boolean" ? record.confirmWrites : undefined;

    if (!name || !environment || !host || !database || !user) {
      continue;
    }

    profiles.push({
      name,
      environment,
      host,
      port,
      database,
      user,
      password: password || undefined,
      server: server || undefined,
      readOnly,
      confirmWrites
    });
  }

  return profiles;
}

function buildProfileIndexes(profiles: ConnectionProfile[]): ProfileIndexes {
  const byName = new Map<string, ConnectionProfile>();
  const byEnvironment = new Map<string, ConnectionProfile>();

  for (const profile of profiles) {
    byName.set(profile.name.toLowerCase(), profile);
    byEnvironment.set(profile.environment.toLowerCase(), profile);
  }

  return { byName, byEnvironment };
}

function validateProfileUniqueness(profiles: ConnectionProfile[]): string | undefined {
  const names = new Set<string>();
  const environments = new Set<string>();

  for (const profile of profiles) {
    const nameKey = profile.name.toLowerCase();
    if (names.has(nameKey)) {
      return `Duplicate profile name detected: '${profile.name}'. Profile names must be unique (case-insensitive).`;
    }
    names.add(nameKey);

    const envKey = profile.environment.toLowerCase();
    if (environments.has(envKey)) {
      return `Duplicate profile environment detected: '${profile.environment}'. Environments must be unique (case-insensitive).`;
    }
    environments.add(envKey);
  }

  return undefined;
}

async function selectProfile(
  settings: vscode.WorkspaceConfiguration,
  target: vscode.ConfigurationTarget
): Promise<void> {
  const profiles = readProfiles(settings);
  const validationError = validateProfileUniqueness(profiles);
  if (validationError) {
    vscode.window.showErrorMessage(validationError);
    return;
  }

  if (profiles.length === 0) {
    const action = await vscode.window.showInformationMessage(
      "No profiles configured.",
      "Add Profile",
      "Open Profiles Config"
    );

    if (action === "Add Profile") {
      await vscode.commands.executeCommand("informixQuery.addProfile");
    } else if (action === "Open Profiles Config") {
      await vscode.commands.executeCommand("informixQuery.openProfilesConfig");
    }
    return;
  }

  const selected = await pickProfile(profiles, "Select active Informix profile");
  if (!selected) {
    return;
  }

  await settings.update("activeProfile", selected.name, target);
  vscode.window.showInformationMessage(
    `Active profile set to: ${selected.name} (${selected.environment}).`
  );
}

async function pickProfile(
  profiles: ConnectionProfile[],
  placeHolder: string
): Promise<ConnectionProfile | undefined> {
  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      description: `${profile.environment} | ${profile.user}@${profile.host}:${profile.port}/${profile.database}`,
      profile
    })),
    { placeHolder }
  );

  return picked?.profile;
}

async function promptProfile(
  initial: ConnectionProfile | undefined,
  otherProfiles: ConnectionProfile[]
): Promise<ConnectionProfile | undefined> {
  const takenNames = new Set(otherProfiles.map((p) => p.name.toLowerCase()));
  const takenEnvs = new Set(otherProfiles.map((p) => p.environment.toLowerCase()));

  const name = await vscode.window.showInputBox({
    title: initial ? "Edit Informix Profile: Name" : "Add Informix Profile: Name",
    prompt: "Unique profile name",
    value: initial?.name ?? "",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Profile name is required.";
      }
      if (takenNames.has(trimmed.toLowerCase())) {
        return "Profile name already exists.";
      }
      return undefined;
    }
  });
  if (name === undefined) {
    return undefined;
  }

  const environment = await vscode.window.showInputBox({
    title: initial ? "Edit Informix Profile: Environment" : "Add Informix Profile: Environment",
    prompt: "Environment key (example: dev, stage, prod)",
    value: initial?.environment ?? "",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Environment is required.";
      }
      if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
        return "Environment must match [A-Za-z0-9_-].";
      }
      if (takenEnvs.has(trimmed.toLowerCase())) {
        return "Environment already exists.";
      }
      return undefined;
    }
  });
  if (environment === undefined) {
    return undefined;
  }

  const host = await promptRequiredField("Host", "Informix host", initial?.host ?? "");
  if (host === undefined) {
    return undefined;
  }

  const database = await promptRequiredField("Database", "Informix database", initial?.database ?? "");
  if (database === undefined) {
    return undefined;
  }

  const user = await promptRequiredField("User", "Informix user", initial?.user ?? "");
  if (user === undefined) {
    return undefined;
  }

  const port = await promptPort(initial?.port ?? 9088);
  if (port === undefined) {
    return undefined;
  }

  const server = await vscode.window.showInputBox({
    title: initial ? "Edit Informix Profile: Server (Optional)" : "Add Informix Profile: Server (Optional)",
    prompt: "Optional Informix server",
    value: initial?.server ?? "",
    ignoreFocusOut: true
  });
  if (server === undefined) {
    return undefined;
  }

  const password = await promptPasswordForProfile(initial?.password);
  if (password === null) {
    return undefined;
  }

  const readOnly = await promptBoolean(
    "Profile policy: readOnly",
    "Block write/DDL statements for this profile?",
    initial?.readOnly ?? false
  );
  if (readOnly === undefined) {
    return undefined;
  }

  const defaultConfirmWrites = initial?.confirmWrites ?? (environment.trim().toLowerCase() === "prod");
  const confirmWrites = await promptBoolean(
    "Profile policy: confirmWrites",
    "Require typed confirmation for write/DDL statements?",
    defaultConfirmWrites
  );
  if (confirmWrites === undefined) {
    return undefined;
  }

  return {
    name: name.trim(),
    environment: environment.trim(),
    host: host.trim(),
    port,
    database: database.trim(),
    user: user.trim(),
    password: password?.trim() ? password : undefined,
    server: server.trim() || undefined,
    readOnly,
    confirmWrites
  };
}

async function promptPasswordForProfile(existingPassword: string | undefined): Promise<string | undefined | null> {
  if (existingPassword !== undefined) {
    const action = await vscode.window.showQuickPick(
      [
        { label: "Keep existing password in profile", value: "keep" },
        { label: "Set/Update password in profile", value: "set" },
        { label: "Remove password from profile", value: "remove" }
      ],
      { placeHolder: "Profile password behavior" }
    );

    if (!action) {
      return null;
    }

    if (action.value === "keep") {
      return existingPassword;
    }

    if (action.value === "remove") {
      return "";
    }
  }

  const entered = await vscode.window.showInputBox({
    title: "Profile Password (Optional)",
    prompt: "Leave empty to resolve password at runtime (prompt + secret/session options)",
    placeHolder: "Password",
    password: true,
    ignoreFocusOut: true,
    value: ""
  });

  if (entered === undefined) {
    return null;
  }

  return entered;
}

async function promptRequiredField(
  label: string,
  prompt: string,
  initialValue: string
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Informix Profile: ${label}`,
    prompt,
    value: initialValue,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? `${label} is required.` : undefined)
  });
}

async function promptPort(initialPort: number): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    title: "Informix Profile: Port",
    prompt: "Informix port",
    value: String(initialPort),
    ignoreFocusOut: true,
    validateInput: (value) => {
      const parsed = Number.parseInt(value.trim(), 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return "Port must be an integer between 1 and 65535.";
      }
      return undefined;
    }
  });

  if (input === undefined) {
    return undefined;
  }

  return Number.parseInt(input.trim(), 10);
}

async function promptBoolean(
  title: string,
  prompt: string,
  current: boolean
): Promise<boolean | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: current ? "Yes (current)" : "Yes",
        value: true
      },
      {
        label: current ? "No" : "No (current)",
        value: false
      }
    ],
    {
      title,
      placeHolder: prompt
    }
  );

  return picked?.value;
}

function getConfigurationTarget(): vscode.ConfigurationTarget {
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.ConfigurationTarget.Workspace;
  }

  return vscode.ConfigurationTarget.Global;
}

function updateStatusBar(statusItem: vscode.StatusBarItem): void {
  const settings = vscode.workspace.getConfiguration("informixQuery");
  const profiles = readProfiles(settings);
  const validationError = validateProfileUniqueness(profiles);

  if (validationError) {
    statusItem.text = "$(error) IFX: config-error";
    statusItem.tooltip = validationError;
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    statusItem.color = new vscode.ThemeColor("statusBarItem.errorForeground");
    statusItem.show();
    return;
  }

  const indexes = buildProfileIndexes(profiles);
  const editor = vscode.window.activeTextEditor;

  if (profiles.length > 0) {
    const statementRange = editor ? getCurrentStatementRange(editor).range : undefined;
    const statementEnv = resolveEnvironmentFromStatement(editor, statementRange);
    if (statementEnv) {
      const profile = indexes.byEnvironment.get(statementEnv.toLowerCase());
      if (profile) {
        statusItem.text = `$(database) IFX: ${profile.environment} [stmt]`;
        statusItem.tooltip = `${profile.name} | ${profile.user}@${profile.host}:${profile.port}/${profile.database}`;
        statusItem.backgroundColor = undefined;
        statusItem.color = undefined;
      } else {
        statusItem.text = `$(warning) IFX: ${statementEnv} [stmt]`;
        statusItem.tooltip = `Environment '${statementEnv}' from statement comment is not configured.`;
        statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        statusItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
      }

      statusItem.show();
      return;
    }

    const fileEnv = resolveEnvironmentFromFilename(editor?.document.fileName);
    if (fileEnv) {
      const profile = indexes.byEnvironment.get(fileEnv.toLowerCase());
      if (profile) {
        statusItem.text = `$(database) IFX: ${profile.environment} [file]`;
        statusItem.tooltip = `${profile.name} | ${profile.user}@${profile.host}:${profile.port}/${profile.database}`;
        statusItem.backgroundColor = undefined;
        statusItem.color = undefined;
      } else {
        statusItem.text = `$(warning) IFX: ${fileEnv} [file]`;
        statusItem.tooltip = `Environment '${fileEnv}' from file name is not configured.`;
        statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        statusItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
      }

      statusItem.show();
      return;
    }

    const activeProfileName = (settings.get<string>("activeProfile", "") || "").trim();
    const activeProfile = activeProfileName ? indexes.byName.get(activeProfileName.toLowerCase()) : undefined;

    if (activeProfile) {
      statusItem.text = `$(database) IFX: ${activeProfile.environment} [active]`;
      statusItem.tooltip = `${activeProfile.name} | ${activeProfile.user}@${activeProfile.host}:${activeProfile.port}/${activeProfile.database}`;
      statusItem.backgroundColor = undefined;
      statusItem.color = undefined;
    } else {
      statusItem.text = "$(warning) IFX: no profile";
      statusItem.tooltip = "No active profile selected. Click to choose one.";
      statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      statusItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
    }

    statusItem.show();
    return;
  }

  const host = (settings.get<string>("host", "") || "").trim();
  const database = (settings.get<string>("database", "") || "").trim();
  if (host && database) {
    statusItem.text = "$(database) IFX: legacy [legacy]";
    statusItem.tooltip = `Legacy config: ${host}/${database}`;
    statusItem.backgroundColor = undefined;
    statusItem.color = undefined;
  } else {
    statusItem.text = "$(warning) IFX: setup";
    statusItem.tooltip = "Informix is not configured. Click to select a profile or configure settings.";
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    statusItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
  }

  statusItem.show();
}

function getEnvironments(profiles: ConnectionProfile[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const profile of profiles) {
    const key = profile.environment.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      values.push(profile.environment);
    }
  }

  return values.sort((a, b) => a.localeCompare(b));
}

function firstNonEmptyLineInRange(document: vscode.TextDocument, range: vscode.Range): number | undefined {
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    if (document.lineAt(line).text.trim().length > 0) {
      return line;
    }
  }

  return undefined;
}

function findFirstMeaningfulLine(document: vscode.TextDocument): number | undefined {
  for (let line = 0; line < document.lineCount; line += 1) {
    if (document.lineAt(line).text.trim().length > 0) {
      return line;
    }
  }

  return undefined;
}

function buildEnvFileName(uri: vscode.Uri, environment: string, knownEnvironments: string[]): string {
  const fileName = uri.scheme === "file" ? path.basename(uri.fsPath) : "query.sql";
  const lowerKnown = new Set(knownEnvironments.map((item) => item.toLowerCase()));

  const withoutSql = fileName.toLowerCase().endsWith(".sql")
    ? fileName.slice(0, -4)
    : fileName;

  const parts = withoutSql.split(".");
  if (parts.length > 1 && lowerKnown.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop();
  }

  const base = parts.join(".") || "query";
  return `${base}.${environment}.sql`;
}

function buildDefaultSaveUri(currentUri: vscode.Uri, fileName: string): vscode.Uri | undefined {
  if (currentUri.scheme === "file") {
    return vscode.Uri.file(path.join(path.dirname(currentUri.fsPath), fileName));
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return vscode.Uri.joinPath(workspaceFolder.uri, fileName);
  }

  return undefined;
}

function isRiskySql(sql: string): boolean {
  const normalized = stripSqlComments(sql).toLowerCase();

  const riskyKeywordRegex = /\b(insert|update|delete|merge|truncate|create|alter|drop|rename|grant|revoke)\b/;
  if (riskyKeywordRegex.test(normalized)) {
    return true;
  }

  const selectIntoTempRegex = /\bselect\b[\s\S]*\binto\s+temp\b/;
  return selectIntoTempRegex.test(normalized);
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ");
}

function getLegacyIdentity(settings: vscode.WorkspaceConfiguration): { label: string } | undefined {
  const host = (settings.get<string>("host", "") || "").trim();
  const database = (settings.get<string>("database", "") || "").trim();
  const user = (settings.get<string>("user", "") || "").trim();
  const port = settings.get<number>("port", 9088);

  if (!host || !database || !user) {
    return undefined;
  }

  return { label: `${user}@${host}:${port}/${database}` };
}

function buildProfileCredentialKey(profile: ConnectionProfile): string {
  return `informixQuery.password.profile.${profile.name.toLowerCase()}::${profile.environment.toLowerCase()}`;
}

function buildLegacyCredentialKey(identity: string): string {
  return `informixQuery.password.legacy.${identity.toLowerCase()}`;
}

async function migrateCredentialReferences(params: {
  context: vscode.ExtensionContext;
  sessionPasswordCache: Map<string, string>;
  from: ConnectionProfile;
  to: ConnectionProfile;
}): Promise<void> {
  const oldKey = buildProfileCredentialKey(params.from);
  const newKey = buildProfileCredentialKey(params.to);

  if (oldKey !== newKey) {
    const oldSession = params.sessionPasswordCache.get(oldKey);
    params.sessionPasswordCache.delete(oldKey);
    if (oldSession !== undefined) {
      params.sessionPasswordCache.set(newKey, oldSession);
    }

    const oldSecret = await params.context.secrets.get(oldKey);
    if (oldSecret !== undefined) {
      await params.context.secrets.store(newKey, oldSecret);
      await params.context.secrets.delete(oldKey);
      await addSecretKeyToRegistry(params.context, newKey);
      await removeSecretKeyFromRegistry(params.context, oldKey);
    }
  }

  if (params.to.password && params.to.password.length > 0) {
    await params.context.secrets.delete(newKey);
    await removeSecretKeyFromRegistry(params.context, newKey);
    params.sessionPasswordCache.delete(newKey);
  }
}

async function clearProfileSecret(context: vscode.ExtensionContext, profile: ConnectionProfile): Promise<void> {
  const key = buildProfileCredentialKey(profile);
  await context.secrets.delete(key);
  await removeSecretKeyFromRegistry(context, key);
}

function getSecretKeyRegistry(context: vscode.ExtensionContext): string[] {
  const values = context.globalState.get<string[]>(SECRET_KEY_REGISTRY_STATE, []);
  return Array.isArray(values) ? values : [];
}

async function addSecretKeyToRegistry(context: vscode.ExtensionContext, key: string): Promise<void> {
  const values = getSecretKeyRegistry(context);
  if (!values.includes(key)) {
    values.push(key);
    await context.globalState.update(SECRET_KEY_REGISTRY_STATE, values);
  }
}

async function removeSecretKeyFromRegistry(context: vscode.ExtensionContext, key: string): Promise<void> {
  const values = getSecretKeyRegistry(context).filter((item) => item !== key);
  await context.globalState.update(SECRET_KEY_REGISTRY_STATE, values);
}

function normalizeError(error: unknown): RunnerError {
  if (error instanceof RunnerError) {
    return error;
  }

  if (error instanceof Error) {
    return new RunnerError("IFX_UNKNOWN_ERROR", error.message);
  }

  return new RunnerError("IFX_UNKNOWN_ERROR", "Unknown error");
}

function logError(
  output: vscode.OutputChannel,
  code: string,
  message: string,
  details: string | undefined,
  environment: string
): void {
  output.appendLine(`[${new Date().toISOString()}] [env=${environment}] [${code}] ${message}`);
  if (details) {
    output.appendLine(details);
  }
  output.appendLine("");
}
