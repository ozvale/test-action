# openlibing-client

一个以 **构建 npm 包** 为目标的 SDK 项目：`src/` 提供 openlibing 平台对接华为云的通用基础能力（OIDC 认证、APIG V11 签名、HTTPS 请求工具），`.github/actions/demo-action` 是基于该 SDK 的自定义 Action 插件（本地 composite 示例），通过 workflow 演示「基于 OIDC 免 AK/SK 上传 OBS + 调用 APIG」的完整链路。

## 目录结构

```
openlibing-client/
├── src/                                 # SDK 源码（npm 包主体，仅依赖 Node 内置模块）
│   ├── index.js                         # 包入口：导出 getCredentials / configure / V11Signer / sendRequest
│   ├── config.js                        # 内置 openlibing 配置 + configure() 覆盖（模块级单例 cfg）
│   ├── logger.js                        # 调试日志（debug 开关）+ 敏感字段脱敏工具
│   ├── http.js                          # sendRequest HTTPS 请求工具（调试模式打印请求/响应详情）
│   ├── oidc.js                          # GitHub OIDC ID Token 申请（环境变量覆盖 / Actions 自申请）
│   ├── credentials.js                   # getCredentials：OIDC -> STS 换证（缓存 / force / 并发去重）
│   └── signer-v11.js                    # V11Signer：APIG V11-HMAC-SHA256 签名器
├── test/
│   └── openlibing-client.test.js        # SDK 测试（12 个场景）
├── .github/
│   ├── actions/
│   │   └── demo-action/                 # 自定义 Action 插件（SDK 使用示例）
│   │       ├── action.yml
│   │       ├── index.js                 # 上传 file-path 指定文件到 OBS + 调用 APIG
│   │       ├── test/
│   │       │   └── demo-action.test.js  # demo-action 测试
│   │       ├── README.md                # demo-action 使用说明
│   │       └── dist/                    # ncc 编译产物（内联 openlibing-client 包与 esdk-obs-nodejs）
│   └── workflows/
│       └── demo-action-workflow.yml     # 演示 workflow
├── package.json                         # openlibing-client npm 包定义（main: src/index.js）
├── README.md
└── docs/superpowers/specs/
    └── 2026-08-20-openlibing-client-sdk-design.md   # 设计文档
```

## 安装与使用

```bash
npm install openlibing-client
```

```js
const openlibing = require('openlibing-client');

// 调试模式：默认静默；开启后打印关键步骤与每次 HTTP 请求/响应日志（敏感字段自动脱敏）
openlibing.configure({ debug: true });

// 1) OIDC 认证：GitHub Actions OIDC ID Token -> 华为云 STS AssumeAgencyWithOIDC 换证（带缓存自动刷新）
const cred = await openlibing.getCredentials();
// => { accessKeyId, secretAccessKey, securityToken, expiresAt, expiresIn }

// 覆盖内置 openlibing 配置（换账号/区域等）
openlibing.configure({ accountId: 'xxx', region: 'cn-north-4' });

// 2) APIG V11-HMAC-SHA256 签名
const signer = new openlibing.V11Signer({ region: 'cn-southwest-2' });
signer.Key = cred.accessKeyId;
signer.Secret = cred.secretAccessKey;
const headers = signer.sign('GET', 'https://{apig-host}/v1/export', {}, '');

// 3) HTTPS 请求并解析 JSON 响应
const res = await openlibing.sendRequest('GET', 'https://{apig-host}/v1/export', headers, '');
// => { status, headers, data }
```

SDK 仅依赖 Node 内置模块（`https` / `crypto` / `url`），不依赖 `@actions/core`，任意 Node 环境均可独立使用。

导出的核心接口：

