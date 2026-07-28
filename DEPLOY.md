# 后端部署

本目录属于私有仓库 `qinyi-ai-support-backend-private`。访客静态站属于独立公开仓库 `qinyi-printing-website`。不要把 `.env`、账号卡、运行数据、备份、客户附件或 API 密钥复制到任一仓库。

## 路径一：轻量 AI 客服

`vercel.json` 只转发 `/api/support/*`，适合无订单、无后台、无 CMS、无上传的轻量客服。它不是完整运营系统部署方案。

Vercel 最小环境变量：

```dotenv
NODE_ENV=production
SUPPORT_PROVIDER=deepseek
DEEPSEEK_API_KEY=在平台密钥管理中设置
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
AUTH_MODE=public
PUBLIC_TENANT_ID=public-web
SESSION_BACKEND=stateless
USER_HASH_SECRET=独立的至少32字符随机值
TRUST_PROXY=true
ALLOWED_ORIGINS=https://正式访客域名
AI_SERVICE_ENABLED=true
OPERATIONS_ENABLED=false
```

该路径没有 `/admin`、`/developer`、订单、询价、人工转交队列、CMS、SEO/GEO 审批或附件存储。

## 路径二：完整运营系统

完整系统必须使用 `Dockerfile` 部署到支持长驻 Node.js 进程和私有网络的平台。最低依赖：

- Node.js 22+ 容器，监听平台注入的端口或 `3002`。
- PostgreSQL，启用 TLS、备份和时间点恢复。
- 私有 S3 兼容对象桶，禁止公共读并启用服务端加密和版本控制。
- 真实 HTTPS 短信网关、模板编号和令牌。
- DeepSeek 或 OpenAI 正式凭据。
- 精确 HTTPS 域名、TLS 终止和 CORS 来源。
- 仓库外完成的 20 个管理员与 4 个开发者账号初始化。

构建和本地容器检查：

```bash
docker build -t qinyi-ai-support:release .
docker run --rm --env-file /仓库外/qinyi-production.env -p 3002:3002 qinyi-ai-support:release
curl --fail http://127.0.0.1:3002/health/live
curl --fail http://127.0.0.1:3002/health/ready
```

正式变量和迁移步骤见 [`docs/PRODUCTION_OPERATIONS.md`](docs/PRODUCTION_OPERATIONS.md)。`/health/ready` 会检查当前 OperationsStore 和对象桶；短信及模型真实调用必须在预发布环境单独验收。

## 上线门槛

```bash
npm ci
npm audit --omit=dev
npm test
npm run delivery:check
npm run production:check -- --evidence=/仓库外/qinyi-readiness-evidence.json
```

`production:check` 分开报告静态配置和外部验收。缺少 PostgreSQL、对象存储、短信、模型、账号或恢复演练证据时，结果必须保持 `ready: false`。不能用本地 mock 或“待补充”连接器冒充正式联机。

部署后再验收访客、管理员和开发者三端，完成一次询价转订单、商务状态推进、生产状态推进、人工转交确认、CMS 发布/回滚和 SEO/GEO 审批/回滚，再逐步切换流量。
