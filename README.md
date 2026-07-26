# 勤益印刷 AI 客服

这是一个可落地运行的知识库客服起步项目，提供 Web 对话页、知识库检索、订单查询工具、人工转接策略、会话隔离和三种模型提供方。当前本机选择的是 **DeepSeek**；`.env.example` 仍以无需密钥的 `mock` 作为新环境默认值。

项目现已加入 provider 无关的 A/B/C/D Agent 公司骨架：四个岗位拥有独立身份、上下文和 API 窗口，只能通过受控信封通信；公司准入层禁止发布 C 未通过的产品。A 编译合同并裁决，B 生成，C 独立审核，D 形成待人工批准的阶段提案。完整设计见 [`docs/thought-layer/AGENT_COMPANY.md`](docs/thought-layer/AGENT_COMPANY.md) 和 [`docs/thought-layer/IMPLEMENTATION.md`](docs/thought-layer/IMPLEMENTATION.md)。

> 本项目当前是开发/验收版本。订单、人工工单均为演示适配器，不能直接承担真实业务。

## 架构与数据流

```text
浏览器 public/
    -> Fastify API (src/app.js)
        -> SupportService: 输入校验、业务边界、连续未命中转人工
            -> mock: 本地检索 + 固定逻辑
            -> deepseek: 本地检索 -> 仅发送命中片段 -> DeepSeek Chat Completions
            -> openai: OpenAI Responses API -> 托管 file_search
        -> SessionStore: 开发用内存 / 生产可用 Redis
        -> adapters/: 演示订单、演示人工工单

knowledge/curated/ --审核/清理--> knowledge/prepared/ --本地读取或上传--> 模型提供方
```

主要目录：

- `public/`：无构建步骤的客服 Web 页面。
- `src/providers/`：`mock`、DeepSeek、OpenAI 实现。
- `src/retrieval/`：DeepSeek/mock 使用的本地关键词检索。
- `src/support/`：客服回答边界、转人工策略和会话流程。
- `src/thought-layer/`：动态合同、需求—供给接口化、共享提示词、独立审核、三路返工、双层记忆和 D 治理。
- `src/agent-company/`：A/B/C/D 独立岗位、四个 API 窗口、通信信封、证据工具和公司准入层。
- `src/control-plane/`：为非技术经营者操作界面预留的运行模式与部门状态控制面。
- `src/adapters/`：订单与人工工单的演示实现。
- `knowledge/curated/`：人工筛选、可追溯的发布源。
- `knowledge/prepared/`：校验后生成的运行副本，已被 Git 忽略。
- `service-playbook/`：从真实客服对话中脱敏蒸馏的回复结构、自主权限和训练样例，不进入事实知识库。
- `docs/thought-layer/`：完整转译框架、分析哲学表达和本项目接入规范。
- `scripts/`：知识校验准备及 OpenAI Vector Store 上传。
- `test/`：基于 Node Test Runner 的单元和接口测试。

## 快速启动

要求 Node.js 22 或更高版本。

```bash
npm ci
cp .env.example .env
npm run kb:prepare
npm run dev
```

浏览器打开 `http://127.0.0.1:3000`。`npm run dev` 会监听源码变更；正式进程使用 `npm start`。

对话框默认采用普通咨询：后端目标在 40 秒内结束整条 A/B/C 流程，浏览器最迟等待 45 秒；时间不足时 B 会缩短答复，若仍无法完成必要核验，则返回简短且不作未经审核承诺的说明。聊天框旁的“专业咨询”开关适用于需要更多分析的提问，建议答复 200-600 字、硬上限 800 字，后端默认总预算 55 秒。浏览器会从服务端读取当前预算，并在后端截止后保留很短的网络返回余量。专业咨询只改变篇幅和时间预算，不改变价格、MOQ、交期、产能、可行性、认证、合同、付款、隐私、物流、法规及精确规格翻译等硬门槛，也不会绕过 C 或公司准入层。

等待期间页面展示基于已等待时间和当前处理阶段的进度条，最大停在 92%，直至收到结果；它不是模型内部精确完成百分比。时限可在开发环境中通过 `THOUGHT_NORMAL_DEADLINE_MS`（30-44 秒）和 `THOUGHT_PROFESSIONAL_DEADLINE_MS`（45-55 秒）调整，以适配当前 Vercel 60 秒函数上限。

