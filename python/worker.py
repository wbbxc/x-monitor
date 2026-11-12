#!/usr/bin/env python3
"""X 抓取 worker
- 真实模式：使用 twscrape 抓取 X 公开推文（在 .env 的 X_ACCOUNTS_JSON 配置登录账号）
- Mock 模式：从 mock_tweets.json 输出演示数据，无需任何 X 凭据

用法:
  python3 worker.py fetch --accounts karpathy,sama --per 10 --mode auto
"""
import argparse
import asyncio
import json
import os
import random
import sys
import time
from local_settings import load_x_accounts

HERE = os.path.dirname(os.path.abspath(__file__))
MOCK_FILE = os.path.join(HERE, "mock_tweets.json")
STATE_FILE = os.path.join(HERE, ".mock_state.json")


# ---------------- Mock 数据 ----------------
def load_mock_pool():
    with open(MOCK_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"emitted": []}


def normalize_cookies(val):
    """把 cookies 配置归一化为 dict，兼容多种写法：
    1. JSON 对象: {"auth_token": "...", "ct0": "..."}  ← 推荐，无需转义
    2. Cookie 头字符串: "auth_token=xxx; ct0=yyy"（值两端的引号会被自动清理）
    3. JSON 字符串: '{"auth_token": "..."}'
    """
    if isinstance(val, dict):
        return {str(k).strip(): str(v).strip() for k, v in val.items() if v}
    if isinstance(val, str):
        val = val.strip()
        try:
            d = json.loads(val)
            if isinstance(d, dict):
                return {str(k).strip(): str(v).strip() for k, v in d.items() if v}
        except Exception:
            pass
        out = {}
        for part in val.split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
        return out
    return {}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)


def gen_mock_tweets(accounts, per):
    pool = load_mock_pool()
    state = load_state()
    emitted = set(state.get("emitted", []))
    fresh = [t for t in pool if t["id"] not in emitted]

    # 每轮产出 3~6 条新推文；池子耗尽后重置状态保持演示活力
    if len(fresh) < 3:
        fresh = pool
        emitted = set()
    n = min(len(fresh), random.randint(3, 6))
    picked = random.sample(fresh, n)

    out = []
    now = time.time()
    for i, t in enumerate(picked):
        author = random.choice(accounts) if accounts else "ai_insider"
        created = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(now - random.randint(600, 86400)))
        out.append({
            "id": t["id"],
            "author_username": t.get("author_username") or author,
            "author_name": t.get("author_name") or author,
            "text": t["text"],
            "tweet_created_at": created,
            "like_count": t.get("like_count", random.randint(200, 8000)),
            "retweet_count": t.get("retweet_count", random.randint(20, 900)),
            "reply_count": t.get("reply_count", random.randint(10, 300)),
            "view_count": t.get("view_count", random.randint(30000, 900000)),
            "media": t.get("media", []),
            "url": f"https://x.com/{author}/status/{t['id']}",
            "is_mock": 1,
        })
        emitted.add(t["id"])
    state["emitted"] = sorted(emitted)
    save_state(state)
    return out


# ---------------- 真实抓取 ----------------
def tweet_to_dict(t, fallback_author=""):
    media = []
    # twscrape 0.20: t.media 是 Media 容器对象（photos/videos/animated）
    if t.media:
        for p in t.media.photos:
            media.append({"type": "photo", "url": p.url})
        for v in t.media.videos:
            media.append({"type": "video", "url": v.thumbnailUrl})
        for a in t.media.animated:
            media.append({"type": "animated_gif", "url": a.videoUrl})
    author = t.user.username if t.user else fallback_author
    return {
        "id": str(t.id),
        "author_username": author,
        "author_name": (t.user.displayname if t.user else "") or "",
        "text": t.rawContent or "",
        "tweet_created_at": t.date.strftime("%Y-%m-%dT%H:%M:%S+00:00") if t.date else None,
        "like_count": t.likeCount or 0,
        "retweet_count": t.retweetCount or 0,
        "reply_count": t.replyCount or 0,
        "view_count": t.viewCount or 0,
        "media": media,
        "url": t.url or f"https://x.com/{author}/status/{t.id}",
        "is_mock": 0,
    }


