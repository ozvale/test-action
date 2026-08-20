# openlibing-client SDK 与 demo-action 项目重构设计

日期：2026-08-20

## 背景与目标

当前仓库包含共享薄库（`shared/huaweicloud-openlibing-client.js` + `shared/signer-v11.js`）与两个独立插件（`deploy-action` 调用 APIG、`obs-upload-action` 上传 OBS），以及临时调试残留（`inspect-oidc-action`）。目标（用户多轮确认后收敛）：

- 将仓库重构为「**openlibing-client SDK + example**」项目：`sdk/` 提供通用基础能力，一个 `demo-action` 作为使用 SDK 的完整示例。
- SDK 只封装**通用基础能力**（OIDC 换证、APIG V11 签名、HTTPS 请求工具、配置与缓存管理），**不封装业务编排**（`callApig` / `uploadToObs` 等因方法多变不直接封装）。
- `demo-action` 合并原两个插件的演示能力，核心流程：**OIDC 免认证上传 checkout 出的根目录 `README.md` 到 OBS -> OIDC 免认证调用 APIG**，并通过 workflow 呈现。

## 非目标（YAGNI）

- 不封装 `callApig` / `uploadToObs` 高层业务编排。
- 不封装 OBS / 云服务 OpenAPI 的其他签名协议（V11 仅适用于 APIG 网关，作用域服务名固定 `apic`）。
- 不引入第三方 HTTP / 认证依赖；`esdk-obs-nodejs` 经 `obsClient` 注入，SDK 自身不声明。
- 不拆分通用 SDK（此前已确认暂不做 `huaweicloud-gitcode-oidc-client`）。

## 目标文件结构

```
test-action/
├── sdk/
│   ├── openlibing-client.js            # SDK：OIDC 认证 + V11 签名 + HTTPS 请求工具（自包含）
│   ├── package.json
│   └── test/
│       └── openlibing-client.test.js   # SDK 测试
├── demo-action/                        # example：核心流程演示
│   ├── action.yml
│   ├── index.js                        # 上传 file-path 指定文件 -> 调用 APIG
│   ├── package.json
│   ├── test/
│   │   └── demo-action.test.js
│   ├── README.md
│   └── dist/                           # ncc 编译产物
├── .github/workflows/
│   └── demo-action-workflow.yml        # 演示 workflow
├── README.md                           # SDK + demo-action 项目说明
└── docs/superpowers/specs/
    └── 2026-08-20-openlibing-client-sdk-design.md
```

删除：`deploy-action/`、`obs-upload-action/`、`inspect-oidc-action/`、`shared/`（含 `huaweicloud-openlibing-client.js`、`signer-v11.js`）。

## SDK API 契约（sdk/openlibing-client.js）

自包含单文件模块，仅依赖 Node 内置 `https` / `crypto` / `url`，不依赖 `@actions/core`；日志降级为 `console.log`（含脱敏 `mask`）。

### 导出

```js
module.exports = { getCredentials, configure, V11Signer, sendRequest };
```

### `getCredentials(opts?)`

- OIDC -> STS `AssumeAgencyWithOIDC` 换取临时 AK/SK/SecurityToken。
- 返回：`{ accessKeyId, secretAccessKey, securityToken, expiresAt, expiresIn }`（`expiresAt` ISO 字符串、`expiresIn` 剩余秒数）。
- 行为：模块级缓存 + 临近过期（`refreshBufferSeconds`）自动刷新；`opts.force: true` 强制刷新；并发去重（同时多次调用只发起一次 STS 换证）。
- OIDC Token 来源顺序：
  1. 环境变量 `HUAWEICLOUD_OIDC_TOKEN`（诊断/测试覆盖）
  2. GitHub Actions 环境变量自申请：向 `ACTIONS_ID_TOKEN_REQUEST_URL` 发 GET（带 `audience` 查询参数，`Authorization: Bearer ACTIONS_ID_TOKEN_REQUEST_TOKEN`），解析响应 `value` 字段。

### `configure(overrides)`

- 内置 openlibing 默认配置，可覆盖：`accountId` / `audience` / `agencyName` / `oidcProviderName` / `region` / `stsAssumePath` / `durationSeconds` / `refreshBufferSeconds`。
- 返回覆盖后的完整配置。

### `V11Signer`（原 shared/signer-v11.js 整体内联）

- `new V11Signer({ region })`，设置 `signer.Key` / `signer.Secret`。
- `signer.sign(method, url, headers, body)` 返回签名后的完整请求头。
- 严格复刻华为云官方 APIG V11 算法：Credential 作用域 `YYYYMMDD/{region}/apic`、HKDF-SHA256 密钥派生（IKM=SK，salt=AK，info=credential_scope）、SignedHeaders 为全部请求头（小写、排序，含 host 与 x-sdk-date）。

