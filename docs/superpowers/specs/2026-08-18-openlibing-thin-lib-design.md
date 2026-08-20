# 薄库化重构设计：shared 库只暴露临时凭证获取

日期：2026-08-18

## 背景与目标

当前 `shared/huaweicloud-openlibing-client.js` 把 openlibing 账号的 OIDC→STS→APIG/OBS 全链路封装为高层接口（`callApig` / `uploadToObs`）。问题：

- 库绑定死了具体业务接口（如 `/v1/export` 路径、OBS 上传语义），更换或新增服务必须改库。
- 使用方无法用自己的逻辑调用 openlibing 账号下的其他华为云能力。

目标（用户已确认方案 A1）：**库只做最薄的换证**，导出"获取临时 AK/SK/SecurityToken"的能力；APIG 调用、OBS 上传逻辑全部下移到各自插件；V11 签名器因实现复杂、且未来其他 APIG 调用方可复用，拆为独立共享模块。

## 非目标（YAGNI）

- 不实现跨服务（OBS、ECS、IAM 等）的通用签名请求层：V11 仅适用于 APIG 网关（作用域服务名固定 `apic`），OBS 与云服务 OpenAPI 使用不同签名协议，不纳入本库。
- 不保留任何 APIG/OBS 高层封装接口。
- 不引入第三方 HTTP/认证依赖。

## 目标文件结构

```
shared/
├── huaweicloud-openlibing-client.js   # 薄库：getCredentials + configure（OIDC→STS 换证）
├── signer-v11.js                       # V11 签名器（独立可复用，deploy-action 引用）
└── test/
    └── huaweicloud-openlibing-client.test.js   # 薄库测试

deploy-action/
├── index.js                            # 引用 signer-v11 + getCredentials，拼 APIG 调用
└── test/deploy-action.test.js          # V11 签名 + APIG 调用集成测试

obs-upload-action/
├── index.js                            # 引用 getCredentials + esdk-obs-nodejs，OBS 上传
└── test/obs-upload-action.test.js      # OBS 上传测试
```

## 薄库 API 契约（shared/huaweicloud-openlibing-client.js）

### 内置固定配置（openlibing 账号）

- accountId：`4d29a984c4fe4e6eb5d404a853d0084e`
- audience：`huawei-cloud-service`
- agencyName：`gitcode-actions`
- oidcProviderName：`GitHubActions`
- region：默认 `cn-southwest-2`
- stsAssumePath：`/v5/agencies/assume-with-oidc`
- durationSeconds：3600
- refreshBufferSeconds：300

### `getCredentials(opts?)`

- 返回：`{ accessKeyId, secretAccessKey, securityToken, expiresAt, expiresIn }`
  - `expiresAt`：ISO 字符串（凭证过期时间）
  - `expiresIn`：剩余有效秒数（使用方据此判断是否强制刷新）
- 行为：
  - 环境变量 `HUAWEICLOUD_OIDC_TOKEN` 存在时作为 OIDC Token 覆盖，便于本地排障与测试。
  - 缓存 + 自动刷新：模块级缓存，临近过期（`refreshBufferSeconds` 提前量）自动重换。
  - `opts.force: true`：强制刷新。
  - 并发去重：同一时刻多个调用只发起一次 STS 换证，其余等待同一结果。

### `configure(overrides)`

- 保留字段：`accountId` / `audience` / `agencyName` / `oidcProviderName` / `region` / `stsAssumePath` / `durationSeconds` / `refreshBufferSeconds`
- 移除字段：`apigHost` / `obsServer` / `obsClientCtor`（属于高层调用配置，方案 A1 不再需要）
- 返回覆盖后的完整配置。

### OIDC Token 来源（自包含）

申请顺序：
1. 环境变量 `HUAWEICLOUD_OIDC_TOKEN`（诊断/测试覆盖）
2. GitHub Actions 环境变量自申请：向 `ACTIONS_ID_TOKEN_REQUEST_URL` 发 GET（带 `audience` 查询参数，`Authorization: Bearer ACTIONS_ID_TOKEN_REQUEST_TOKEN`），解析响应的 `value` 字段

