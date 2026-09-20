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
      "sha256": "7e7b0a0a7a476fc77ece48ad4216fe66f50aa32bbe4e269a5330c8704dfbcaac"
    }
  ],
  "sourceCommit": "57a12b63ff0c0ba849af0a663ac70daf706d00f7",
  "reviewedAt": "2026-09-20"
}
---
发布构建执行安装自检、配置和凭据设置验证、工作流目录一致性、许可证清单检查，以及未跳过时的 Node 测试和堆内存回归。真实模型、全新机器安装、编辑器写入、重启持久性和完整项目构建需要各自独立证据，不能由源码或协议测试推断。

构建脚本按清单复制目录，排除本机状态、凭据、依赖目录及测试输出。YHWH 项目自身 .yhwh/memory 不在安装包顶层允许清单中；工具和规则可随 payload/templates 分发。既有发布附件不要在未明确授权时覆盖。构建、部署、Git 推送和发布不是同一个动作。

Release builds run installer/configuration/credential setup checks, workflow catalog consistency, license inventory validation and, unless skipped, Node tests plus heap regression. Model access, fresh-machine installation, editor writes, reboot persistence and full-project builds need separate evidence. Packaging follows an allowlist and excludes local state, credentials, dependency trees and test outputs. This repository's .yhwh/memory is outside the package's top-level allowlist; tooling and policy travel through payload/templates. Do not overwrite existing release assets without explicit authorization. Building, deploying, Git pushing and publishing are distinct actions.