### `sendRequest(method, url, headers, body)`

- HTTPS JSON 请求工具：发送请求、解析 JSON 响应，返回 `{ status, data }`（解析失败时 `data = { raw }`）。
- 供 demo-action 调用 APIG 使用，属于通用基础能力。

## demo-action（example）

### action.yml

```yaml
name: 'Openlibing Demo Action'
description: '演示 openlibing-client SDK：基于 OIDC 免认证上传 OBS 并调用 APIG（上传 checkout 出的根目录 README.md）'

inputs:
  file-path:             # 必填：待上传文件路径（如 ./README.md）

outputs: {}              # 无输出

runs:
  using: 'node20'
  main: 'dist/index.js'
```

### 核心流程（index.js）

1. **读取待上传文件**：读取输入 `file-path`（workflow 中传入 `./README.md`），校验文件存在，否则报错退出。
2. **OIDC 免认证上传 OBS**：`getCredentials()` 换取临时凭证；`new ObsClient({ access_key_id, secret_access_key, security_token, server })`（`server = https://obs.{region}.myhuaweicloud.com`），`putObject({ Bucket, Key, SourceFile })`，`close()`。`ObsClient` 由入口顶层 `require('esdk-obs-nodejs')` 提供（ncc 可内联）。
3. **OIDC 免认证调用 APIG**：`getCredentials()` 换证（缓存复用）；`V11Signer` 签名（含 `X-Security-Token`）；`sendRequest('GET', https://{apigHost}/version)`；2xx 判成功，非 2xx 输出 APIG 已知错误码排查提示并 `setFailed`。

- 除 `file-path` 外所有参数使用内置演示默认值：OBS 桶 `openlibing-gitcode-action`、对象名 `oidc-demo-action/<文件名>`（取自 file-path）、APIG 网关域名 `242b859e54a641069d7af46c8b63d9fe.apic.cn-southwest-2.huaweicloudapis.com`、APIG 路径 `/version`；OIDC 换证参数使用 SDK 内置 openlibing 默认值。
- 依赖：`@actions/core` + `esdk-obs-nodejs`。

## workflow（.github/workflows/demo-action-workflow.yml）

```yaml
name: Demo Action Workflow
on: [workflow_dispatch, push]
permissions:
  id-token: write
  contents: read
jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: 运行 demo-action（OIDC 上传 OBS + 调用 APIG）
        uses: ./demo-action
        with:
          file-path: ./README.md
```

## 测试方案

| 目录 | 测试内容 |
| --- | --- |
| `sdk/test/openlibing-client.test.js` | 模块导出；内置 openlibing 配置；OIDC->STS 完整链路（环境变量覆盖 / Actions 自申请）；缓存复用；force 刷新；并发去重；configure 覆盖；V11Signer 签名格式（Credential 四段/SignedHeaders/Signature）；sendRequest 解析 |
| `demo-action/test/demo-action.test.js` | 全流程：读取 file-path 文件 -> OBS 上传（注入 FakeObsClient + 拦截 STS）-> APIG 调用（拦截 HTTPS）；文件缺失校验；OBS 失败分支；APIG 非 2xx 分支 |

- 测试沿用现有拦截器模式：先回调挂监听再异步触发 `data`/`end`，避免 promise 永不 resolve 的假通过。
- `sdk` 测试与 `demo-action` 测试均通过 `require.cache` 清理隔离模块级凭证缓存。

## 文件变更清单

- 新建：`sdk/openlibing-client.js`、`sdk/package.json`、`sdk/test/openlibing-client.test.js`
- 新建：`demo-action/index.js`（读取 file-path -> 上传 OBS -> 调用 APIG）、`demo-action/action.yml`、`demo-action/package.json`、`demo-action/test/demo-action.test.js`、`demo-action/README.md`（workflow 传入 `./README.md`，直接上传 checkout 出的根目录文件）
- 新建：`.github/workflows/demo-action-workflow.yml`
- 重写：根 `README.md`
- 删除：`deploy-action/`、`obs-upload-action/`、`inspect-oidc-action/`、`shared/huaweicloud-openlibing-client.js`、`shared/signer-v11.js`（`shared/` 目录整体移除，`sdk/` 替代）
- 打包：`demo-action/dist`（ncc 编译）

## 验证方式

- `sdk` 与 `demo-action` 两套测试全部通过。
- `demo-action` `npm run build` 成功；dist 内联 `esdk-obs-nodejs` 与 SDK 源码。
- Grep 确认仓库无 `shared/`、`deploy-action/`、`obs-upload-action/`、`inspect-oidc-action/`、`signer-v11`、`huaweicloud-openlibing-client` 残留引用。
