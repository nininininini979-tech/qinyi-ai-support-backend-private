# AI 客服共享思想层

本目录把《转译框架》及其分析哲学表达落到勤益印刷 AI 客服。运行时实现不把所有规则塞进一个超长 system prompt，而是把合同、生成、审核、记忆和治理分开。

## 角色映射

| 角色 | 代码位置 | 运行职责 |
|---|---|---|
| A | `src/thought-layer/contract.js`、`engine.js` | 编译动态合同、冻结硬条件、编排 B/C、裁决发送或转人工 |
| B1/B2 | `src/thought-layer/prompts.js` | B1 保存不可覆盖的事实纪律；B2 只接收 allowlist 任务选项 |
| C1/C2 | `src/thought-layer/reviewer.js`、provider `review()` | 确定性硬门槛始终运行；高风险或失败时启动独立模型审核 |
| D | `src/thought-layer/governance.js` | 每周或每 100 次有效对话生成候选治理文件，等待人工批准 |
| 总库/L2 | `src/thought-layer/memory.js` | 本地 AES-GCM 加密的完整可观察事件档案 |
| 即时库/L1 | `instant-crystals.jsonl` | 脱敏、可调用、可删除的合同和结果结晶 |

## 需求—供给抽象接口化

“虚化嵌合”在实现中称为需求—供给抽象接口化：先把客户需求拆成 `confirmed`、`provisional`、`unknown`、`conflicting`、`superseded`，再把公司供给限制为已验证证据、条件性能力和人工确认事项。系统只能在两侧具有证据支持的接口点上建立连接，不能通过放松事实或制造承诺来促成匹配。

客户明确条件会成为 `confirmed`，直到客户明确修订；修订后旧值成为 `superseded`。未明确的参数保持 `unknown`，只能追问或给条件化方向。

## 运行流程

```text
A 编译合同与风险
→ 普通咨询由 B 生成
→ 确定性 C0 检查
→ 中高风险或首次失败时独立 C 审核
→ 首次失败后运行 Fresh-1、Fresh-2、Repair
→ C 匿名独立审核三个候选
→ 最多三个失败轮次
→ 自动生成结构化人工交接报告
```

Fresh 分支不接触旧稿和审核原因；Repair 只获得 A 过滤后的结构化缺陷。A 不能命令 C 放行，只能补充证据、升级合同或重新运行流程。

## 高风险范围

价格、MOQ、交期、产能、生产可行性、模具与工艺可行性、认证、合同、付款、退款赔偿、订单隐私、物流状态、法规、精确性能，以及跨语言的重要规格翻译均启动独立 C。退款、赔偿、投诉和法律事项继续由原有业务策略直接转人工。

## Provider 边界

DeepSeek、OpenAI 和 Mock 均由 `ThoughtLayerEngine` 调用。共享层负责合同、提示词、审核、返工和日志；provider 只负责模型/工具调用和返回候选。旧的 provider 直接调用仍保留兼容回退，但 `buildApp()` 默认启用共享思想层。

OpenAI 可继续使用 `file_search`；DeepSeek/Mock 继续使用本地检索。审核结果必须使用同一结构：`decision`、`score`、`issues`。

## API 扩展

`POST /api/support/chat` 保持原有 `message`、`sessionId`，新增可选的结构化 `options`：

```json
{
  "message": "We need 500 sets of a 300-piece corporate gift puzzle.",
  "options": {
    "outputLanguage": "en",
    "bilingual": false,
    "audienceLevel": "informed",
    "customerType": "organization",
    "country": "US",
    "channel": "email",
    "budgetBand": "standard",
    "urgency": "normal",
    "returningCustomer": false
  }
}
```

`options` 使用严格字段白名单，不接受 `customPrompt`，也不能覆盖 B1/C1。

## 本地记忆与隐私

记忆默认关闭。启用时配置：

```text
THOUGHT_MEMORY_ENABLED=true
THOUGHT_MEMORY_SECRET=至少32字符且与其他密钥分离
THOUGHT_MEMORY_DIR=data/runtime/thought-layer
```

`data/runtime/` 已被 Git 忽略。原始事件使用 AES-256-GCM 加密；即时结晶先做 PII 遮罩。投诉、人工接管、证据冲突和审计可以按单个会话回源；系统没有提供跨客户、批量或原始联系方式读取 API。删除会话时，同时删除该会话的总库事件和即时结晶，并保留不含正文的删除审计事件。

默认无期限归档不覆盖客户删除、授权撤回、法律要求和数据更正。

## D 的更新治理

只有启用本地记忆后才运行本地 D 计数。每 100 个唯一有效会话或七天生成一个 `governance/proposals/*.json`，状态固定为 `awaiting_human_approval`。七天条件由不阻塞回复的本地定时检查执行；候选只包含阶段指标、证据 ID 和必须执行的评测，它不会修改当前 Prompt，也不会影响正在运行的会话。

三轮审核失败会自动提交 `repeated_error`，重大投诉会自动提交 `major_complaint`。模型变化和知识库变化通过同一治理接口由部署/知识发布流程提交。生产激活仍需要人工审批、独立评测和回滚目标。

## 文件索引

- [完整转译框架](./转译框架.md)
- [分析哲学表达](./转译框架_分析哲学表达.md)
- `src/thought-layer/prompts.js`：A/B1/C1/D 的可执行提示词。
- `src/thought-layer/contract.js`：动态合同与状态迁移。
- `src/thought-layer/engine.js`：普通 B、高风险 C、三路返工和人工接管。
- `src/thought-layer/memory.js`：本地双层记忆。
- `src/thought-layer/governance.js`：D 候选治理。