## GitHub Pages 与 Vercel 后端

完整公网版本采用两个仓库，避免把知识库和客服手册公开：

- 公开 Pages 仓库仅放 `public/` 中的静态前端。
- 私有后端仓库放本项目其余源码，并通过 `vercel.json` 部署 Vercel Functions。

Pages 仓库的 `config.js` 只配置公开的 HTTPS 后端地址，例如：

```js
window.__QINYI_SUPPORT_CONFIG__ = {
  apiBaseUrl: "https://qinyi-ai-support-api.vercel.app"
};
```

DeepSeek 密钥和 `USER_HASH_SECRET` 只能设置为 Vercel 环境变量。公开部署使用 `AUTH_MODE=public` 和 `SESSION_BACKEND=stateless`：浏览器生成匿名访客 ID，后端以 AES-GCM 加密会话令牌维持连续对话，不依赖单个无服务器实例。订单查询、演示订单和假工单会被关闭。正式生产的用户账户、订单与人工工单仍需接入可信登录网关和真实业务系统。

首次验收建议先保持：

```dotenv
SUPPORT_PROVIDER=mock
AUTH_MODE=demo
SESSION_BACKEND=memory
```

`mock` 不调用外部模型、不需要 API 密钥，但会读取与 DeepSeek 相同的 `knowledge/prepared/`。

## DeepSeek：当前接入方式

当前本机的非敏感配置选择 `SUPPORT_PROVIDER=deepseek`，API 基址为 `https://api.deepseek.com`，模型名由 `DEEPSEEK_MODEL` 配置。密钥只应保存在已被 Git 忽略的 `.env` 或生产密钥管理系统中，不要写入代码、README、工单或聊天记录。

最小配置：

