# System One 决策模型

设置中的决策服务统一称为 **System One**。它独立于聊天模型，通过 `state + questions → answers` 执行 `noul`（是否概率）、`choice`（具名选项）和 `score`（有序档位）决策。原有 Zen / TypeSafe 配置继续可用。

| 服务 | 决策接口 | 配置方式 |
| --- | --- | --- |
| OpenCode Zen | `/zen/v1/systemone` | 保留原有免费服务默认值，也可获取当前决策模型列表 |
| TypeSafe | `/v1/systemone` | API Key；可选择其他决策模型 ID |
| OpenRouter | `/api/alpha/decisions` | API Key；模型列表按 `output_modalities=decisions` 过滤 |
| Perplexity | `/v1/decisions` | API Key；使用决策接口，而非聊天接口 |
| Fastino | `/v1/systemone` | API Key；允许覆盖默认模型 |
| Cloudflare Workers AI | `/client/v4/accounts/{accountId}/ai/run/@cf/cloudflare/{model}` | 完整 URL 与 Token；支持 `result.answers` 响应包络 |
| 自定义 / 本地兼容服务 | 用户填写的完整 URL | 可选模型 ID 和 Bearer Key；例如 Laya、DecisionLex 或其他兼容服务 |

模型列表可使用服务商默认地址或自定义 URL。支持 OpenAI 风格的 `data: [{id}]` 和 System One 风格的 `models: [{name}]`；只发送 GET，不执行推理。不存在列表接口时可手动输入 ID。跨域的列表请求不会携带推理密钥。切换服务商会清空旧密钥、地址和模型，避免把旧凭据发送到新服务商。

JSON 上下文完整传入，不静默截断。服务必须返回带类型的答案。无效概率、不属于候选的选项、超出档位的分数、缺少置信度、HTTP 错误或超时均触发现有本地/聊天回退。不会用最高选项概率伪造 `confidence`；不同模型的置信度定义可能不同，应分别评估阈值。

仅支持部分类型的模型可关闭另外的能力开关；不会发送被关闭类型的请求。自定义服务须实现兼容协议，普通聊天 API、裸权重或私有协议需先提供兼容服务。这里不声称所有模型权重可直接运行。

缓存按服务商、完整接口、模型、凭据和 JSON 上下文隔离。每日上限在发送前占用调用名额，包括失败请求，避免并发和反复失败绕过上限。命中缓存、获取模型列表和能力不支持的本地回退不增加调用次数。

协议来源：[TypeSafe](https://docs.typesafe.ai/concepts/system-one)、[OpenRouter 决策接口](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)、[OpenRouter 模型过滤](https://openrouter.ai/docs/guides/overview/models)、[Perplexity](https://docs.perplexity.ai/docs/decisions/quickstart)、[Cloudflare](https://developers.cloudflare.com/workers-ai/models/clef/)、[Fastino](https://fastino.ai/)、[Laya](https://github.com/NandhaKishorM/laya)。

验证使用本地响应与真实渲染器/IPC 的 GET 模型列表请求，不使用用户的付费密钥执行推理。
