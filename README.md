# @openlibing/huaweicloud-oidc-client

openlibing 平台对接华为云的 SDK（npm 包）：基于 **GitHub Actions OIDC → 华为云 STS** 免密换取临时凭证，提供 APIG V11 签名与 HTTP 请求能力。全程零 AK/SK 密钥。

```
GitHub Actions OIDC ID Token
  → 华为云 STS AssumeAgencyWithOIDC 换临时凭证
    → OBS 上传（临时凭证 + esdk-obs-nodejs）
    → APIG 调用（V11-HMAC-SHA256 签名 + X-Security-Token）
```

## 目录结构

```
test-action/
├── src/                                 # SDK 源码（HTTP 层基于 Node 内置 fetch）
│   ├── index.js                         # 包入口：导出 getCredentials / configure / V11Signer / sendRequest
│   ├── config.js                        # 内置 openlibing 配置 + configure() 覆盖
│   ├── logger.js                        # 调试日志（debug 开关）+ 敏感字段脱敏
│   ├── http.js                          # sendRequest 请求工具（fetch 实现）
│   ├── oidc.js                          # GitHub OIDC ID Token 申请
│   ├── credentials.js                   # getCredentials：OIDC → STS 换证（缓存 / force / 并发去重）
│   └── signer-v11.js                    # V11Signer：APIG V11-HMAC-SHA256 签名器
├── test/
│   └── openlibing-client.test.js        # SDK 测试（12 个场景）
├── .github/
│   ├── actions/demo-action/             # 自定义 Action 插件（SDK 使用示例）
│   └── workflows/
│       ├── demo-action-workflow.yml     # 演示 workflow
│       └── deploy.yml                   # npm 发布流水线
├── package.json                         # @openlibing/huaweicloud-oidc-client
├── huaweicloud-oidc-connect-guide.html  # 完整落地指导文档
└── docs/superpowers/specs/              # 设计文档
```

## 安装

```bash
npm install @openlibing/huaweicloud-oidc-client
```

要求 Node 18+（SDK HTTP 层基于内置 `fetch`）。

## 核心 API

| 接口 | 说明 |
| --- | --- |
| `getCredentials(opts)` | 获取华为云临时凭证，支持缓存自动刷新、`force` 强制刷新、并发去重 |
| `configure(overrides)` | 覆盖内置配置（账号 ID、audience、委托、OIDC 提供商、区域、`debug` 等） |
| `V11Signer` | APIG V11-HMAC-SHA256 签名器（credential scope 固定 `YYYYMMDD/{region}/apic`） |
| `sendRequest(method, url, headers, body)` | HTTP 请求工具，返回 `{ status, headers, data }` |

### 示例：调用 APIG 接口

```js
const openlibing = require('@openlibing/huaweicloud-oidc-client');

// 可选：开启调试模式（打印关键步骤与请求/响应详情，敏感字段自动脱敏）
// openlibing.configure({ debug: true });

// 1) OIDC 免密换取临时凭证（GitHub Actions 环境，workflow 需声明 id-token: write）
const cred = await openlibing.getCredentials();
// => { accessKeyId, secretAccessKey, securityToken, expiresAt, expiresIn }

// 2) V11 签名（临时凭证调用必须携带 X-Security-Token 并参与签名）
const signer = new openlibing.V11Signer({ region: 'cn-southwest-2' });
signer.Key = cred.accessKeyId;
signer.Secret = cred.secretAccessKey;

const url = 'https://{apig-instance-id}.apic.cn-southwest-2.huaweicloudapis.com/v1/export';
const headers = signer.sign('GET', url, {
  'X-Security-Token': cred.securityToken,
  'Content-Type': 'application/json'
}, '');

// 3) 发起请求
const res = await openlibing.sendRequest('GET', url, headers, '');
// => { status: 200, headers: {...}, data: {...} }
```

### 示例：上传文件到 OBS

OBS 上传不在 SDK 内封装（避免强制引入 `esdk-obs-nodejs` 依赖），使用方自行注入 OBS 客户端：

