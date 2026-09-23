# GitHub Release 发布

推送 `v*` 标签会触发 [Release 工作流](../.github/workflows/release.yml)。标签必须等于 `v` 加上 `package.json` 中的版本，例如版本 `0.1.0` 对应标签 `v0.1.0`；不匹配时停止发布。

## 发布流程

1. 更新 `package.json` 版本，将需要发布的代码提交并推送到 GitHub。
2. 在该提交上创建并推送标签，例如：

   ```sh
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin v0.1.0
   ```

3. 在 GitHub Actions 中查看 `Release` 的运行结果。工作流依次执行版本校验、依赖安装、`bun run check`、`bun run test` 和 `bun run test:e2e`，通过后打包已验证的产物并发布 Release。

工作流使用仓库自动提供的 `GITHUB_TOKEN`，声明 `contents: write` 权限，无需额外配置发布密钥。它只发布 GitHub Release，不执行 npm registry 发布。

## 发布附件

| 文件                           | 用途                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `opencode-observer.js`         | 包含第三方运行依赖的单文件插件，可直接放入 OpenCode `plugins/` 目录 |
| `opencode-observer-<版本>.tgz` | npm 格式的包，安装时仍需由包管理器处理依赖                          |
| `SHA256SUMS`                   | 上述两个文件的 SHA-256 校验和                                       |

工作流先创建草稿，上传完全部附件后再公开发布。GitHub 自动生成的源码归档不包含构建产物。

## 预发布与失败重跑

包含预发布标识的版本（例如 `0.2.0-beta.1`）会发布为 GitHub pre-release，不标记为 latest。正式版本由 GitHub 自动判定 latest。

构建或测试失败时不会创建 Release。附件上传或最终发布失败时，可以在 Actions 页面重跑失败的任务；已有草稿会复用，同名附件会替换。已公开发布的 Release 不会被覆盖，需要更新版本并创建新标签。

## 构建环境

工作流运行于 Ubuntu 24.04，Bun 版本读取 `package.json` 的 `packageManager`，并安装 Node.js 24 以支持 OpenCode 的原生依赖安装。

E2E 固定使用 `anomalyco/opencode` 提交 `7565e03536d19e850f9996c407f9bf5e932b5f7a`，不跟随上游分支更新。调整兼容基线时，先使用目标提交运行完整 E2E，再更新工作流中的 `ref` 和本文记录。