async def build_api():
    from twscrape import API

    cfg = load_x_accounts()

    # 代理配置（访问 X 必需，直连会被拦截导致请求挂起）：
    # 优先级: 环境变量 X_PROXY > accounts.json 顶层 "proxy" > 账号内 "proxy"
    global_proxy = os.environ.get("X_PROXY", "").strip()
    if isinstance(cfg, dict):
        logins = cfg.get("accounts", [])
        if not global_proxy:
            global_proxy = (cfg.get("proxy") or "").strip()
    else:
        logins = cfg

    if not logins:
        raise RuntimeError("X_ACCOUNTS_JSON 为空，无法进行真实抓取（可改用 --mode mock）")
    if global_proxy:
        print("# 已配置 X 访问代理", file=sys.stderr)
    else:
        print(f"# 警告: 未配置代理，若无法直连 X 会挂起（可在 .env 设 X_PROXY）", file=sys.stderr)

    api = API(proxy=global_proxy or None)
    cookie_count = 0
    for a in logins:
        if a.get("cookies"):
            # 方式 B：直接注入浏览器 Cookie（推荐，绕过登录风控）
            try:
                cookies = normalize_cookies(a["cookies"])
                if not cookies.get("auth_token") or not cookies.get("ct0"):
                    raise ValueError("cookies 缺少 auth_token 或 ct0")
                # add_account_cookies 要求字符串，传 JSON 字符串即可
                await api.pool.add_account_cookies(a["username"], json.dumps(cookies))
                cookie_count += 1
                print(f"# 账号 @{a['username']} 使用 Cookie 认证（{len(cookies)} 个字段）", file=sys.stderr)
            except Exception as e:
                print(f"# 账号 @{a['username']} Cookie 无效: {e}", file=sys.stderr)
        else:
            # 方式 A：账号密码登录
            await api.pool.add_account(
                a["username"], a.get("password", ""),
                a.get("email", ""), a.get("email_password", ""),
                proxy=a.get("proxy") or global_proxy or None,
            )

    if cookie_count == 0:
        # 密码登录（twscrape 0.20+ 返回汇总字典）
        result = await api.pool.login_all()
        success = result.get("success", 0) if isinstance(result, dict) else 0
        failed = result.get("failed", 0) if isinstance(result, dict) else 0
        print(f"# 密码登录结果: 成功 {success} / 失败 {failed}", file=sys.stderr)
        if success == 0:
            raise RuntimeError(
                "所有账号密码登录失败（X 风控/验证码/二次验证拦截）。"
                "建议改用 Cookie 认证：浏览器登录 x.com 后，在 .env 的 X_ACCOUNTS_JSON 中添加 cookies 字段"
                "（auth_token 与 ct0，格式 \"auth_token=xxx; ct0=yyy\"），详见 README"
            )
    else:
        print(f"# 共 {cookie_count} 个账号使用 Cookie 认证", file=sys.stderr)
    return api


async def fetch_real(accounts, per):
    from twscrape import gather

    api = await build_api()
    for username in accounts:
        try:
            # twscrape 0.20: user_tweets 需要数字 user id，先用 user_by_login 解析用户名
            user = await api.user_by_login(username)
            if user is None:
                print(f"# @{username} 解析失败（用户不存在或接口被拦）", file=sys.stderr)
                continue
            tweets = await gather(api.user_tweets(user.id, limit=per))
            print(f"# @{username} 抓到 {len(tweets)} 条", file=sys.stderr)
            for t in tweets:
                print(json.dumps(tweet_to_dict(t, username), ensure_ascii=False), flush=True)
        except Exception as e:
            print(f"# 抓取 @{username} 失败: {e}", file=sys.stderr)


async def search_real(query, per, search_type="latest", min_likes=0, lang="", since="", until=""):
    from twscrape import gather

    api = await build_api()
    kwargs = {}
    if search_type:
        product = "Latest" if search_type.lower() == "latest" else "Top"
        kwargs["kv"] = {"product": product}
    tweets = await gather(api.search(query, limit=per, **kwargs))
    print(f"# 搜索 {query!r} 抓到 {len(tweets)} 条", file=sys.stderr)
    out = []
    for t in tweets:
        item = tweet_to_dict(t)
        if min_likes and int(item.get("like_count") or 0) < int(min_likes):
            continue
        text = (item.get("text") or "").lower()
        if lang and not _looks_like_lang(text, lang):
            continue
        created = item.get("tweet_created_at") or ""
        if since and created[:10] < since:
            continue
        if until and created[:10] > until:
            continue
        out.append(item)
    for item in out:
        print(json.dumps(item, ensure_ascii=False), flush=True)


