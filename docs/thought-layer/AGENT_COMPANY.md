# ABCD Agent 公司骨架

当前本地版本将 ABCD 实现为四个独立 Agent 实例，而不是一个模型依次切换角色。它们可以运行在同一个 Node.js 进程，但拥有不同的身份、岗位章程版本、API 窗口、上下文构造和允许通信路线。

## 公司层与岗位层

`CompanyPolicyEngine` 是公司宪法的强制执行层，不是第五个 Agent。它不替 B 生成、不替 C 审核，也不替 A 选择经营方向；它只验证通信权限和产品准入。即使 A 的外部 API 返回错误裁决，未通过 C 的候选也不能发布。

| 部门 | 运行身份 | 输入 | 输出 |
|---|---|---|---|
| A | `agent-a` | 客户任务、合同、B 候选、C 审核、D 提案 | 工作单、发布/返工/转人工裁决 |
| B | `agent-b` | A 工作单、B1/B2、合同、允许证据 | 候选产品与证据映射 |
| C | `agent-c` | A 发出的匿名候选、合同、证据、C1/C2 | 通过/失败/升级及结构化原因 |
| D | `agent-d` | A 发出的脱敏阶段快照 | 阶段总结、方向和候选改良 |

B 的生成提示不包含 A 的治理提示。C 收到的候选不含 B 的分支、运行身份和工作说明。D 不读取正在运行的会话。所有返回结果必须回到 A；B 与 C 不能直接通信。

## 固定通信路线

```text
A -> B  work_order
B -> A  candidate
A -> C  review_request
C -> A  review_result
A -> D  stage_snapshot
D -> A  stage_proposal
```

`InProcessAgentBus` 会拒绝未列出的路线。未来把 Agent 迁移成独立 worker 或远程服务时，信封协议保持不变。

## 四个 API 窗口

每个 Agent 有独立配置：

```text
AGENT_A_PROVIDER / API_KEY / BASE_URL / MODEL / CHARTER_VERSION
AGENT_B_PROVIDER / API_KEY / BASE_URL / MODEL / CHARTER_VERSION
AGENT_C_PROVIDER / API_KEY / BASE_URL / MODEL / CHARTER_VERSION
AGENT_D_PROVIDER / API_KEY / BASE_URL / MODEL / CHARTER_VERSION
```

当前默认值：

| Agent | 默认窗口 | 本地行为 |
|---|---|---|
| A | `mock` | 使用确定性安全裁决；不能发布 C 未通过候选 |
| B | `inherit` | 使用现有客服 provider 的独立 B 实例和知识/订单工具 |
| C | `inherit` | 使用与 B 分开的 provider 实例进行独立审核 |
| D | `mock` | 生成保守的阶段分析骨架和待人工审批提案 |

提供四个 API 后，将对应窗口改为 `openai-compatible` 并填写各自的 key、base URL 和 model。窗口工厂是唯一需要按实际 API 协议扩展的边界；合同、通信、记忆、审核和经营控制不随模型提供方改变。

远程 B 使用本地受控证据工具取得知识片段；订单查询先在服务端执行租户和用户归属校验，只把成功查询的最小结果作为证据交给 B。远程 C 使用自己的证据构造过程，不继承 B 的模型上下文。

## 经营者控制面

`OperatorControlPlane` 已预留 `observe`、`draft`、`auto`、`paused` 四种模式和四部门状态视图。除 `auto` 外，当前均停止自动客户回复并转人工，避免在审批队列 UI 尚未完成前误发草稿。

当前没有公开管理路由。后续操作界面必须先增加独立经营者认证和权限，再接入暂停、接管、D 提案审批、规则发布和回滚。不得复用客户聊天身份作为管理权限。

## 不可变边界

- 公司准入层不能通过配置关闭。
- A 不生成客户正文，也不能强令 C 通过。
- B/C/D 的岗位输出保留原样；公司层只决定其产品是否可进入下一环节或发布。
- C 的审核请求不得携带 B 的内部身份、分支和工作日志。
- D 的提案永远是 `awaiting_human_approval`，不能直接更新生产岗位。
- Agent API 密钥不得写入知识库、合同、日志、前端或 Git。
