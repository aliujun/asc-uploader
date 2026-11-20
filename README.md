# App Store应用上架助手

Windows 下的 App Store Connect（ASC）IPA 上传工具：本地 Web 界面操作，支持 TestFlight 分发、Build 与版本审核状态查询、描述文件 / 设备管理、iOS 证书（CSR/p12）工具与证书到期提醒，可一键打包为免安装单文件 exe。

- 基于 [App Store Connect API 4.1+](https://developer.apple.com/documentation/appstoreconnectapi) 全新的 `buildUploads` 分块上传接口，不依赖 Xcode、Transporter 或 iTMSTransporter
- 原生 Node.js 实现，无原生编译依赖，`npm install` 即用

## 功能特性

### IPA 上传
- 分块上传 + MD5 校验提交，自动重试（网络抖动 / 5xx / 429 限流）
- 实时进度、逐条任务日志（终端同步输出彩色日志，便于排查）
- 排队 / 准备 / 上传阶段可随时中断；提交校验后自动等待 Apple 校验与 build 处理结果
- 历史任务列表：失败 / 已取消任务可一键重试（复用本地 IPA 缓存）
- 上传前自动预检签名描述文件：已过期 / 开发签名包 / bundleId 与签名 App ID 不匹配直接拦截，签名信息（名称、类型、到期）在上传页可见

### TestFlight 分发
- 上传完成后自动加入指定测试组
- 也可在 Build 列表中手动对任意 build 分发

### Build 状态查询
- 按 App 查看 build 列表（版本、处理状态、上传时间），处理状态中文化展示

### 版本审核状态
- 按 App 查看 App Store 版本列表（版本号、审核状态、创建 / 发布时间），官方全部审核状态中文化
- 统计卡片汇总：审核被拒 / 审核中 / 等待审核 / 待开发者发布 / 已发布

### 描述文件与设备管理
- 描述文件列表（类型 / 状态 / 到期 / 关联证书中文化展示），在线签发 App Store / Ad Hoc / 开发描述文件并下载
- 设备列表查询（名称、UDID、平台、状态）

### 到期提醒
- 启动时自动聚合全部配置的证书与描述文件临期项（剩余 ≤60 天或非 ACTIVE），顶部胶囊提示，可展开统计总览
- 剩余 ≤30 天时弹出浏览器桌面通知（每次会话一次，可手动刷新）

### 版本更新检测
- 启动时检测 GitHub Releases 新版本，页面胶囊提示 + 终端警告输出
- 按运行方式（exe / npm / 源码）自动给出对应的下载或升级命令，可一键复制

### 多 App 配置管理
- 多套 API 密钥（.p8）配置独立管理，弹框编辑、一键验证连通性
- p8 私钥内容脱敏存储，界面不回显

### 证书工具（配合 uniapp / HBuilderX 云打包）
- 生成 RSA 私钥与 CSR（通用名称随机生成，所属项目必填）
- 合成 .p12：私钥与 .cer 自动配对校验，采用**传统 PBE-SHA1-3DES 格式**（HBuilderX 云打包兼容，openssl v3 的现代格式会被 HBuilderX 拒绝）
- 导入已有 .p12 提取私钥（不填密码默认 `123456`），支持开发/发布双证书复用同一私钥
- 合成 .p12 后自动备份到数据目录 `backups` 文件夹（按 `配置名_类型_时间戳` 命名），误删不慌

### 网络与调试
- 代理设置（全局生效，含分块上传），常见代理端口一键自动检测（Clash / v2rayN / Fiddler 等）
- 连通性测试：可视化检测 Apple 各服务可达性
- 终端彩色日志：每次 ASC 请求的完整轨迹（方法、路径、耗时、原始错误响应）

## 快速开始（三选一）

### 方式一：npx 一行命令运行（推荐，需 Node.js ≥ 20）

```bash
npx asc-uploader
```

首次运行自动下载，之后走本地缓存；升级执行 `npx asc-uploader@latest`。全局安装后可用简写命令：

```bash
npm i -g asc-uploader
asc-up
```

### 方式二：源码运行

```bash
git clone https://github.com/aliujun/asc-uploader.git
cd asc-uploader
npm install
npm start
```

### 方式三：免安装单文件 exe（无需 Node.js）

从 [Releases](../../releases) 页面下载 `AppStore.exe`，双击即可运行，完全离线，适合分发给未安装 Node.js 环境的同事。

启动后自动打开浏览器（默认 `http://localhost:8380`，端口被占自动顺延）。

### 命令行选项

三种运行方式（npx / 全局命令 / exe）均支持：

| 选项 | 说明 |
| --- | --- |
| `--port <n>` | 指定起始端口（默认 8380，被占自动顺延） |
| `--no-open` | 启动后不自动打开浏览器（远程 / 服务器场景） |
| `-h, --help` | 显示帮助 |
| `-v, --version` | 显示版本号 |

例如：`npx asc-uploader --port 9000 --no-open`

## 使用说明

### 1. 创建 API 密钥

在 [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api) 创建团队密钥，获得 **Key ID**、**Issuer ID** 和 **.p8 私钥文件**（密钥只能下载一次，请妥善保存）。

### 2. 添加配置

进入「配置管理」→ 新增配置，填入配置名称、Issuer ID、Key ID 与 .p8 私钥内容，点击「验证」确认可用。

### 3. 上传 IPA

进入「上传」页，拖拽或点击选择 .ipa 文件（自动解析 bundleId 与版本号），选择配置，按需勾选「自动加入 TestFlight 测试组」，提交任务后在「任务进度」中观察各阶段状态与日志。

### 4. 证书工具（可选）

进入「证书工具」，按引导生成 CSR → 到 [Apple 开发者后台](https://developer.apple.com/account/resources/certificates/list) 签发 .cer → 回到工具合成 .p12，直接用于 HBuilderX 云打包。

## 数据与安全

所有本地数据（配置索引、p8 密钥、私钥、IPA 缓存、任务记录）存放在用户目录下的数据目录中（界面「配置管理」页可查看具体路径）。`.p8` / `.p12` / `.ipa` 等敏感文件均已加入 `.gitignore`，请勿将数据目录提交到仓库。

## 常见问题

| 问题 | 说明 |
| --- | --- |
| 直连 Apple 失败 / 请求超时 | 国内网络环境请在「配置管理」页配置代理，可点「自动检测」探测本机代理端口 |
| `409 The bundle version must be higher than the previously uploaded version` | build 号不高于账号下已有版本，请在打包工具中递增版本号后重新打包上传 |
| HBuilderX 云打包报 `import failed` / `read key failed` | 使用本工具合成的 .p12（传统 3DES 格式）即可避免；确认 .cer 与私钥是同一 CSR 配对签发 |
| Apple 校验 / build 处理需要多久 | 通常几分钟内，个别高峰期可能更久；工具会自动轮询并在完成后提醒 |

## 开发

```bash
npm start    # 启动（src/index.js）
npm run pkg  # 打包 Windows 单文件 exe（dist/AppStore应用上架助手.exe）
```

### 发版流程备忘

1. `npm version patch`（或 minor / major）递增版本号并生成 tag
2. `npm publish` 发布到 npm（npx 通道生效）
3. `npm run pkg` 打包 exe，随 tag 上传到 GitHub Releases（exe 通道）

技术栈：Node.js 原生 `fetch` / `undici`（代理与分块上传）、`node-forge`（证书与描述文件解析）、`express`（本地服务）、`yauzl`（IPA 解析）、`bplist-parser`（签名信息解析）。前端为原生 HTML/CSS/JS 单页实现，无构建步骤。

## 许可证

[MIT](./LICENSE)