def _looks_like_lang(text, lang):
    if not lang:
        return True
    if lang.lower() == "zh":
        return any("\u4e00" <= ch <= "\u9fff" for ch in text)
    if lang.lower() == "en":
        return all(ord(ch) < 128 or ch.isspace() for ch in text)
    return True


def gen_mock_search(query, per):
    pool = load_mock_pool()
    words = [w for w in query.lower().replace('"', " ").split() if w]
    matched = [t for t in pool if not words or any(w in t["text"].lower() for w in words)]
    matched.sort(key=lambda t: str(t["id"]), reverse=True)
    out = []
    for t in matched[:per]:
        author = t.get("author_username") or "ai_insider"
        out.append({
            "id": t["id"],
            "author_username": author,
            "author_name": t.get("author_name") or author,
            "text": t["text"],
            "tweet_created_at": t.get("tweet_created_at")
                or time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
            "like_count": t.get("like_count", 0),
            "retweet_count": t.get("retweet_count", 0),
            "reply_count": t.get("reply_count", 0),
            "view_count": t.get("view_count", 0),
            "media": t.get("media", []),
            "url": f"https://x.com/{author}/status/{t['id']}",
            "is_mock": 1,
        })
    return out


def main():
    parser = argparse.ArgumentParser(description="X 抓取 worker")
    sub = parser.add_subparsers(dest="cmd", required=True)

    fetch = sub.add_parser("fetch", help="抓取账号最新推文")
    fetch.add_argument("--accounts", required=True, help="逗号分隔的用户名")
    fetch.add_argument("--per", type=int, default=10, help="每账号抓取条数")
    fetch.add_argument("--mode", choices=["auto", "mock", "real"], default="auto",
                       help="auto: 有登录账号则真实抓取，否则 mock")

    search = sub.add_parser("search", help="按关键词搜索推文")
    search.add_argument("--query", required=True, help="搜索关键词")
    search.add_argument("--per", type=int, default=50, help="抓取条数")
    search.add_argument("--type", choices=["latest", "top"], default="latest", help="搜索排序")
    search.add_argument("--min-likes", type=int, default=0, help="最低点赞数")
    search.add_argument("--lang", default="", help="语言过滤（zh/en）")
    search.add_argument("--since", default="", help="起始日期 YYYY-MM-DD")
    search.add_argument("--until", default="", help="结束日期 YYYY-MM-DD")
    search.add_argument("--mode", choices=["auto", "mock", "real"], default="auto",
                        help="auto: 有登录账号则真实抓取，否则 mock")

    args = parser.parse_args()

    if args.cmd == "fetch":
        accounts = [a.strip().lstrip("@") for a in args.accounts.split(",") if a.strip()]
        mode = args.mode
        if mode == "auto":
            mode = "real" if load_x_accounts()["accounts"] else "mock"

        if mode == "mock":
            for t in gen_mock_tweets(accounts, args.per):
                print(json.dumps(t, ensure_ascii=False), flush=True)
        else:
            try:
                asyncio.run(fetch_real(accounts, args.per))
            except Exception as e:
                print(f"FATAL: {e}", file=sys.stderr)
                sys.exit(1)

    if args.cmd == "search":
        mode = args.mode
        if mode == "auto":
            mode = "real" if load_x_accounts()["accounts"] else "mock"
        if mode == "mock":
            for t in gen_mock_search(args.query, args.per):
                print(json.dumps(t, ensure_ascii=False), flush=True)
        else:
            try:
                asyncio.run(search_real(
                    args.query, args.per, args.type, args.min_likes,
                    args.lang, args.since, args.until,
                ))
            except Exception as e:
                print(f"FATAL: {e}", file=sys.stderr)
                sys.exit(1)


if __name__ == "__main__":
    main()
