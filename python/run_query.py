#!/usr/bin/env python3
import json
import re
import sys
import time
import traceback
from typing import Any


def sanitize_text(value: str) -> str:
    sanitized = re.sub(r"(PWD\s*=\s*)([^;\s]+)", r"\1***", value, flags=re.IGNORECASE)
    sanitized = re.sub(r"(password\s*[=:]\s*)([^;\s,]+)", r"\1***", sanitized, flags=re.IGNORECASE)
    sanitized = re.sub(r'("password"\s*:\s*")([^"]+)(")', r"\1***\3", sanitized, flags=re.IGNORECASE)
    return sanitized


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=True))


def error(error_code: str, message: str, details: str | None = None) -> None:
    payload: dict[str, Any] = {
        "ok": False,
        "error_code": error_code,
        "message": sanitize_text(message),
    }
    if details:
        payload["details"] = sanitize_text(details)
    emit(payload)


def build_conn_str(connection: dict[str, Any]) -> str:
    host = str(connection.get("host", "")).strip()
    port = int(connection.get("port", 9088))
    database = str(connection.get("database", "")).strip()
    user = str(connection.get("user", "")).strip()
    password = str(connection.get("password", ""))
    server = str(connection.get("server", "")).strip()

    parts = [
        f"DATABASE={database}",
        f"HOSTNAME={host}",
        f"PORT={port}",
        "PROTOCOL=onsoctcp",
        f"UID={user}",
        f"PWD={password}",
    ]
    if server:
        parts.append(f"SERVER={server}")
    return ";".join(parts) + ";"


def connect_ibm_db(ibm_db: Any, connection: dict[str, Any]) -> Any:
    conn_str = build_conn_str(connection)
    return ibm_db.connect(conn_str, "", "")


def run_test_connection(ibm_db: Any, connection: dict[str, Any]) -> int:
    start = time.perf_counter()
    conn = None

    try:
        conn = connect_ibm_db(ibm_db, connection)
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        emit(
            {
                "ok": True,
                "action": "test_connection",
                "elapsed_ms": elapsed_ms,
                "message": "Connection successful",
            }
        )
        return 0
    except Exception as exc:
        error("IFX_CONNECT_ERROR", "Failed to connect to Informix.", str(exc))
        return 0
    finally:
        if conn is not None:
            try:
                ibm_db.close(conn)
            except Exception:
                pass


def run_query_action(ibm_db: Any, connection: dict[str, Any], sql: str, max_rows: int) -> int:
    conn = None
    start = time.perf_counter()

    try:
        try:
            conn = connect_ibm_db(ibm_db, connection)
        except Exception as exc:
            error("IFX_CONNECT_ERROR", "Failed to connect to Informix.", str(exc))
            return 0

        try:
            stmt = ibm_db.exec_immediate(conn, sql)
        except Exception as exc:
            error("IFX_EXEC_ERROR", "Failed to execute SQL.", str(exc))
            return 0

        columns: list[str] = []
        rows: list[list[Any]] = []
        truncated = False

        try:
            field_count = int(ibm_db.num_fields(stmt))
        except Exception:
            field_count = 0

        if field_count > 0:
            for idx in range(field_count):
                columns.append(str(ibm_db.field_name(stmt, idx)))

            while True:
                row = ibm_db.fetch_tuple(stmt)
                if row is False:
                    break
                if len(rows) >= max_rows:
                    truncated = True
                    break
                rows.append(list(row))
            row_count = len(rows)
        else:
            try:
                row_count = int(ibm_db.num_rows(stmt))
            except Exception:
                row_count = 0
            truncated = False

        elapsed_ms = int((time.perf_counter() - start) * 1000)
        emit(
            {
                "ok": True,
                "action": "run_query",
                "columns": columns,
                "rows": rows,
                "row_count": row_count,
                "elapsed_ms": elapsed_ms,
                "truncated": truncated,
            }
        )
        return 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        error("IFX_UNEXPECTED_ERROR", "Unexpected bridge error.", str(exc))
        return 0
    finally:
        if conn is not None:
            try:
                ibm_db.close(conn)
            except Exception:
                pass


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        error("IFX_INPUT_ERROR", "Empty stdin payload.")
        return 0

    try:
        payload = json.loads(raw)
    except Exception as exc:
        error("IFX_INPUT_ERROR", "Invalid JSON payload.", str(exc))
        return 0

    action = payload.get("action", "run_query")
    connection = payload.get("connection")
    sql = payload.get("sql")
    max_rows = payload.get("max_rows", 1000)

    if not isinstance(connection, dict):
        error("IFX_INPUT_ERROR", "Payload field 'connection' must be an object.")
        return 0

    if action == "run_query":
        if not isinstance(sql, str) or not sql.strip():
            error("IFX_INPUT_ERROR", "Payload field 'sql' must be a non-empty string.")
            return 0
        if not isinstance(max_rows, int) or max_rows < 1:
            error("IFX_INPUT_ERROR", "Payload field 'max_rows' must be an integer >= 1.")
            return 0
    elif action == "test_connection":
        pass
    else:
        error("IFX_INPUT_ERROR", "Payload field 'action' must be 'run_query' or 'test_connection'.")
        return 0

    try:
        import ibm_db  # type: ignore
    except Exception as exc:
        error("IFX_DRIVER_ERROR", "Failed to import ibm-db module.", str(exc))
        return 0

    if action == "test_connection":
        return run_test_connection(ibm_db, connection)

    return run_query_action(ibm_db, connection, sql.strip(), max_rows)


if __name__ == "__main__":
    raise SystemExit(main())
