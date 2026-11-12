#!/usr/bin/env python3
"""诊断脚本：测试 twscrape 登录与抓取，输出详细结果（不打印密码）"""
import asyncio
import json
import os
import sys
from local_settings import load_x_accounts

HERE = os.path.dirname(os.path.abspath(__file__))


async def main():
    from twscrape import API, gather

    logins = load_x_accounts()["accounts"]
    print(f"配置账号数: {len(logins)}", flush=True)

    api = API()
    for a in logins:
        await api.pool.add_account(
            a["username"], a.get("password", ""),
            a.get("email", ""), a.get("email_password", ""),
        )
        print(f"已添加账号 @{a['username'][:3]}***", flush=True)

    print("开始登录（可能需要 30-120 秒）...", flush=True)
    try:
        result = await api.pool.login_all()
        if isinstance(result, dict):
            print(f"登录结果: 成功 {result.get('success')} / 失败 {result.get('failed')} / 总数 {result.get('total')}", flush=True)
        else:
            print(f"登录结果(原始): {str(result)[:300]}", flush=True)
    except Exception as e:
        print(f"login_all 抛异常: {type(e).__name__}: {str(e)[:300]}", flush=True)
        return

    # 尝试抓取一个账号验证
    try:
        tweets = await gather(api.user_tweets("karpathy", limit=3))
        print(f"抓取测试 @karpathy -> {len(tweets)} 条", flush=True)
        for t in tweets[:3]:
            print(f"  示例: {t.rawContent[:60]}", flush=True)
    except Exception as e:
        print(f"抓取测试异常: {type(e).__name__}: {str(e)[:300]}", flush=True)


asyncio.run(main())