```dotenv
SUPPORT_PROVIDER=deepseek
DEEPSEEK_API_KEY=在本机或密钥管理系统中设置
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

然后执行：

```bash
npm run kb:prepare
npm start
```

DeepSeek 当前没有使用 OpenAI `file_search`。服务端先在本机读取 `knowledge/prepared/`，按问题最多匹配 5 个审核后章节，每个片段清理后最多 1,400 字符。介绍、推荐、选型、礼品方案等产品咨询意图会主动补充产品目录、尺寸、材质工艺和报价信息清单。**只有命中或产品咨询所需的精选片段**会与用户问题、必要的最近对话和工具结果一起发送给 DeepSeek；整个知识库、原始 Obsidian Vault、未使用文件不会上传。

没有可靠匹配且问题不含演示订单号时，服务直接返回“知识库没有足够依据”，不会让模型凭自身知识猜测。DeepSeek 返回的引用名称也来自本地匹配结果，而不是模型生成。

运行时会读取 `service-playbook/permissions/autonomy-policy.json`，并按当前问题从脱敏 JSONL 中选择最多一个回复结构范例。AI 可以主动介绍产品、给出一个主方案和最多一个备选、解释取舍并追问最少必要字段；范例不是事实来源，具体规格仍必须同时命中本轮知识片段。DeepSeek 输出还会经过发送前检查，超长或含无依据的完成时长、年龄表现、金额、生产可行性时会被要求压缩重写。该目录不保存原始聊天记录、客户身份、联系方式或即时成交价，也不会被 `kb:prepare` 发布到事实知识库。

## OpenAI：可选接入

OpenAI 路径使用 Responses API 和托管 `file_search`。先准备并上传精选知识库：

```bash
npm run kb:prepare
npm run kb:upload
```

上传命令要求环境中已有 `OPENAI_API_KEY`。它会创建一个 30 天未使用后过期的 Vector Store，等待所有文件完成索引，并在终端输出 `vectorStoreId`。将该 ID 写入本机环境：

```dotenv
SUPPORT_PROVIDER=openai
OPENAI_API_KEY=在本机或密钥管理系统中设置
OPENAI_VECTOR_STORE_ID=上传命令返回的 ID
OPENAI_MODEL=gpt-5.6-luna
OPENAI_STORE=false
OPENAI_REASONING_EFFORT=low
```

重启服务后生效。此模式会把查询交给 OpenAI `file_search`，最多取 5 条结果，并展示 API 返回的文件引用。`OPENAI_STORE=false` 是隐私优先默认值；如改为 `true`，应先完成数据保留、访问权限和供应商合规评审。Vector Store 到期或知识更新后需要重新上传、更新 ID 并重启。

## 知识库维护

当前 `knowledge/curated/` 按公司与联系信息、产品目录、拼图尺寸、材质工艺包装、起订/样品/交期/物流、质量认证六类整理。每条资料的实际来源和页码以 Markdown 文件的 frontmatter 为准。

Obsidian Vault 不会被服务直接读取。`.env.example` 中的 `OBSIDIAN_SOURCE_DIR`、`KB_INCLUDE_DIRS` 和 `KB_EXCLUDE_PATTERN` 是后续导入工作的范围提示，当前脚本没有自动扫描 Vault。这是刻意的发布边界，避免客户咨询、询盘分析、销售记录和个人隐私被整库发送给模型。

更新流程：

1. 从 Obsidian 或原始文档中只摘录已获准对客使用的事实，写入 `knowledge/curated/*.md`。
2. 删除客户身份、询盘记录、成交信息、内部销售话术、个人隐私和无授权内容。
3. 保留 YAML frontmatter，至少包含 `category`、`source`、`reviewed_date`、`approval_status`；建议同时记录 `source_pages`、`version`、产品和地区。
4. 由业务负责人核对价格、MOQ、交期、付款、认证有效期、联系方式等时效性信息。
5. 重新发布（脚本会先清空旧的 `knowledge/prepared/`，避免已撤回条目残留）：

```bash
npm run kb:prepare
npm test
```

6. DeepSeek/mock 会在请求时重新读取本地文件；OpenAI 还需执行 `npm run kb:upload`、更新 `OPENAI_VECTOR_STORE_ID` 并重启。

`kb:prepare` 会拒绝缺少必要元数据、文件名包含敏感类别或正文含部分客户分析特征的文件，但它不是完整的隐私扫描器，也不会按 `approval_status` 自动过滤。所有出现在 `knowledge/prepared/` 的文件都会参与本地检索或 OpenAI 上传，因此发布前必须人工审核；`needs_business_confirmation`、`needs_certificate_validation` 等状态不得被误当作最终业务批准。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/` | 客服 Web 页面 |
| `GET` | `/health/live` | 进程存活检查 |
| `GET` | `/health/ready` | 提供方与会话后端状态 |
| `GET` | `/api/support/status` | 前端展示 AI 开关、提供方、模型和会话后端 |
| `POST` | `/api/support/chat` | 新建或继续会话 |
| `DELETE` | `/api/support/sessions/:sessionId` | 删除当前身份所属会话 |
| `POST` | `/api/support/sessions/:sessionId/handoff` | 主动请求人工工单 |
| `POST` | `/api/support/feedback` | 记录赞/踩；演示版仅存聚合字段 |

开发模式可直接请求：

```bash
curl -s http://127.0.0.1:3000/api/support/chat \
  -H 'Content-Type: application/json' \
  -H 'X-Demo-User-Id: demo-user-1' \
  -H 'X-Tenant-Id: demo-tenant' \
  -d '{"message":"你们有哪些产品？"}'
```

响应核心字段为 `sessionId`、`action`、`answer`、`citations` 和 `requestId`；转人工时另有 `ticketId`。继续对话时在请求体加入服务器返回的 UUID：

```json
{
  "sessionId": "服务器返回的 UUID",
  "message": "拼图有哪些尺寸？"
}
```

`AUTH_MODE=demo` 使用 `X-Demo-User-Id` 和 `X-Tenant-Id`；`AUTH_MODE=trusted-header` 要求受信任网关写入 `X-User-Id` 与 `X-Tenant-Id`。CORS 白名单不是身份认证。

## 演示行为

- “你们有哪些产品？”、“拼图有哪些尺寸？”会从精选知识库返回答案和引用。
- `demo-user-1` 查询 `ORD-10292` 会命中演示订单；其他用户或租户只能得到“未找到或无权查看”。
- “我要人工客服”、退款、赔偿、发票、投诉、法律纠纷等请求直接转人工。
- 连续三次没有可靠知识命中会自动转人工。
- `AI_SERVICE_ENABLED=false` 是停用 AI 的开关，所有消息改走人工工单流程。
- 人工工单 ID 以 `DEMO-` 开头，只保存在当前进程内存，**不会通知任何真实客服**。
- 内存会话和演示工单会在进程重启后消失；反馈理由正文也不会持久化。

## 安全边界

- 请求体最大 16 KiB，单条消息默认最多 2,000 字；接口带频率限制和请求超时。
- 日志会遮蔽授权头、Cookie、用户消息和反馈理由，错误响应包含可追踪的 `requestId`。
- 会话键绑定租户、用户和会话 UUID；订单查询也把租户与用户所有权放在同一查询条件中。
- 用户标识发送给模型前会使用 HMAC 生成不可逆匿名值；OpenAI 将其放入 `safety_identifier`，DeepSeek 兼容接口将其放入 `user` 字段。生产环境的 `USER_HASH_SECRET` 必须至少 32 字符。
- 退款审批、赔偿、投诉、法律事项等受限业务只能转人工；AI 不应承诺价格、交期、合同和认证范围。
- 产品经理模式不会获得任意文件、网页、订单写入或对外发消息权限；自主范围只限于已审核知识内的介绍、推荐、比较、追问和交接摘要。
- 本地 PII 遮蔽函数已有测试，但当前聊天主流程不会自动改写用户输入；前端提示不能替代数据最小化和供应商合规控制。
- DeepSeek 仍会收到用户问题、近期对话和命中的精选片段；不要把秘密、验证码、银行卡信息或未获授权的个人数据交给在线模型。

## 生产上线清单

- 将任何曾出现在聊天、日志、截图或代码中的 API 密钥立即吊销并重新生成；使用密钥管理系统注入，不提交 `.env`。
- 设置 `NODE_ENV=production`、`AUTH_MODE=trusted-header`、`SESSION_BACKEND=redis` 和至少 32 字符的随机 `USER_HASH_SECRET`；配置精确的 `ALLOWED_ORIGINS`。
- 在身份网关处验证用户，删除客户端自带的身份头后重新写入可信 `X-User-Id`/`X-Tenant-Id`，并启用 TLS。不要把应用直接暴露到公网。
- 将 `DemoHandoffAdapter` 换成经过审核、带幂等和脱敏摘要的真实工单系统；将演示订单数组换成按租户和用户授权查询的只读订单服务。
- 使用有认证、加密、备份和高可用能力的生产 Redis。`docker-compose.yml` 的 Redis 关闭持久化且暴露本机端口，只适合开发。
- 在网关或共享存储中实现多实例统一限流；当前进程内限流不能独立承担横向扩容场景。
- 完成 DeepSeek/OpenAI 的数据地区、保留期限、训练使用、删除机制和供应商协议评审；限制网络出口。
- 为知识条目指定负责人、复核周期和撤回流程；上线前处理所有待业务确认/待证书验证资料。
- 接入受控日志、指标和告警，监控 5xx、超时、未命中率、转人工率、Redis 健康及 Vector Store 到期时间，不记录消息原文。
- 做鉴权绕过、跨租户、提示注入、敏感数据、并发、限流、超时和供应商故障演练；保留 `AI_SERVICE_ENABLED=false` 的应急开关。

## 测试与检查

```bash
npm test
npm run check
```

现有测试覆盖接口建会话与转人工、消息长度、跨用户会话隔离、本地知识命中/拒绝猜测、订单所有权、动态范例选择、套/片单位隔离、发送前事实检查、纯文本清理、策略分类、PII 遮蔽、HMAC 标识和内存会话隔离。测试默认使用 `mock` 或本地替身，不会消耗模型额度。

真实 DeepSeek/OpenAI 调用、Vector Store 上传、Redis 集成和真实工单/订单适配器尚未包含在自动测试中，上线前应在隔离的预发布环境补齐。`npm run eval` 提供 4 条本地知识库冒烟评测，不调用外部模型；正式上线前应扩展为由业务负责人确认的 50-200 条金标测试集。
