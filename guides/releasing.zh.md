# 发布维护

[返回首页](../README.zh.md) · [English](releasing.md)

本项目以 npm 包 `dsh-lark-claw` 发布。包内的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，因此发布后可以直接安装进 dsh profile：

```sh
dsh plugin --profile feishu add dsh-lark-claw
```

## 发布前检查

本地执行完整门禁：

```sh
pnpm install --frozen-lockfile
pnpm run release:check
```

`release:check` 会依次执行类型检查、测试、lint、构建、bundle 元数据检查、tarball 内容检查，并把 tarball 安装到临时 dsh profile 中验证组合和模块加载。烟雾测试会通过 pnpm 下载或复用缓存中的 `@deepseek-ai/dsh@0.1.2-rc.1` 与 profile 依赖，不会读取或修改本机现有的 `$DSH_HOME`。

如需手动查看包内容：

```sh
npm pack --dry-run
```

## 首次发布

截至首版基建落地时，npm 上还没有 `dsh-lark-claw`。包所有者需要先登录 npm，并确认包名仍可用：

```sh
npm login
npm whoami
npm view dsh-lark-claw
pnpm run release:check
npm publish --ignore-scripts --access public
```

`npm view` 在首次发布前应返回 404。若包名已被占用，应先修改 `package.json` 中的包名和所有 `dsh-lark-claw/*` 模块引用，不能发布到不受控制的包名下。

首次发布成功后，在 npm 包设置中添加 Trusted Publisher：

- Provider：GitHub Actions
- Organization or user：`Illuminated2020`
- Repository：`dsh-lark-claw`
- Workflow filename：`publish.yml`
- Environment：`npm`
- Allowed action：`npm publish`

仓库的发布工作流使用 OIDC，不需要保存长期有效的 `NPM_TOKEN`。npm Trusted Publishing 要求 GitHub 托管 runner、Node.js `22.14.0` 或更高版本，以及 npm CLI `11.5.1` 或更高版本；工作流固定安装 npm `11.19.1`。

## 后续发版

1. 用 `pnpm version` 更新包版本，再同步插件清单。
2. 执行 `pnpm run release:check`。
3. 提交并推送改动。
4. 创建并推送与版本完全一致的标签，例如 `v0.1.1`。
5. 在 GitHub 上基于该标签发布 Release。

`publish.yml` 会检出 Release 标签，确认对应提交已进入 `main`，核对标签、包版本和 prerelease 状态，重新执行完整门禁，再发布 npm 包。正式 Release 使用 `latest` 标签；标记为 prerelease 的 GitHub Release 使用 `next` 标签。

例如：

```sh
pnpm version patch --no-git-tag-version
pnpm run version:sync
pnpm run release:check
git add package.json dsh.plugin.json
git commit -m "chore(release): v0.1.1"
git tag v0.1.1
git push origin main v0.1.1
```

最后在 GitHub 中创建 `v0.1.1` Release。不要重复发布已存在的版本；npm 的版本不可覆盖。

## 工作流职责

`.github/workflows/ci.yml` 在 pull request、`main` 分支更新和手动触发时运行，覆盖 Node.js `22.19.0` 与 Node.js 24。Node.js 24 任务额外检查 tarball，并执行 dsh 安装烟雾测试。

`.github/workflows/publish.yml` 只在 GitHub Release 发布后运行。它使用 `id-token: write` 获取短期 OIDC 凭据，不接触 npm 长期 token。GitHub Environment `npm` 可以配置必需审核人，作为正式发布前的人工门禁。

如果发布任务报 `ENEEDAUTH`，先检查 npm Trusted Publisher 中的仓库名、工作流文件名和 Environment 是否与上述值完全一致。

## 参考

- [dsh 官方打包与安装插件指南](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)
- [dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
