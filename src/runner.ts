import * as path from "path";
import { spawn } from "child_process";
import * as fs from "fs/promises";

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  server?: string;
}

export interface RunQuerySuccess {
  ok: true;
  action: "run_query";
  columns: string[];
  rows: Array<Array<unknown>>;
  row_count: number;
  elapsed_ms: number;
  truncated: boolean;
}

export interface TestConnectionSuccess {
  ok: true;
  action: "test_connection";
  elapsed_ms: number;
  message: string;
}

export interface BridgeFailure {
  ok: false;
  error_code: string;
  message: string;
  details?: string;
}

export type QueryResponse = RunQuerySuccess | BridgeFailure;
export type TestConnectionResponse = TestConnectionSuccess | BridgeFailure;

export class RunnerError extends Error {
  public readonly code: string;
  public readonly details?: string;

  constructor(code: string, message: string, details?: string) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

interface BaseBridgeParams {
  extensionPath: string;
  bridgePythonPath: string;
  timeoutMs: number;
  connection: ConnectionConfig;
}

interface RunQueryParams extends BaseBridgeParams {
  maxRows: number;
  sql: string;
}

interface TestConnectionParams extends BaseBridgeParams {}

interface EnsurePythonParams {
  globalStoragePath: string;
  pythonPath: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runQuery(params: RunQueryParams): Promise<QueryResponse> {
  const bridgeResponse = await runBridge({
    extensionPath: params.extensionPath,
    bridgePythonPath: params.bridgePythonPath,
    timeoutMs: params.timeoutMs,
    payload: {
      action: "run_query",
      connection: params.connection,
      sql: params.sql,
      timeout_ms: params.timeoutMs,
      max_rows: params.maxRows
    }
  });

  if (!isRunQueryResponse(bridgeResponse)) {
    throw new RunnerError("IFX_BRIDGE_PROTOCOL_ERROR", "Bridge response does not match query schema.");
  }

  return bridgeResponse;
}

export async function testConnection(params: TestConnectionParams): Promise<TestConnectionResponse> {
  const bridgeResponse = await runBridge({
    extensionPath: params.extensionPath,
    bridgePythonPath: params.bridgePythonPath,
    timeoutMs: params.timeoutMs,
    payload: {
      action: "test_connection",
      connection: params.connection,
      timeout_ms: params.timeoutMs
    }
  });

  if (!isTestConnectionResponse(bridgeResponse)) {
    throw new RunnerError("IFX_BRIDGE_PROTOCOL_ERROR", "Bridge response does not match test connection schema.");
  }

  return bridgeResponse;
}

interface RunBridgeParams {
  extensionPath: string;
  bridgePythonPath: string;
  timeoutMs: number;
  payload: Record<string, unknown>;
}

async function runBridge(params: RunBridgeParams): Promise<RunQuerySuccess | TestConnectionSuccess | BridgeFailure> {
  const scriptPath = path.join(params.extensionPath, "python", "run_query.py");

  return new Promise((resolve, reject) => {
    const child = spawn(params.bridgePythonPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const payload = JSON.stringify(params.payload);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, params.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new RunnerError("IFX_BRIDGE_START_ERROR", `Failed to start Python bridge: ${err.message}`));
    });

    child.on("close", () => {
      clearTimeout(timeoutHandle);

      const sanitizedStdout = sanitizeSensitive(stdout.trim());
      const sanitizedStderr = sanitizeSensitive(stderr.trim());

      if (timedOut) {
        reject(new RunnerError("IFX_TIMEOUT", `Request exceeded timeout of ${params.timeoutMs} ms.`, sanitizedStderr || undefined));
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new RunnerError("IFX_BRIDGE_PROTOCOL_ERROR", "Python bridge returned empty output.", sanitizedStderr || undefined));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        reject(new RunnerError(
          "IFX_BRIDGE_PROTOCOL_ERROR",
          "Python bridge returned invalid JSON.",
          `stdout=${sanitizedStdout}\nstderr=${sanitizedStderr}`
        ));
        return;
      }

      if (!isBridgePayload(parsed)) {
        reject(new RunnerError(
          "IFX_BRIDGE_PROTOCOL_ERROR",
          "Python bridge response does not match expected schema.",
          `stdout=${sanitizedStdout}\nstderr=${sanitizedStderr}`
        ));
        return;
      }

      resolve(parsed);
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

export async function ensurePythonBridge(params: EnsurePythonParams): Promise<string> {
  const envRoot = path.join(params.globalStoragePath, "python-env");
  const envPython = getVenvPythonPath(envRoot);

  await fs.mkdir(params.globalStoragePath, { recursive: true });

  if (!(await exists(envPython))) {
    await execOrThrow(params.pythonPath, ["-m", "venv", envRoot], 120000, "IFX_VENV_CREATE_ERROR");
  }

  const hasDriver = await canImportIbmDb(envPython);
  if (!hasDriver) {
    await execOrThrow(
      envPython,
      ["-m", "pip", "install", "--disable-pip-version-check", "ibm-db"],
      240000,
      "IFX_DRIVER_INSTALL_ERROR"
    );
  }

  return envPython;
}

function isBridgePayload(value: unknown): value is RunQuerySuccess | TestConnectionSuccess | BridgeFailure {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const data = value as Record<string, unknown>;
  if (typeof data.ok !== "boolean") {
    return false;
  }

  if (!data.ok) {
    return typeof data.error_code === "string" && typeof data.message === "string";
  }

  return typeof data.action === "string";
}

function isRunQueryResponse(value: unknown): value is QueryResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const data = value as Record<string, unknown>;

  if (data.ok === false) {
    return typeof data.error_code === "string" && typeof data.message === "string";
  }

  return (
    data.ok === true &&
    data.action === "run_query" &&
    Array.isArray(data.columns) &&
    Array.isArray(data.rows) &&
    typeof data.row_count === "number" &&
    typeof data.elapsed_ms === "number" &&
    typeof data.truncated === "boolean"
  );
}

function isTestConnectionResponse(value: unknown): value is TestConnectionResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const data = value as Record<string, unknown>;

  if (data.ok === false) {
    return typeof data.error_code === "string" && typeof data.message === "string";
  }

  return (
    data.ok === true &&
    data.action === "test_connection" &&
    typeof data.elapsed_ms === "number" &&
    typeof data.message === "string"
  );
}

function getVenvPythonPath(envRoot: string): string {
  if (process.platform === "win32") {
    return path.join(envRoot, "Scripts", "python.exe");
  }

  return path.join(envRoot, "bin", "python");
}

async function canImportIbmDb(pythonExec: string): Promise<boolean> {
  try {
    const result = await execCommand(
      pythonExec,
      ["-c", "import ibm_db"],
      20000
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function execOrThrow(cmd: string, args: string[], timeoutMs: number, code: string): Promise<void> {
  let result: ExecResult;
  try {
    result = await execCommand(cmd, args, timeoutMs);
  } catch (error: unknown) {
    if (error instanceof RunnerError) {
      throw error;
    }
    throw new RunnerError(code, `Command failed: ${cmd} ${args.join(" ")}`, String(error));
  }

  if (result.exitCode !== 0) {
    const details = `exit=${result.exitCode}\nstdout=${sanitizeSensitive(result.stdout.trim())}\nstderr=${sanitizeSensitive(result.stderr.trim())}`;
    throw new RunnerError(code, `Command failed: ${cmd} ${args.join(" ")}`, details);
  }
}

async function execCommand(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new RunnerError("IFX_COMMAND_ERROR", `Failed to start command: ${cmd}`, err.message));
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (timedOut) {
        reject(new RunnerError("IFX_COMMAND_TIMEOUT", `Command timed out: ${cmd} ${args.join(" ")}`));
        return;
      }

      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1
      });
    });
  });
}

function sanitizeSensitive(value: string): string {
  if (!value) {
    return value;
  }

  return value
    .replace(/(PWD\s*=\s*)([^;\s]+)/gi, "$1***")
    .replace(/(password\s*[=:]\s*)([^;\s,]+)/gi, "$1***")
    .replace(/("password"\s*:\s*")([^"]+)(")/gi, "$1***$3");
}
