# openlibing-client SDK 与 demo-action 项目重构设计

日期：2026-08-20

## 背景与目标

当前仓库包含共享薄库（`shared/huaweicloud-openlibing-client.js` + `shared/signer-v11.js`）与两个独立插件（`deploy-action` 调用 APIG、`obs-upload-action` 上传 OBS），以及临时调试残留（`inspect-oidc-action`）。目标（用户多轮确认后收敛）：

- 将仓库重构为「**openlibing-client SDK（npm 包）+ 本地自定义 Action 示例**」项目：`src/` 按功能拆分为多模块提供通用基础能力，支持构建发布为 npm 包 `openlibing-client`；`.github/actions/demo-action` 作为使用 SDK 的本地自定义 Action 示例。
- SDK 只封装**通用基础能力**（OIDC 换证、APIG V11 签名、HTTPS 请求工具、配置与缓存管理），**不封装业务编排**（`callApig` / `uploadToObs` 等因方法多变不直接封装）。
- `demo-action` 合并原两个插件的演示能力，核心流程：**OIDC 免认证上传 checkout 出的根目录 `README.md` 到 OBS -> OIDC 免认证调用 APIG**，并通过 workflow 呈现。

## 非目标（YAGNI）

- 不封装 `callApig` / `uploadToObs` 高层业务编排。
- 不封装 OBS / 云服务 OpenAPI 的其他签名协议（V11 仅适用于 APIG 网关，作用域服务名固定 `apic`）。
- 不引入第三方 HTTP / 认证依赖；`esdk-obs-nodejs` 经 `obsClient` 注入，SDK 自身不声明。
- 不拆分通用 SDK（此前已确认暂不做 `huaweicloud-gitcode-oidc-client`）。

## 目标文件结构

```
openlibing-client/                       # 项目根 = openlibing-client npm 包
├── src/                                 # SDK 源码（包主体，files 字段仅打包 src/）
│   ├── index.js                         # 包入口：导出 getCredentials / configure / V11Signer / sendRequest
│   ├── config.js                        # 内置 openlibing 配置 + configure()（模块级单例 cfg）
│   ├── logger.js                        # 调试日志（debug 开关）+ 敏感字段脱敏工具
│   ├── http.js                          # sendRequest HTTPS 请求工具（调试日志）
│   ├── oidc.js                          # GitHub OIDC ID Token 申请
│   ├── credentials.js                   # getCredentials：OIDC -> STS 换证（缓存/force/并发去重）
│   └── signer-v11.js                    # V11Signer：APIG V11-HMAC-SHA256 签名器
├── test/
│   └── openlibing-client.test.js        # SDK 测试
├── .github/
│   ├── actions/
│   │   └── demo-action/                 # 本地自定义 Action（example）
│   │       ├── action.yml
│   │       ├── index.js                 # 上传 file-path 指定文件 -> 调用 APIG
│   │       ├── package.json
│   │       ├── test/
│   │       │   └── demo-action.test.js
│   │       ├── README.md
│   │       └── dist/                    # ncc 编译产物（内联 src/ SDK 与 esdk-obs-nodejs）
│   └── workflows/
│       └── demo-action-workflow.yml     # 演示 workflow（uses: ./.github/actions/demo-action）
├── package.json                         # npm 包定义（main: src/index.js）
├── README.md
└── docs/superpowers/specs/
    └── 2026-08-20-openlibing-client-sdk-design.md
```

模块依赖方向（无循环）：`config <- logger <- http <- oidc <- credentials`；`signer-v11` 仅依赖 `crypto`，独立。

删除：`deploy-action/`、`obs-upload-action/`、`inspect-oidc-action/`、`shared/`、旧 `sdk/`（单文件版已拆分并入 `src/`）。

demo-action 对 SDK 的引用方式：**引构建后的单个包**，不直接引用 `src/` 源码——根目录 `npm run build`（`npm pack`）产出 `openlibing-client-x.y.z.tgz`，demo-action `package.json` 声明 `"openlibing-client": "file:../../../openlibing-client-1.0.0.tgz"`，代码 `require('openlibing-client')`，ncc 构建时将安装的包内联进 dist（版本升级需重新 pack 并同步 `file:` 路径版本号）。

## SDK API 契约（src/，入口 index.js）

`src/` 多模块，仅依赖 Node 内置 `https` / `crypto` / `url`，不依赖 `@actions/core`；日志降级为 `console.log`（含脱敏 `mask`）。对外 API 由 `src/index.js` 统一导出，包 `main` 指向 `src/index.js`，`npm pack` 仅打包 `src/`。

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

- 内置 openlibing 默认配置，可覆盖：`accountId` / `audience` / `agencyName` / `oidcProviderName` / `region` / `stsAssumePath` / `durationSeconds` / `refreshBufferSeconds` / `debug`。
- 返回覆盖后的完整配置。
- 调试模式：默认 `debug: false`（SDK 静默）；`debug: true` 开启后打印关键步骤日志——OIDC 申请与 STS 换证各步骤（含 OIDC Token 声明 iss/aud/azp/sub），以及每次 HTTP 请求的请求行、请求头、请求体与响应状态码、响应头、响应体。
- 敏感字段自动脱敏：`Authorization`、`X-Security-Token`、`id_token`、临时 AK/SK/SecurityToken、JWT 令牌（正则识别），仅保留首尾若干字符；其余非敏感信息原样输出。

