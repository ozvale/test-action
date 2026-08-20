# AGENTS.md

面向 AI 编码助手与开发者的项目协作指南。行为准则（最小改动、先想后写、目标驱动）见 [CLAUDE.md](./CLAUDE.md)，本文件补充项目特定的技术约束与约定。

## 项目概述

`@openlibing/huaweicloud-oidc-client`：openlibing 平台对接华为云的 SDK（npm 包），提供基于 OIDC 免 AK/SK 的认证与调用能力。核心链路：

```
GitHub Actions OIDC ID Token -> 华为云 STS AssumeAgencyWithOIDC 换临时凭证
  -> OBS 上传 / APIG 调用（V11-HMAC-SHA256 签名 + X-Security-Token）
```

仓库同时包含一个本地自定义 Action（`.github/actions/demo-action`）作为 SDK 使用示例，以及发布流水线。

## 目录结构

```
├── src/                      # SDK 源码（npm 包主体，可引入第三方依赖）
│   ├── index.js              # 包入口：导出 getCredentials / configure / V11Signer / sendRequest
│   ├── config.js             # 内置 openlibing 配置 + configure() 覆盖（模块级单例 cfg）
│   ├── logger.js             # 调试日志（debug 开关）+ 敏感字段脱敏工具
│   ├── http.js               # sendRequest 请求工具（基于 Node 内置 fetch，调试模式打印请求/响应详情）
│   ├── oidc.js               # GitHub OIDC ID Token 申请（环境变量覆盖 / Actions 自申请）
│   ├── credentials.js        # getCredentials：OIDC -> STS 换证（缓存 / force / 并发去重）
│   └── signer-v11.js         # V11Signer：APIG V11-HMAC-SHA256 签名器
├── test/
│   └── openlibing-client.test.js   # SDK 测试（12 个场景）
├── .github/
│   ├── actions/demo-action/  # 自定义 Action 插件（SDK 使用示例）
│   │   ├── action.yml
│   │   ├── index.js          # 上传 file-path 指定文件到 OBS + 调用 APIG
│   │   ├── test/             # demo-action 测试
│   │   ├── README.md
│   │   └── dist/             # ncc 编译产物（内联 SDK 包与 esdk-obs-nodejs）
│   └── workflows/
│       ├── demo-action-workflow.yml  # 演示 workflow
│       └── deploy.yml                # npm 发布流水线
├── package.json              # @openlibing/huaweicloud-oidc-client npm 包定义
├── README.md
└── docs/superpowers/specs/   # 设计文档
```

## 常用命令

| 命令 | 位置 | 说明 |
| --- | --- | --- |
| `npm test` | 根目录 | 运行 SDK 测试（12 个场景） |
| `npm run build` | 根目录 | `npm pack`，产出 `openlibing-huaweicloud-oidc-client-x.y.z.tgz`（仅打包 src/） |
| `npm install` | `.github/actions/demo-action` | 安装 file: tarball 依赖 |
| `npm test` | `.github/actions/demo-action` | 运行 demo-action 测试 |
| `npm run build` | `.github/actions/demo-action` | ncc 编译，内联 SDK 包与 esdk-obs-nodejs 进 dist/ |

## 硬性约束

- **SDK 依赖策略**：HTTP 层使用 Node 内置 fetch（Node 18+），零第三方运行时依赖；`engines.node` 为 `>=18`。原「零第三方依赖」是单文件 bundle 场景的历史要求，现已放开，可按需引入成熟第三方库来简化实现。
- **demo-action 引构建后的单个包**：不得 `require('../../../src')` 直连源码；通过 `file:` 依赖安装根目录 `npm pack` 产物，代码 `require('@openlibing/huaweicloud-oidc-client')`。SDK 版本升级需重新 pack 并同步 `file:` 路径中的版本号。
- **ncc 内联**：demo-action 的 `dist/` 必须提交，CI runner 不执行 `npm install`；dist 内不得残留对 `src/` 的相对路径运行时依赖。
- **OIDC 免密**：凭证全部来自 GitHub OIDC -> 华为云 STS 临时凭证，禁止配置永久 AK/SK。
- **V11 签名**：APIG 调用使用 V11-HMAC-SHA256（HKDF-SHA256 派生密钥，credential scope 为 `YYYYMMDD/{region}/apic`），必须携带 `X-Security-Token` 头。
- **调试模式**：SDK 通过 `configure({ debug: true })` 开启，默认关闭（完全静默）；日志须对 Authorization、X-Security-Token、id_token、临时 AK/SK/SecurityToken 等敏感字段脱敏。

## 代码约定

- 全部使用 async/await，禁止回调风格。
- 修改 src 时保持模块依赖方向：`config <- logger <- http <- oidc <- credentials`，`signer-v11` 仅依赖 `crypto`，不得引入循环依赖。
- 删除未用代码（含 import）而非注释保留。
- 不向工程/工具配置文件写入 AI 过程相关文本（时间戳、自动生成标记等）。

## 发布流程

1. `npm version patch|minor|major` 升版本号并提交。
2. 打对应 tag（`v*` 或数字开头）或手动触发 `deploy.yml`。
3. 流水线执行 `npm pack --dry-run` 校验、`npm test`、`npm whoami`、`npm publish --access public`。
4. 发布依赖仓库 secret `NPM_TOKEN`（npm Automation 类型 token），且 npm 账号需拥有 `openlibing` 组织。

## 平台支持现状

- **GitHub Actions**：完整支持 OIDC 免密（`ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN`）。
- **GitCode/AtomGit**：平台不签发 OIDC ID token（无 `id-token` 权限、无 OIDC 环境变量），SDK 暂无法对其免密；如需支持需先实现平台适配层。
