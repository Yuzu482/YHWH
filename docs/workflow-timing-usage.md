# 工作流计时、usage 与结果复用

本轮作者为 host-maintenance；基准、授权、逐文件指纹及审查证据保存在本机 telemetry-handoff-20261012 证据目录。尚未部署。

`phaseTimings.toolTiming` 与旧 `stream` 并列。唯一 tool call ID 配对，最多保留 128 个调用、32 个工具名；工具名只接受字母、数字及 `_.:-`，其他名称归入 other，不记录参数、路径或思考正文。重复、缺失、倒序、未结束或超出容量的事件使派生耗时不可用。sumMs 是各调用耗时之和，wallMs 是区间并集。nonToolGenerationMs 只是 generation 区间扣除工具并集的剩余时间，仍含网络、等待和 provider 开销，不能称作纯模型耗时。无工具事件时不捏造工具耗时。

审查器记录 help、auth status、正式 CLI、解析、清理、总耗时。firstOutputMs 是宿主看到首个 stdout JSON 块的时刻，不能解释为首 token。providerReported 是 provider 自报的时长，不能与宿主时钟相减。缺失阶段为 null；时钟反向时本阶段为 null。原认证、命令、Job Object、超时和模型启动标记保持原顺序。

usage.execution 汇总本次执行中 sourceType=message_end 的 assistant 完成消息，排除 delta 和 agent_end 中的消息列表。相同计数的不同消息均计入，不按内容去重。Pi input / Claude input_tokens 表示原生报告的非缓存输入，缓存读写分别报告；它们是 provider 报告的消耗，不能解释为唯一上下文长度。reasoning 是 output 的子集，不重复相加。显式 total 优先；无显式 total 时四项输入、输出、缓存读、缓存写必须全部已知，否则总量 null。expectedMessages / observedMessages / complete 说明覆盖。多消息不再沿用“仅最后一条消息”的计数；单消息原字段保留，新增 execution 元数据。旧无 scope 审计格式保留已知分量求和的历史含义，不追写历史记录。成本不可证明时不可用，不宣称节省。

宿主先 fetchCompleteResult，再把同一 receipt 传入 collectHostCandidate / fetchHostCandidate，可省去第二次完整读取。receipt 绑定模块内 WeakMap、requestId、专属于一个网关的 reader 函数、完整 UTF-8 SHA、页数及 90 秒单调时钟 TTL。reader 不得复用为多个网关的路由器。clock 注入仅用于可信宿主测试，不来自任务包或工具参数。克隆、伪造、漂移、过期、不同 reader 一律拒绝，无隐藏回退、模型重放或自动接受。使用时重新验 digest、复制结果，再读取当前 handoff；补丁/证据变化仍使材料准备缓存失效。原 UTF-16 分页、4 MiB/128 页限制不变。

真实对照驱动分别记录首轮读取、当前 handoff、应用、宿主检查、记录、首次材料准备、重复准备缓存命中、审查派发及等待。跨进程不一致的时戳只标不可计算，不填零；确定性耗时不能替代模型执行，也不能把主代理接管间隔视作模型耗时。所有接受仍需显式 apply_artifact、真实宿主检查、record_host_verification、必要独立审查及 task_accepted。

兼容边界：无工具事件时仍省略 toolTiming；共享纯 normalizeUsage 放在原本已随 root 补丁验证器部署的 audit-log 模块中，runtime-usage 复用同一函数，不给 root 路径新增文件依赖。
