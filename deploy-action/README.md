# Deploy Action

一个通过 **OIDC 联邦认证**调用华为云 APIG 的 GitHub Action。使用者只需提供华为云账号 ID 与业务参数，无需配置任何密钥（零 Secret 引用），安全防线完全由华为云信任策略中的 `oidc:sub` 条件保障。

## 特性

- 自动完成 GitHub OIDC JWT 申请 → STS `AssumeAgencyWithOIDC` 换临时 AK/SK/SecurityToken → APIG HMAC-SHA256 签名调用全流程
- 临时凭证缓存复用，临近过期自动刷新
- 使用者零配置密钥，无需感知任何 APIG 细节

## 使用方式

在用户仓库的 workflow 中引用：

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy app
        uses: your-org/deploy-action@v1
        id: deploy
        with:
          huawei-account-id: "12345678901234567890"
      - name: Show result
        run: echo "Status: ${{ steps.deploy.outputs.deploy-status }}"
```

完整示例见 [`example-workflow.yml`](./example-workflow.yml)。

### 输入参数

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `huawei-account-id` | 否 | `4d29a984c4fe4e6eb5d404a853d0084e` | 华为云账号 ID（不填时使用插件默认值；区域自动从 APIG 域名解析） |

### 输出参数

| 输出 | 说明 |
| --- | --- |
| `deploy-status` | 部署状态（`success` / `failed`） |

## 华为云侧一次性配置（管理员）

首次使用前，需由华为云管理员完成以下配置，名称必须严格一致：

| 资源 | 固定名称 |
| --- | --- |
| OIDC 身份提供商 | `GitHubActions`（URL: `https://token.actions.githubusercontent.com`） |
| OIDC 受众 | `huawei-cloud-oidc` |
| 信任委托 | `github-actions-deploy` |
| 身份策略 | `APIG FullAccess` 或只读自定义策略（如 `apig-readonly-minimal`） |

信任策略中**必须**配置 `oidc:sub` 条件，将换取凭证的权限限定到使用者的具体仓库与分支，例如：

```json
{
  "oidc:sub": ["repo:your-org/your-repo:ref:refs/heads/main"]
}
```

APIG 上的目标 API 需以 **IAM 认证**方式创建并发布到 **RELEASE** 环境。

## 本地开发

```bash
npm install
npm run build          # 用 @vercel/ncc 编译生成 dist/index.js
npm test               # 运行单元测试
```

## 发布

```bash
git add action.yml index.js src/ apig_sdk/ dist/ package.json
git commit -m "feat: initial release with OIDC auth"
git push origin main
git tag v1.0.0 && git push origin v1.0.0
git tag v1 && git push origin v1   # 可选：major tag 方便用户引用 @v1
```

## 目录结构

```
deploy-action/
├── action.yml                 # Action 声明文件
├── index.js                   # 主入口（业务逻辑）
├── package.json
├── src/
│   └── huaweicloud-client.js  # 华为云封装模块
├── apig_sdk/
│   └── signer.js              # 华为云签名 SDK
└── dist/
    └── index.js               # 编译产物（发布用）
```