### `V11Signer`（原 shared/signer-v11.js 整体内联）

- `new V11Signer({ region })`，设置 `signer.Key` / `signer.Secret`。
- `signer.sign(method, url, headers, body)` 返回签名后的完整请求头。
- 严格复刻华为云官方 APIG V11 算法：Credential 作用域 `YYYYMMDD/{region}/apic`、HKDF-SHA256 密钥派生（IKM=SK，salt=AK，info=credential_scope）、SignedHeaders 为全部请求头（小写、排序，含 host 与 x-sdk-date）。

### `sendRequest(method, url, headers, body)`

- HTTPS JSON 请求工具：发送请求、解析 JSON 响应，返回 `{ status, headers, data }`（解析失败时 `data = { raw }`）。
- 调试模式下打印完整请求/响应日志（请求行、请求头、请求体、响应状态码、响应头、响应体，敏感字段脱敏），OIDC 申请与 STS 换证亦经由此工具，自动获得同样的日志。
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

### 日志设计

demo-action 打印执行步骤与关键日志，第三方接口调用的地址、请求头、请求体、响应头、响应体均输出（敏感字段自动脱敏）：

- 执行按 4 个步骤分节打印：`--- 步骤 1/4：读取并校验待上传文件 ---` 至 `--- 步骤 4/4：基于 OIDC 临时凭证调用 APIG 接口 ---`。
- demo-action 内部调用 `configure({ debug: true })` 开启 SDK 调试模式：GitHub OIDC 申请、STS 换证、APIG 调用的完整请求/响应日志由 SDK `sendRequest` 统一打印（`--> 请求行/请求头/请求体`、`<-- 状态码/响应头/响应体`）。
- OBS 调用不经 SDK HTTP 工具，由 demo-action 自行打印：请求行（`PUT {server}/{bucket}/{key}`）、请求参数（Bucket/Key/SourceFile）、客户端参数（AK/SecurityToken 脱敏）、响应状态码/RequestId/解析后的响应头字段（ETag 等）。

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
        uses: ./.github/actions/demo-action
        with:
          file-path: ./README.md
```

## 测试方案

| 目录 | 测试内容 |
| --- | --- |
| `test/openlibing-client.test.js` | 模块导出；内置 openlibing 配置（含 debug 默认关闭）；OIDC->STS 完整链路（环境变量覆盖 / Actions 自申请）；缓存复用；force 刷新；并发去重；configure 覆盖；V11Signer 签名格式（Credential 四段/SignedHeaders/Signature）；sendRequest 解析；调试模式（默认静默 / 开启后打印关键步骤与 STS 请求响应详情且凭证脱敏）；sendRequest 返回响应头与 Authorization/JWT 脱敏 |
| `.github/actions/demo-action/test/demo-action.test.js` | 全流程：读取 file-path 文件 -> OBS 上传（注入 FakeObsClient + 拦截 STS）-> APIG 调用（拦截 HTTPS）；执行步骤与第三方接口请求/响应日志（stdout 捕获断言）与敏感字段脱敏；文件缺失校验；OBS 失败分支；APIG 非 2xx 分支 |

- 测试沿用现有拦截器模式：先回调挂监听再异步触发 `data`/`end`，避免 promise 永不 resolve 的假通过。
- SDK 测试与 `demo-action` 测试均通过 `require.cache` 清理隔离模块级配置与凭证缓存（SDK 测试按 `src/` 目录前缀清理全部子模块）。

## 文件变更清单

- 新建：`src/index.js`、`src/config.js`、`src/logger.js`、`src/http.js`、`src/oidc.js`、`src/credentials.js`、`src/signer-v11.js`（由单文件 `sdk/openlibing-client.js` 按功能拆分而来）
- 新建：根 `package.json`（openlibing-client npm 包定义：`main: src/index.js`、`files: ["src"]`、test/build 脚本）、`test/openlibing-client.test.js`
- 迁移：`demo-action/` -> `.github/actions/demo-action/`（本地自定义 Action，workflow 以 `./.github/actions/demo-action` 引用）
- 新建：`.github/workflows/demo-action-workflow.yml`
- 重写：根 `README.md`、`.github/actions/demo-action/README.md`
- 删除：`deploy-action/`、`obs-upload-action/`、`inspect-oidc-action/`、`shared/`、`sdk/`（单文件版拆分并入 `src/`）
- 打包：`.github/actions/demo-action/dist`（ncc 编译，内联 `node_modules/openlibing-client` 与 `esdk-obs-nodejs`）

## 验证方式

- 根目录 `npm test`（SDK 12 项）与 `.github/actions/demo-action` `npm test`（4 项）全部通过。
- 根目录 `npm run build`（`npm pack`）产出单个包 `openlibing-client-1.0.0.tgz`；demo-action `npm install` 后 `require('openlibing-client')` 可解析。
- `demo-action` `npm run build` 成功；dist 内联 `esdk-obs-nodejs` 与安装的 `openlibing-client` 包，且无对 `src/` 的相对路径运行时依赖。
- Grep 确认仓库无 `shared/`、`sdk/`、旧目录残留引用。
