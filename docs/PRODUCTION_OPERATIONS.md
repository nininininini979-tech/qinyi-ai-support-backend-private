# 勤益生产运营部署

`file` 存储只用于本机演示或单机恢复；完整生产系统使用 `postgres` + `s3`。订单、询价、客服、CMS、SEO/GEO、账号与审计共享 PostgreSQL 事务状态，客户和 CMS 文件进入私有对象桶。切换存储不能改变订单状态机、人工转交状态机、审批、发布或 Agent 权限边界。

## 本地完整演示

统一地址：访客站 `http://127.0.0.1:4174/zh-CN/index.html`，管理员 `http://127.0.0.1:3002/admin`，开发者 `http://127.0.0.1:3002/developer`。

账号只初始化一次，并且凭据必须写到仓库外的新目录：

```bash
QINYI_CREDENTIAL_BUNDLE_PASSPHRASE='现场输入的至少16字符口令' \
  npm run accounts:provision -- \
  --output /仓库外/qinyi-secure-credentials \
  --data-dir /仓库外/qinyi-demo-operations
```

该命令生成 20 个名称可修改的管理员和 4 个名称固定的开发者。后端使用 `OPERATIONS_ACCOUNTS_PROVISIONED=true` 读取存储中的密码哈希，不需要在运行环境重复保存 24 个明文密码。本地使用 `ORDER_SMS_PROVIDER=mock`；生产环境会拒绝 mock。

## 正式环境矩阵

下列值必须由部署平台的密钥管理和环境配置注入，不得写入仓库：

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3002
TRUST_PROXY=true

SUPPORT_PROVIDER=deepseek
DEEPSEEK_API_KEY=待平台密钥管理注入
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=待企业确认
AI_SERVICE_ENABLED=true

AUTH_MODE=public
PUBLIC_TENANT_ID=public-web
PUBLIC_SITE_URL=https://待补充的正式访客域名
PUBLIC_API_URL=https://待补充的正式API域名
ALLOWED_ORIGINS=https://待补充的正式访客域名
SESSION_BACKEND=stateless
USER_HASH_SECRET=独立的至少32字符随机值

OPERATIONS_ENABLED=true
OPERATIONS_STORE=postgres
DATABASE_URL=待补充的PostgreSQL连接地址
DATABASE_SSL_MODE=verify-full
OPERATIONS_ACCOUNTS_PROVISIONED=true
OPERATIONS_SESSION_SECRET=独立的至少32字符随机值
OPERATIONS_DEVELOPER_TOKEN=独立的至少24字符随机值

UPLOAD_STORE=s3
S3_REGION=待补充
S3_ENDPOINT=https://待补充的私有对象存储端点
S3_BUCKET=待补充
S3_KEY_PREFIX=qinyi
S3_ACCESS_KEY_ID=待平台密钥管理注入
S3_SECRET_ACCESS_KEY=待平台密钥管理注入
S3_FORCE_PATH_STYLE=false
S3_SERVER_SIDE_ENCRYPTION=AES256

ORDER_SMS_PROVIDER=http
ORDER_SMS_HTTP_URL=https://待补充的短信网关/send-code
ORDER_SMS_HTTP_TOKEN=待平台密钥管理注入
ORDER_SMS_TEMPLATE_ID=待补充的已审核模板
ORDER_SMS_SIGN_NAME=勤益
```

若使用 Redis 会话，必须改为 `SESSION_BACKEND=redis` 并使用远程 `rediss://` 地址。密钥之间不得复用。生产环境不得使用 `mock`、本地数据库地址、HTTP 外部端点、通配 CORS 或仓库内凭据文件。

## 账号与数据迁移

1. 在仓库外的隔离文件目录运行 `accounts:provision`，由负责人分别保管一次性账号卡和加密总包。
2. 对现有文件状态做校验备份：

```bash
npm run operations:backup:file -- --source=/仓库外/qinyi-operations --destination=/仓库外/qinyi-backups
npm run operations:backup:verify -- --backup=/仓库外/qinyi-backups/具体时间目录
```

3. 建立空 PostgreSQL 数据库并执行 `migrations/001_operations_state.sql`。应用启动也会幂等创建同一结构。
4. 停止旧服务写入，设置 `DATABASE_URL`，只向空数据库导入一次：

```bash
npm run operations:migrate:postgres -- --source=/仓库外/qinyi-operations
```

5. 在隔离环境查询账号数量和角色，确认 20 个 `administrator`、4 个 `developer`；不得把查询结果中的密码或令牌写入日志。
6. 配置对象桶：禁止公共读、启用版本控制和服务端加密、限制应用账号只能访问指定桶和前缀、设置删除恢复窗口。

## 构建与启动

