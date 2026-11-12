#!/usr/bin/env python3
"""Telegram MTProto 抓取 worker（可选依赖 Telethon）。

凭据经 stdin 传入，不出现在命令行参数中：
  echo '{"apiId":123,"apiHash":"...","session":"...","channel":"durov","limit":50,"minId":0}' \
    | python3 telegram_worker.py --limit 50
输出：逐行 JSON 消息。
"""
import argparse
import asyncio
import json
import sys


async def run(payload, limit):
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
    except Exception as exc:  # noqa: BLE001
        print(f"MTPROTO_UNAVAILABLE: 未安装 telethon（{exc}）", file=sys.stderr)
        sys.exit(2)

    api_id = payload.get("apiId")
    api_hash = payload.get("apiHash")
    session = payload.get("session") or ""
    channel = payload.get("channel") or ""
    min_id = int(payload.get("minId") or 0)
    limit = int(payload.get("limit") or limit or 50)
    if not api_id or not api_hash or not channel:
        print("MTPROTO_UNAVAILABLE: 缺少 apiId/apiHash/channel", file=sys.stderr)
        sys.exit(2)
    if not session:
        print("MTPROTO_UNAVAILABLE: 缺少已授权的 session", file=sys.stderr)
        sys.exit(2)

    client = TelegramClient(StringSession(session), int(api_id), str(api_hash))
    try:
        await client.connect()
        if not await client.is_user_authorized():
            print("MTPROTO_UNAVAILABLE: session 未授权或已失效", file=sys.stderr)
            sys.exit(2)
        messages = []
        async for message in client.iter_messages(channel, limit=limit, min_id=min_id):
            media = []
            if getattr(message, "photo", None):
                media.append({"type": "photo", "url": ""})
            if getattr(message, "video", None):
                media.append({"type": "video", "url": ""})
            item = {
                "id": message.id,
                "text": message.message or "",
                "date": message.date.isoformat() if message.date else None,
                "author": getattr(message, "post_author", None) or channel,
                "views": getattr(message, "views", None),
                "forwards": getattr(message, "forwards", None),
                "media": media,
                "url": f"https://t.me/{channel}/{message.id}",
            }
            messages.append(item)
        for item in messages:
            print(json.dumps(item, ensure_ascii=False), flush=True)
    finally:
        await client.disconnect()


def main():
    parser = argparse.ArgumentParser(description="Telegram MTProto worker")
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()
    raw = sys.stdin.read().strip()
    try:
        payload = json.loads(raw) if raw else {}
    except Exception:  # noqa: BLE001
        print("MTPROTO_UNAVAILABLE: stdin 不是有效 JSON", file=sys.stderr)
        sys.exit(2)
    try:
        asyncio.run(run(payload, args.limit))
    except Exception as exc:  # noqa: BLE001
        print(f"MTPROTO_UNAVAILABLE: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
