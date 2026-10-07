# WorkerRuntime 第一阶段来源与验收边界

第一阶段不是一次成功的 Chesed 交付。唯一派发 `worker-runtime-phase1-20261008-normalizer-1` 的角色为 Chesed、模型为 OpenAI Luna；结果失败，存在三次未恢复的工具错误。进程退出 0 和清理成功不能覆盖交付失败。

| 文件（相对 scripts/worker-runtime/） | 作者来源 |
| --- | --- |
| types.mjs | 失败的 normalizer-1 提供初稿；主代理在宿主维护通道修正、验收，最终责任为 host-maintenance |
| pi/normalize.mjs | 失败的 normalizer-1 提供初稿；主代理在宿主维护通道修正兼容性、限额和生命周期，最终责任为 host-maintenance |
| pi/args.mjs | 主代理 host-maintenance，抽取原 dispatch 的参数构建并修正共享 safeFlags |
| pi/index.mjs | 主代理 host-maintenance，复用既有 WSL 调用，不新增沙箱/凭据逻辑 |
| claude-code-cli/index.mjs | 主代理 host-maintenance，复用既有无工具 CLI 审查器和终态投影 |
| index.mjs | 主代理 host-maintenance，固定注册表和可信宿主注入接缝 |
| summarize.mjs | 主代理 host-maintenance，迁移旧摘要行为到归一化事件 |

授权来自同一 chat 中用户的“可以在这个工作区启用”及“可以进行第一阶段的执行”。工作区 AGENTS.md 指向已批准的 `.yhwh/workflow-maintenance.md` v2；本机 `workspace-enable-record.json` 明确 `primaryHostImplementationAllowedForThisScope=true`。该例外仅适用本工作区的 YHWH 自身维护，不是普通项目或全局 primary-direct 授权。所有宿主修正、测试和整合记录为 host-maintenance，没有伪造 Chesed 成功、宿主验证记录或任务接受事件。

原始证据位于本机 `C:/Users/asus/.local/state/pi-kether/workflow-self-maintenance-20261007/worker-runtime-phase1-20261008/`：`normalizer-task.json`、`normalizer-worker-failed-result.json`、`worker-candidate-import.json`、`scope.json`。失败补丁哈希为 `ea5576736ae5701323865d61a66394c1f88e74a11c4dffcaabf8d1b67b52fbb0`；脱敏失败结果哈希为 `b84c100b0c50bda08a13de81baf43e0f7ca0db3fadf5b191c6c4e88748c96fc0`。

原黄金样本不是从 b285036 生成。它从修改前本地源码/已安装快照生成；源码名义 HEAD 为 `8f16c51f533b4e77ba7309f0d73c67655a4170b6`，快照含此前未提交维护修改，HEAD 不能代表全部字节。样本由合成边界输入产生，不是真实模型日志。原 baseline.json SHA-256 为 `9174a4dcc6a8522fc2fe77f8a599b366aac3d1e4281398e4e0eb37b8c93d4429`，cases.mjs 为 `4833a712cee4f071c7c9480f51dc472d4da6c1f5b6dc06d54b8982d3190eccd2`。b285036 对照将在补充验收中独立生成，并保留差异，不能倒签原样本来源。

补充验收已在干净工作树 `b285036f0957c55dc6cb534f978f62f1d932a551` 独立执行同样的合成输入。27 个参数、35 个摘要和 5 个时间线样本与原样本无差异。重新生成的完整证据 JSON SHA-256 为 `df9ae9fb58c547a544287d1780fd849f42a87d8f0e6d349ff61a17dbff95ec38`；生成时提交、时间和每个脚本/扩展的工作文件及 Git blob 哈希保存在 `completion-20261008/b285036-golden-provenance.json`。这是改代码后的补充对照，不是原始生成时间的证明。

旧部署只复制增量代码，未重生成插件版本清单；源码安装/宿主规则同步又复制静态版本。原构建 dirty 判断排除了未跟踪文件。补充修复共享 Git/打包来源计算，源码安装和规则同步写入实际 HEAD 的十二位短哈希；任何未忽略的 tracked 或 untracked 修改均带 `.dirty`。无 Git 的安装包使用一致性校验后的 build-provenance.json，缺失或不一致则拒绝。提交号加 dirty 仅是来源标识；实际字节仍以部署清单哈希为准。

本次提交包含部署已保留的 dispatch `outputLimitObservation` 透传（一处既有维护改动），作为当前部署基线的必要依赖明确记录；其余无关未提交文件保留，不整体暂存。提交、部署、真实写入链路和最终独立审查分别记录，先前接口/探针通过不能替代第一阶段完整验收。第二阶段的沙箱启动脚本与凭据准备保持暂停。