```bash
npm ci
npm audit --omit=dev
npm test
npm run delivery:check
docker build -t qinyi-ai-support:release .
docker run --rm --env-file /仓库外/qinyi-production.env -p 3002:3002 qinyi-ai-support:release
```

平台必须使用滚动发布或蓝绿发布，保持至少一个健康实例。不要在无持久磁盘的容器中使用 `OPERATIONS_STORE=file` 或 `UPLOAD_STORE=file`。

## 健康与联机验收

- `/health/live` 只证明 Node 进程能响应。
- `/health/ready` 会实际读取 OperationsStore，并对 S3 兼容桶执行 HeadBucket。失败返回 503。
- `/health/ready` 不发送短信、不调用模型，响应会明确标记 `configured_not_probed`。
- 真实短信、模型、PostgreSQL 事务、对象上传下载和备份恢复必须在预发布环境独立验收。

把真实验收结果写入仓库外 JSON，不得包含连接串、手机号、验证码、对象键或消息正文：

```json
{
  "checks": {
    "postgres": { "status": "passed", "verifiedAt": "2026-01-01T00:00:00Z", "verifiedBy": "负责人姓名" },
    "objectStorage": { "status": "passed", "verifiedAt": "2026-01-01T00:00:00Z", "verifiedBy": "负责人姓名" },
    "sms": { "status": "passed", "verifiedAt": "2026-01-01T00:00:00Z", "verifiedBy": "负责人姓名" },
    "aiProvider": { "status": "passed", "verifiedAt": "2026-01-01T00:00:00Z", "verifiedBy": "负责人姓名" },
    "accounts": { "status": "passed", "verifiedAt": "2026-01-01T00:00:00Z", "verifiedBy": "负责人姓名" },
    "backupRestore": { "status": "passed", "verifiedAt": "2026-01-01T00:00:00Z", "verifiedBy": "负责人姓名" }
  }
}
```

然后运行：

```bash
npm run production:check -- --evidence=/仓库外/qinyi-readiness-evidence.json
```

只有 `configurationReady`、`externalReady` 和 `ready` 同时为 `true` 才能进入切流审批。没有企业凭据时保持“待补充”，不能制作虚假证据文件。

## 业务验收清单

1. 访客提交询价和附件，管理员只看到授权范围内的数据。
2. 管理员把询价转换为同一手机号的唯一订单。
3. 商务流程按固定顺序推进，不能跳步；工厂生产流程同样不能跳步。
4. 访客短信登录后只能看到自己的订单和对外状态，不显示内部人员、备注和外部引用。
5. 人工对话可指定转交，接收方确认、退回或再次转交，附件和完整对话跟随，内部备注不向访客显示。
6. CMS 草稿不公开；Agent 候选需管理员批准；发布与回滚产生新版本。
7. 客服规则修改立即进入审计，安全硬规则不可关闭；draft/observe 模式的 AI 文本未经批准不得发给访客。
8. SEO/GEO 候选需批准和版本化；没有连接器时点击、排名和引用数据保持“待补充”。
9. 关闭额外值班后访客状态正确，开发者修改排班后全站同步。
10. 完成一次数据库恢复和对象版本恢复演练，并核对审计序列。

## 备份、回滚与故障恢复

- PostgreSQL：启用连续时间点恢复和每日加密导出；至少每季度在隔离环境恢复演练。
- 对象存储：启用版本控制和删除恢复窗口；数据库备份与对象版本记录同一切点。
- 应用回滚：保留上一镜像摘要和环境配置版本，回滚代码不能回滚数据库中的业务状态。
- CMS/SEO 回滚：通过开发者界面形成新版本，不直接覆盖历史。
- 文件模式恢复：先停止服务，把校验通过的 `operations.json` 与 `events.ndjson` 放入新目录，再修改 `OPERATIONS_DATA_DIR`；不要覆盖唯一副本。
- 短信或模型故障：保留 AI 停用和人工接管路径；不得把 mock 切到生产。

## 监控与轮换

监控 5xx、延迟、数据库连接、对象桶失败、短信失败率、模型超时、未命中、转人工、积压订单、备份年龄和审计写入失败。日志不得记录消息正文、验证码、手机号、授权头、Cookie、密码、对象键或连接串。账号离职、疑似泄漏或凭据曾出现在聊天/截图时立即轮换并审计。

## 尚需企业提供

- PostgreSQL 地址、CA/证书策略和备份保留周期。
- 私有 S3/R2/OSS/MinIO 桶、区域、受限凭据和恢复策略。
- 真实短信网关、令牌、签名、模板编号及测试手机号授权。
- 正式访客/API 域名、精确 CORS、TLS 和入口代理方式。
- DeepSeek/OpenAI 正式账户、数据保留与合规结论。
- Search Console、GA4、Bing 和 GEO 监测账号；未提供时界面继续显示“待补充”。
