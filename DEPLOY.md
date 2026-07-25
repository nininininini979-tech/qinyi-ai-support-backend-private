# Vercel 后端部署

本目录必须进入私有 GitHub 仓库 `qinyi-ai-support-api`，再由 Vercel 导入。

Vercel 环境变量：

```dotenv
SUPPORT_PROVIDER=deepseek
DEEPSEEK_API_KEY=在Vercel中设置
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
AUTH_MODE=public
PUBLIC_TENANT_ID=public-web
SESSION_BACKEND=stateless
USER_HASH_SECRET=至少32字符的随机密钥
TRUST_PROXY=true
ALLOWED_ORIGINS=https://nininininini979-tech.github.io
AI_SERVICE_ENABLED=true
RATE_LIMIT_MAX=20
RATE_LIMIT_WINDOW=1 minute
```

`DEEPSEEK_API_KEY` 和 `USER_HASH_SECRET` 只存入 Vercel，不得提交 GitHub。公开会话使用 AES-GCM 加密令牌，订单查询和假工单已关闭。