```js
const { ObsClient } = require('esdk-obs-nodejs');
const openlibing = require('@openlibing/huaweicloud-oidc-client');

const cred = await openlibing.getCredentials();

const obs = new ObsClient({
  access_key_id: cred.accessKeyId,
  secret_access_key: cred.secretAccessKey,
  security_token: cred.securityToken,
  server: 'https://obs.cn-southwest-2.myhuaweicloud.com'
});

const result = await obs.putObject({
  Bucket: 'your-bucket-name',
  Key: 'path/to/object.csv',
  SourceFile: './local-file.csv'
});

await obs.close();
```

### 调试模式

默认静默。`configure({ debug: true })` 开启后打印：

- OIDC 申请与 STS 换证各步骤（含 OIDC Token 声明 iss/aud/azp/sub，便于与华为云信任策略比对）
- 每次 HTTP 请求的请求行、请求头、请求体与响应状态码、响应头、响应体
- 敏感字段自动脱敏：`Authorization`、`X-Security-Token`、`id_token`、临时 AK/SK/SecurityToken 及 JWT 令牌

## npm 包构建与发布

```bash
npm test          # 运行 SDK 测试
npm run build     # npm pack，产出 openlibing-huaweicloud-oidc-client-x.y.z.tgz（仅含 src/）
npm publish --access public   # 发布到 npm（scoped 包需显式 public）
```

发布流水线见 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)，打 tag 或手动触发即可发布（依赖仓库 secret `NPM_TOKEN`）。

## 演示 Action：demo-action

[`.github/actions/demo-action/`](.github/actions/demo-action/) 是基于本 SDK 的完整示例 Action，演示「读取文件 → OIDC 免密上传 OBS → OIDC 免密调用 APIG」全流程。通过 `file:` 依赖引用根目录 `npm pack` 产物，ncc 构建时内联进 dist。

## 华为云侧配置

SDK 内置 openlibing 平台默认配置（账号 `4d29a984c4fe4e6eb5d404a853d0084e`、区域 `cn-southwest-2`、委托 `gitcode-actions`、OIDC 提供商 `GitHubActions`、audience `huawei-cloud-service`），与华为云侧以下配置严格对应。若接入其他账号，需通过 `configure()` 覆盖，并在华为云侧按下方步骤搭建。

### 一、IAM：建立 OIDC 信任

**1. 创建 OIDC 身份提供商**

位置：IAM 控制台 → 身份提供商 → 创建 → OIDC

| 配置项 | 示例值 | 说明 |
| --- | --- | --- |
| 提供商名称 | `GitHubActions` | URN 组成部分：`iam::{accountId}:oidcProvider:GitHubActions` |
| 协议 | OIDC | — |
| 颁发者 URL | `https://token.actions.githubusercontent.com` | 必须与 OIDC Token 的 `iss` 声明严格一致 |
| 客户端 ID | `huawei-cloud-service` | 必须与 SDK `audience`（即 getIDToken 的 aud）一致 |

**2. 创建信任委托**

位置：IAM 控制台 → 委托 → 创建 → 信任主体选「OIDC 身份提供商」→ 选上一步的 `GitHubActions`

- 委托名称：`gitcode-actions`（URN：`iam::{accountId}:agency:gitcode-actions`）
- 信任策略（Version 5.0）：通过 `Condition` 限定可换证的来源，必含 `oidc:iss` 与 `oidc:aud`，建议配置 `oidc:sub` 防范混淆代理攻击。运算符：**精确匹配用 `StringEquals`，通配符匹配用 `StringMatch`**（旧版 `StringLike` 已不推荐）：

```json
{
  "Version": "5.0",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["sts:agencies:assumeWithOIDC"],
    "Principal": { "Federated": ["iam::{accountId}:oidcProvider:GitHubActions"] },
    "Condition": {
      "StringEquals": {
        "oidc:iss": ["https://token.actions.githubusercontent.com"],
        "oidc:aud": ["huawei-cloud-service"]
      },
      "StringMatch": {
        "oidc:sub": ["repo:<组织>/<仓库>:ref:refs/heads/main"]
      }
    }
  }]
}
```

