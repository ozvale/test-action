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

## 日志

demo-action 按步骤打印执行日志，第三方接口调用的完整请求/响应均输出到 Actions 日志（敏感字段自动脱敏）：

```text
=== demo-action：基于 OIDC 免认证上传 OBS 并调用 APIG ===
--- 步骤 1/4：读取并校验待上传文件 ---
输入文件 / 上传目标对象 / 区域 / APIG 地址
--- 步骤 2/4：OIDC 认证换取华为云临时凭证（GitHub OIDC -> STS）---
=== 步骤1：申请 GitHub OIDC ID Token ===        ← SDK 调试日志
--> GET https://pipelines.actions.githubusercontent.com/...?audience=huawei-cloud-service
--> 请求头: {"Authorization":"Bearer***（脱敏）",...}
<-- HTTP 状态码: 200
<-- 响应头: {...}
<-- 响应体: {"value":"eyJhbGci***（JWT 脱敏）"}
=== 步骤2：调用 STS AssumeAgencyWithOIDC ===    ← SDK 调试日志
--> POST https://sts.cn-southwest-2.myhuaweicloud.com/v5/agencies/assume-with-oidc
--> 请求头 / 请求体（id_token 脱敏）
<-- HTTP 状态码 / 响应头 / 响应体（临时 AK/SK/SecurityToken 脱敏）
--- 步骤 3/4：基于 OIDC 临时凭证上传文件到 OBS ---
OBS 请求     : PUT https://obs.cn-southwest-2.myhuaweicloud.com/<桶>/<对象名>
OBS 请求参数 : Bucket=..., Key=..., SourceFile=...（N 字节）
OBS 响应     : HTTP 200, RequestId: ...
OBS 响应头   : {"ETag":"...","RequestId":"...","Id2":"..."}
--- 步骤 4/4：基于 OIDC 临时凭证调用 APIG 接口（V11-HMAC-SHA256 签名）---
--> GET https://<apig-host>/version             ← SDK 调试日志
--> 请求头: {"X-Security-Token":"***（脱敏）","x-sdk-date":"...","Authorization":"V11-HM***（脱敏）",...}
<-- HTTP 状态码 / 响应头 / 响应体
```

脱敏规则：`Authorization`、`X-Security-Token`、`id_token`、临时 AK/SK/SecurityToken 及 JWT 令牌仅保留首尾若干字符；其余非敏感信息（URL、请求参数、状态码、响应头、响应体）原样输出。

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