| 接口 | 说明 |
| --- | --- |
| `getCredentials(opts)` | 获取华为云临时凭证（AK/SK/SecurityToken），支持缓存自动刷新、`force` 强制刷新、并发去重 |
| `configure(overrides)` | 覆盖内置 openlibing 默认配置（账号 ID、audience、委托、OIDC 提供商、区域、`debug` 调试开关等） |
| `V11Signer` | APIG V11-HMAC-SHA256 签名器（严格复刻华为云官方算法，作用域服务名固定 `apic`） |
| `sendRequest(method, url, headers, body)` | HTTPS 请求工具，解析 JSON 响应，返回 `{ status, headers, data }` |

### 调试模式

SDK 默认静默，`configure({ debug: true })` 开启调试模式后打印关键步骤日志：

- OIDC 申请与 STS 换证的各步骤（含 OIDC Token 声明 iss/aud/azp/sub，便于与华为云信任策略比对）
- 每次 HTTP 请求的请求行（方法 + URL）、请求头、请求体与响应状态码、响应头、响应体
- 敏感字段自动脱敏：`Authorization`、`X-Security-Token`、`id_token`、临时 AK/SK/SecurityToken 及 JWT 令牌

## npm 包构建

```bash
npm test          # 运行 SDK 测试
npm run build     # npm pack，产出单个包 openlibing-client-x.y.z.tgz（仅打包 src/）
npm publish       # 发布（files 字段限定仅含 src/）
```

## 自定义插件：.github/actions/demo-action

`demo-action` 是位于 `.github/actions/` 的本地自定义 Action（基于 SDK 的完整示例），以真实使用方的方式引用 SDK：通过 `file:` 依赖安装根目录 `npm pack` 构建出的单个包（`"openlibing-client": "file:../../../openlibing-client-1.0.0.tgz"`），代码中 `require('openlibing-client')`，ncc 构建时将安装的包内联进 dist。SDK 版本升级后需在根目录重新 `npm run build` 并同步更新该 `file:` 路径中的版本号。

1. **OIDC 免认证上传 OBS**：`getCredentials()` 换取临时凭证 -> `new ObsClient({ ...临时凭证, server })` -> `putObject()`。
2. **OIDC 免认证调用 APIG**：`getCredentials()` 换证 -> `V11Signer` 签名（含 `X-Security-Token`）-> `sendRequest()` 调用 APIG 接口。

唯一输入 `file-path` 为待上传文件路径。其余参数使用内置演示默认值：OBS 桶 `openlibing-gitcode-action`、对象名 `oidc-demo-action/<文件名>`（取自 file-path）、APIG 网关域名与路径 `/version`。

demo-action 内部开启 SDK 调试模式，运行日志按 4 个步骤打印，第三方接口（GitHub OIDC、华为云 STS、OBS、APIG）的请求地址、请求头、请求体与响应状态码、响应头、响应体均完整输出（敏感字段自动脱敏），便于在 Actions 日志中直接排查链路问题。详见 [demo-action README](.github/actions/demo-action/README.md)。

## workflow：demo-action-workflow.yml

workflow 共两步，直接上传 checkout 出的根目录 `README.md`：

```yaml
permissions:
  id-token: write        # 必须声明，否则无法申请 OIDC JWT
  contents: read

jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4        # 1. checkout（获取根目录 README.md）
      - name: 运行 demo-action（OIDC 上传 OBS + 调用 APIG）
        uses: ./.github/actions/demo-action
        with:
          file-path: ./README.md        # 2. 上传根目录 README.md 到 openlibing-gitcode-action 桶的 oidc-demo-action/ 路径
```

整个链路零 Secret 引用：`id-token: write` 是 GitHub 权限声明而非密钥，华为云侧通过 IAM 委托 `gitcode-actions` 授权。

## 测试

```bash
# SDK 测试（项目根目录）
npm test

# 构建 SDK 单个包并运行 demo-action 测试
npm run build                                         # 根目录产出 openlibing-client-1.0.0.tgz
cd .github/actions/demo-action && npm install && npm test

# 重建 demo-action 的 ncc 产物
cd .github/actions/demo-action && npm run build
```

## 参考资料

- 落地指导文档：`huaweicloud-oidc-connect-guide.html`
- 设计文档：`docs/superpowers/specs/2026-08-20-openlibing-client-sdk-design.md`