> 通配符示例：限定某仓库任意分支用 `repo:<组织>/<仓库>:*`；限定组织内任意仓库/分支用 `repo:<组织>/*`。

> 2026-07-15 起新建/转移仓库的 `sub` 附带不可变 ID，格式如 `repo:<组织>@<组织ID>/<仓库>@<仓库ID>:ref:refs/heads/main`，信任策略需同时覆盖新旧两种格式。

**3. 配置委托身份策略**

决定临时凭证能操作哪些资源，按最小权限授予：

- **调用 APIG**：`APIG FullAccess` 系统策略（或等价自定义策略）
- **上传 OBS**：通过 OBS 桶策略授权（见下）
- 注意：项目级授权需选择对应区域的项目（如 `cn-southwest-2`），否则临时凭证在该区域无权限

配置完成后，在「委托 → 授权记录」中核对授权范围是否生效。

### 二、APIG：开放接口并启用 IAM 认证

**1. 创建专享实例与 API**

- 区域：与 OBS 桶、STS 端点保持一致（如 `cn-southwest-2`）
- 调用域名格式：`<实例ID>.apic.<region>.huaweicloudapis.com`

**2. API 认证方式：IAM（AK/SK）**

- 签名算法：V11-HMAC-SHA256（与 SDK 的 `V11Signer` 对应）
- 临时凭证调用必须在请求头携带 `X-Security-Token`，并作为参与签名的请求头
- 使用标准 `Authorization` 头，不要使用调试模式的 `X-Apig-Authorization` 头

### 三、OBS：创建桶并授权委托写入

**1. 创建桶**

- 区域与 APIG 实例一致（如 `cn-southwest-2`）
- 桶名全局唯一，建议按 `<业务域>-<用途>-<环境>` 命名

**2. 配置桶策略**

通过桶策略将对象读写权限授予委托 URN `iam::{accountId}:agency:gitcode-actions`，使临时凭证能执行 `PutObject` 等操作。

### 四、GitHub 工作流侧

```yaml
permissions:
  id-token: write   # 必须声明，否则无法申请 OIDC JWT
  contents: read
```

### 配置顺序建议

`GitHub → IAM → APIG → OBS → 流水线验证`。IAM 信任策略依赖 GitHub 侧的令牌声明，APIG/OBS 授权依赖 IAM 委托，流水线验证放最后。

### 常见错误排查

| 错误码 | 原因 | 排查方向 |
| --- | --- | --- |
| STS5.1001 / 403 | 信任策略条件与 OIDC Token 声明不匹配 | 开启 SDK 调试模式，比对 iss/aud/sub 与信任策略 |
| STS5.2001 | audience 与 OIDC 提供商的客户端 ID 不一致 | 确认 `huawei-cloud-service` 已在提供商注册 |
| APIG.0624 | 签名算法与 APIG 期望不一致 | 确认使用 V11-HMAC-SHA256，作用域 `YYYYMMDD/{region}/apic` |
| APIG.0602 | 未携带 `X-Security-Token` 或未参与签名；委托缺 APIG 权限 | 检查请求头、签名包含的 header、委托身份策略 |
| APIG.0301 | 使用了调试模式签名头 | 使用标准 `Authorization` 头 |

更完整的配置步骤、策略示例与验收清单见 [落地指导文档](./huaweicloud-oidc-connect-guide.html)。

## 测试

```bash
# SDK 测试
npm test

# 构建 SDK 包并运行 demo-action 测试
npm run build
cd .github/actions/demo-action && npm install && npm test

# 重建 demo-action 的 ncc 产物
cd .github/actions/demo-action && npm run build
```

## 设计文档

- [落地指导文档](./huaweicloud-oidc-connect-guide.html)
- [SDK 设计文档](./docs/superpowers/specs/2026-08-20-openlibing-client-sdk-design.md)
- [AGENTS.md](./AGENTS.md)（开发协作指南）
