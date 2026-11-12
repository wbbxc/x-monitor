#!/usr/bin/env python3
"""把损坏的 accounts.json 中的 Cookie 字符串转换为合法的 JSON 对象格式"""
import json
import re
import shutil

SRC = 'accounts.json'
shutil.copy(SRC, SRC + '.bak')

src = open(SRC, encoding='utf-8').read()

# 提取原始字段（用户名等）
def field(name):
    m = re.search(rf'"{name}":\s*"([^"]*)"', src)
    return m.group(1) if m else ''

username = field('username')
password = field('password')
email = field('email')
email_password = field('email_password')

# 提取 cookies 单引号字符串（cookie 串内不含单引号，安全）
start = src.index("'", src.index('"cookies"')) + 1
end = src.index("'", start)
raw = src[start:end]

def parse_cookie_header(s):
    out = {}
    for part in s.split("; "):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        # 去掉值两端的引号
        if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
            v = v[1:-1]
        out[k] = v
    return out

cookies = parse_cookie_header(raw)

data = [{
    "username": username,
    "password": password,
    "email": email,
    "email_password": email_password,
    "cookies": cookies,
}]

with open(SRC, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

# 校验
with open(SRC, encoding='utf-8') as f:
    check = json.load(f)
c = check[0]['cookies']
print(f"✅ 转换完成，JSON 合法")
print(f"  username: {username}")
print(f"  cookie 字段数: {len(c)}")
print(f"  auth_token: {'有 ✓' if c.get('auth_token') else '缺失 ✗'}")
print(f"  ct0: {'有 ✓' if c.get('ct0') else '缺失 ✗'}")
print(f"  其余字段（password/email/email_password）已保留，备份在 accounts.json.bak")
