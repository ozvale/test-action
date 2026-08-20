# test-action：openlibing-client SDK + example

一个「**SDK + example**」项目：`sdk/` 提供 openlibing 平台对接华为云的通用基础能力（OIDC 认证、APIG V11 签名、HTTPS 请求工具），`demo-action/` 是基于该 SDK 的完整 GitHub Action 示例，通过 workflow 演示「基于 OIDC 免 AK/SK 上传 OBS + 调用 APIG」的完整链路。

## 目录结构

```
test-action/
├── sdk/
│   ├── openlibing-client.js            # SDK：OIDC 认证 + V11 签名 + HTTPS 请求工具（单文件、自包含）
│   ├── package.json
│   └── test/
│       └── openlibing-client.test.js   # SDK 测试
├── demo-action/                        # example：基于 SDK 的完整示例 Action
│   ├── action.yml
│   ├── index.js                        # 上传 file-path 指定文件到 OBS + 调用 APIG
│   ├── package.json
│   ├── test/
│   │   └── demo-action.test.js         # demo-action 测试
│   ├── README.md                       # demo-action 使用说明
│   └── dist/                           # ncc 编译产物
├── .github/workflows/
│   └── demo-action-workflow.yml        # 演示 workflow
├── README.md
└── docs/superpowers/specs/
    └── 2026-08-20-openlibing-client-sdk-design.md   # 设计文档
```

## SDK：sdk/openlibing-client.js

单文件自包含 SDK，仅依赖 Node 内置模块（`https` / `crypto` / `url`），不依赖 `@actions/core`，任意 Node 环境均可独立使用。

```js
const openlibing = require('./sdk/openlibing-client');

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
// => { status, data }
```

导出的核心接口：

| 接口 | 说明 |
| --- | --- |
| `getCredentials(opts)` | 获取华为云临时凭证（AK/SK/SecurityToken），支持缓存自动刷新、`force` 强制刷新、并发去重 |
| `configure(overrides)` | 覆盖内置 openlibing 默认配置（账号 ID、audience、委托、OIDC 提供商、区域等） |
| `V11Signer` | APIG V11-HMAC-SHA256 签名器（严格复刻华为云官方算法，作用域服务名固定 `apic`） |
| `sendRequest(method, url, headers, body)` | HTTPS 请求工具，解析 JSON 响应 |

## example：demo-action

`demo-action` 是基于 SDK 的完整示例 Action，演示两个核心场景：

1. **OIDC 免认证上传 OBS**：`getCredentials()` 换取临时凭证 -> `new ObsClient({ ...临时凭证, server })` -> `putObject()`。
2. **OIDC 免认证调用 APIG**：`getCredentials()` 换证 -> `V11Signer` 签名（含 `X-Security-Token`）-> `sendRequest()` 调用 APIG 接口。

唯一输入 `file-path` 为待上传文件路径。其余参数使用内置演示默认值：OBS 桶 `openlibing-gitcode-action`、对象名 `oidc-demo-action/<文件名>`（取自 file-path）、APIG 网关域名与路径 `/version`。

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
        uses: ./demo-action
        with:
          file-path: ./README.md        # 2. 上传根目录 README.md 到 openlibing-gitcode-action 桶的 oidc-demo-action/ 路径
```

整个链路零 Secret 引用：`id-token: write` 是 GitHub 权限声明而非密钥，华为云侧通过 IAM 委托 `gitcode-actions` 授权。

## 测试

```bash
# SDK 测试
cd sdk && npm test

# demo-action 测试
cd demo-action && npm install && npm test

# 重建 demo-action 的 ncc 产物
cd demo-action && npm run build
```

## 参考资料

- 落地指导文档：`huaweicloud-oidc-connect-guide.html`
- 设计文档：`docs/superpowers/specs/2026-08-20-openlibing-client-sdk-design.md`
