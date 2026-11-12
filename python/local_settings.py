import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env():
    file = os.environ.get("XMONITOR_ENV_FILE") or os.path.join(ROOT, ".env")
    if not os.path.exists(file):
        return
    with open(file, "r", encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(key.strip(), value)


def load_x_accounts():
    load_env()
    raw = os.environ.get("X_ACCOUNTS_JSON", "").strip()
    try:
        if raw:
            value = json.loads(raw)
        else:
            file = os.path.join(ROOT, "python", "accounts.json")
            if not os.path.exists(file):
                return {"accounts": []}
            with open(file, "r", encoding="utf-8") as stream:
                value = json.load(stream)
    except (ValueError, OSError):
        raise ValueError("X_ACCOUNTS_JSON 或旧账号文件必须为合法 JSON") from None
    result = {"accounts": value} if isinstance(value, list) else value
    if not isinstance(result, dict) or not isinstance(result.get("accounts"), list) or any(
        not isinstance(account, dict) or not isinstance(account.get("username"), str)
        or not account["username"].strip() for account in result["accounts"]
    ):
        raise ValueError("X_ACCOUNTS_JSON 必须为账号数组或含 accounts 数组的对象")
    return result
