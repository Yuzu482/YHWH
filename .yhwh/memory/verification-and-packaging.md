---
{
  "schemaVersion": 1,
  "id": "verification-and-packaging",
  "kind": "verification",
  "status": "accepted",
  "title": "验证与发布证据范围 / Verification and release evidence scope",
  "tags": [
    "测试",
    "安装",
    "发布",
    "test",
    "release"
  ],
  "sources": [
    {
      "path": "Build-Release.ps1",
      "sha256": "a1f850ffa3c5a2ee9b794c1bb1e2cb297555ac9829b97ef96e5deb578f7b8cfd"
    }
  ],
  "sourceCommit": "b914f228dfc1726d337e7cbe8dca0be08eac9e25",
  "reviewedAt": "2026-10-04"
}
---
发布构建调用安装、宿主规则同步、配置与凭据设置、无头 CLI 隔离复制与漂移、工作流目录、版本及许可证验证；未设置 SkipTests 时执行 Node 测试和堆内存回归。真实模型、全新机器安装、编辑器写入、重启持久性和完整项目构建均需要各自的实测证据，不能由源码或协议测试推断。

打包从 Git 索引枚举已跟踪路径，再应用顶层允许清单及本机状态、凭据、依赖目录和测试输出排除规则；拒绝符号链接或 junction。未跟踪的新增实现不会自动进入发布包。YHWH 自身 .yhwh/memory 不在顶层允许清单内，工具和规则可随 payload/templates 分发。sourceCommit 记录 HEAD；脏工作文件指纹或本地升级成功均不能证明远端发布包包含同样内容。

Release builds invoke installer, host policy synchronization, configuration/credential setup, isolated headless copy/drift, workflow catalog, version and licensing checks. Node tests and heap regression run unless SkipTests is selected. Model access, fresh-machine installation, editor writes, reboot persistence and complete project builds each require independent observed evidence.

Packaging enumerates Git-index tracked paths, applies the top-level allowlist and local-state/credential/dependency/test-output exclusions, and rejects symlinks or junctions. Untracked implementation files are not automatically packaged. Project .yhwh/memory is outside the top-level allowlist; tooling and rules travel through payload/templates. Dirty-file fingerprints and a local upgrade do not prove equivalent remote release content. Building, deploying, Git pushing and publishing are separate authorized actions; existing release assets are not overwritten without authorization.
