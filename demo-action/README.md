# demo-action：openlibing-client SDK 使用示例（GitHub Action）

`demo-action` 是基于 `openlibing-client` SDK 的完整示例 Action，演示两个核心场景：

1. **OIDC 免认证上传 OBS**：SDK `getCredentials()` 换取华为云临时凭证 -> `esdk-obs-nodejs` 的 `putObject()` 上传文件。
2. **OIDC 免认证调用 APIG**：SDK `getCredentials()` 换证 -> `V11Signer` 生成 APIG V11-HMAC-SHA256 签名（含 `X-Security-Token`）-> `sendRequest()` 调用 APIG 接口。

整个链路零 Secret 引用，仅需 GitHub 声明 `permissions: id-token: write`。

## 输入

| 输入 | 必填 | 说明 |
| --- | --- | --- |
| `file-path` | 是 | 待上传文件的路径，如 `./README.md` |

除 `file-path` 外，其余参数使用内置演示默认值：

- OBS 桶：`openlibing-gitcode-action`
- 对象名：`oidc-demo-action/<文件名>`（取自 `file-path` 的文件名）
- APIG 网关域名：`242b859e54a641069d7af46c8b63d9fe.apic.cn-southwest-2.huaweicloudapis.com`
- APIG 调用路径：`/version`
- OIDC 换证参数：SDK 内置 openlibing 账号默认值（可用 `configure()` 覆盖）

## 使用（workflow）

```yaml
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

## 本地开发

```bash
npm install
npm test      # 运行测试（拦截 STS/APIG 请求 + 注入 FakeObsClient）
npm run build # 使用 ncc 将 SDK 与 esdk-obs-nodejs 内联进 dist/
```