不再依赖 `@actions/core`；日志降级为 `console.log`。库在任意 Node 环境可独立换证。

### 移除项

- `callApig`、`uploadToObs` 全部移除
- `esdk-obs-nodejs` 依赖移除（`shared/package.json` 不再声明）

## V11 签名器（shared/signer-v11.js）

- 从当前库迁出，独立文件，导出 `V11Signer`（`sign(method, url, headers, body)`，返回签名后完整请求头）。
- 严格复刻华为云官方 APIG V11 算法：
  - Credential 作用域 `YYYYMMDD/{region}/apic`（服务名固定 `apic`）
  - HKDF-SHA256 密钥派生（IKM=SK，salt=AK，info=credential_scope）
  - SignedHeaders 为全部请求头（小写、排序），含 host 与 x-sdk-date
- 仅依赖 Node 内置 `crypto` / `url`，无第三方依赖。
- 复用边界：仅适用于 APIG 网关接口；OBS 与云服务 OpenAPI 使用其他签名协议，不通用。

## 插件改动

### deploy-action/index.js（变厚）

- 引入 `getCredentials`、`configure`（薄库）与 `V11Signer`（signer-v11）。
- 内嵌 `sendRequest`（HTTPS 请求）与 APIG 调用逻辑：`GET /version` → 2xx 判成功 → 输出 `deploy-status`。
- 保留精简 APIG 错误排查提示（`APIG.0602` / `0301` / `0624`）。
- 依赖：`@actions/core`（`esdk-obs-nodejs` 无关）。
- `action.yml` 输入输出不变。

### obs-upload-action/index.js（变厚）

- 引入 `getCredentials`、`configure`（薄库）与 `esdk-obs-nodejs`。
- 内嵌 OBS 上传逻辑：参数校验 → `file` 存在走 `SourceFile`，否则 `body` → `putObject` → 解析 ETag 输出。
- 依赖：`@actions/core` + `esdk-obs-nodejs`。
- `action.yml` 输入输出不变。

## 测试方案

| 目录 | 测试内容 | 说明 |
| --- | --- | --- |
| `shared/test/huaweicloud-openlibing-client.test.js` | `getCredentials`：环境变量覆盖 / Actions 自申请 / 缓存复用 / 强制刷新 / `configure` 覆盖 | 保留 HTTPS 拦截器模式，删除 APIG/OBS 用例 |
| `deploy-action/test/deploy-action.test.js` | V11 签名格式 + APIG 调用集成（拦截 HTTPS 请求） | 新文件 |
| `obs-upload-action/test/obs-upload-action.test.js` | OBS 上传成功/失败/参数校验（注入 FakeObsClient） | 新文件 |

- 各插件 `package.json` 的 `test` 脚本指向各自插件测试。
- 测试采用真实执行验证（先回调挂监听再触发 data/end，避免 promise 永不 resolve 的假通过问题）。

## 文件变更清单

- 修改：`shared/huaweicloud-openlibing-client.js`（瘦身为薄库）
- 新建：`shared/signer-v11.js`
- 修改：`shared/package.json`（移除 esdk-obs-nodejs；test 指向薄库测试）
- 修改：`shared/test/huaweicloud-openlibing-client.test.js`（更新为薄库用例）
- 重写：`deploy-action/index.js`（内嵌 sendRequest + APIG 调用，引用 signer-v11）
- 新建：`deploy-action/test/deploy-action.test.js`
- 修改：`deploy-action/package.json`（test 指向插件测试）、`deploy-action/README.md`（目录结构/说明）
- 重写：`obs-upload-action/index.js`（内嵌 OBS 上传逻辑）
- 新建：`obs-upload-action/test/obs-upload-action.test.js`
- 修改：`obs-upload-action/package.json`（test 指向插件测试）
- 重新打包：`deploy-action/dist`、`obs-upload-action/dist`

## 验证方式

- 三个测试套件（薄库 / deploy / obs）全部通过。
- 两个插件 `npm run build` 成功，dist 产物验证：
  - deploy dist：含 signer-v11 与薄库引用（共享文件运行时存在，ncc 外置），不含 esdk-obs-nodejs
  - obs dist：内联 esdk-obs-nodejs，不含 V11 签名器
