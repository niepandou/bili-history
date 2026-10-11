# B站历史记录仪

自动记录并归类你的 B 站观看历史，带统计图表、关键词分类规则和数据导出。

**两种形态：**

| 形态 | 说明 | 独立性 |
| --- | --- | --- |
| 💻 电脑桌面端 | 无地址栏的独立应用窗口，左侧导航 + 三栏布局 | 数据存本机 SQLite |
| 📱 手机独立版 | 可安装的 Android APK，底部三标签 | 数据存手机 IndexedDB，**完全不依赖电脑** |

---

## 🧠 关于本项目：纯 AI 搭建

> **本项目 100% 由 AI（WorkBuddy / CodeBuddy）搭建，没有任何人工手写的代码行。**
>
> 从架构设计、代码编写、接口逆向、Bug 定位到桌面客户端调优、Android 打包，
> 全部由 AI 在一次次对话迭代中完成——包括 WBI 签名算法从 Python 到 JavaScript 的移植、
> 桌面端"打开就卡死"的根因定位、以及 Capacitor 工程的搭建与 APK 构建。
>
> 使用者只需提出需求、描述现象、反馈问题，其余工作均由 AI 承担。
> 如果你也在做类似的事，希望这个项目能证明：**不懂编程，也能拥有一个真正可用的软件。**

---

## ✨ 功能一览

### 概览
- 四项核心统计：观看次数 / 视频数 / UP 主数 / 分区数
- 分类观看占比环图（点图例可直接跳到该分类的视频）
- 近 30 天观看趋势柱状图
- 24 小时观看时段分布
- 常看 UP 主 Top 6

### 视频
- 分类筛选胶囊 + 关键词搜索（标题 / UP 主 / 分区）+ 三种排序
- 按 BV 号聚合：同一个视频看过的次数、最近观看时间一目了然
- 手动改分类（改后锁定 🔒，不会被自动规则覆盖）
- 点击标题跳转 B 站原视频

### 我的 / 设置
- **同步观看历史**：增量写入，重复同步不会产生重复条目
- **扫码登录**（手机端）/ **粘贴 Cookie**（两端通用）
- **补齐分区**：对缺少分区信息的稿件补拉详情接口（有限速）
- **自定义关键词规则**：任意关键词 → 任意分类，优先级高于内置词典
- **重算全部分类**：改完规则即时刷新历史数据
- **导出 / 导入**：CSV、JSON 备份，手机端导出的是完整备份（含规则与手动分类）

---

## 🏗️ 基于什么制作

### 电脑端
| 组成 | 技术 |
| --- | --- |
| 后端服务 | **Python 3 标准库**（`http.server`）——零第三方依赖 |
| 数据存储 | **SQLite**（WAL 模式，按线程独立连接） |
| 前端界面 | **原生 HTML + CSS + JavaScript**，无框架、无构建步骤 |
| 桌面窗口 | **Edge / Chrome `--app` 应用窗口**（无地址栏 / 无标签页） |
| 数据来源 | B 站 Web 端接口 + **WBI 签名**（`w_rid` / `wts`） |

> 桌面端最初用 pywebview + WebView2 宿主，但消息泵不稳定、长时间运行会整体无响应，
> 已改为浏览器 `--app` 窗口模式并关闭 Chromium 后台节流（`--native` 仍可切换回旧链路）。

### 手机独立版（APK）
| 组成 | 技术 |
| --- | --- |
| App 外壳 | **Capacitor 8** + Android Gradle（AGP 8.13 / Gradle 8.14） |
| 原生网络层 | **CapacitorHttp** —— 走原生 HTTP，**绕开浏览器跨域限制**，直连 `api.bilibili.com` |
| 数据存储 | **IndexedDB**（手机本地，四张对象仓库） |
| 界面 | 与桌面端同风格的原生 JS + 移动优先 CSS |
| 算法移植 | 分类引擎、WBI 签名从 Python **完整移植为 JavaScript** |
| 扫码登录 | B 站 passport 二维码接口 + `qrcode-generator` 本地渲染 |

**为什么手机端必须打包成 APK？**
B 站接口 `api.bilibili.com` / `passport.bilibili.com` **不允许浏览器跨域**（实测 GET 返回 403 且无 `Access-Control-Allow-Origin`），
纯 PWA / 网页版在手机浏览器里无论怎么配 Cookie 都直连不了。
只有打包成 APK、通过 Capacitor 的原生 HTTP 通道发起请求，才能真正脱离电脑端独立同步。

---

## 🚀 快速开始

### 电脑桌面端
```bash
install.bat          # 首次使用：创建 .venv 并安装（约 1 分钟）
启动客户端.bat        # 日常：双击即开（或用桌面 / 开始菜单快捷方式）
```

命令行用法：
```bash
python client.py                     # 应用窗口（默认 1440x920）
python client.py --devtools          # 带开发者工具
python client.py --width 1600 --height 1000
python client.py --chrome            # 用 Chrome 而非 Edge 开窗口
python client.py --install-shortcut  # 重建桌面 / 开始菜单快捷方式
```

客户端会自动拉起本地服务；若发现端口被僵尸进程占着，会先清理再重启，避免白屏或读到旧版本。

### 手机独立版
1. 把 **`B站历史记录仪-手机版.apk`** 发到手机安装（提示"未知来源"允许即可；这是测试签名包）
2. 打开 App，**扫码登录**（推荐）或粘贴 Cookie
3. 点右上角「同步」，数据即写入手机本地

```bash
# 改了网页端源码后一键重打包
mobile-app\重新打包.bat
```

> 手机端详细操作见 `手机版使用说明.txt`。

---

## 🔑 获取 Cookie

1. 浏览器登录 `bilibili.com`
2. F12 → Network → 任选一个 `api.bilibili.com` 请求
3. Request Headers → 复制整行 `Cookie`（需含 `SESSDATA`）
4. 粘贴到 App / 设置里，点「立即同步」

`SESSDATA` 仅用于读取**你自己的**观看历史，只存在本机（电脑 SQLite / 手机 IndexedDB），**不会上传到任何第三方服务器**。过期后重新登录即可。

---

## 🗂️ 分类逻辑

优先级从高到低：

1. **手动锁定** —— 手动选过分类的视频，永远保持
2. **自定义关键词规则** —— 用户添加，最长关键词优先
3. **内置标题关键词词典** —— 约 200 条，覆盖编程 / 考研 / 游戏名 / 硬件型号 / 生活等
4. **B 站原始分区映射** —— 60+ 分区名 → 16 个一级分类
5. **兜底「其他」**

内置 16 个一级分类，且**电脑端与手机端共用同一套判定逻辑**（Python 版本与 JavaScript 版本行为完全对齐）。

---

## 📁 目录结构

```
bili-history/
  client.py              桌面客户端（应用窗口 / 服务自愈 / 参数调优）
  server.py              HTTP 服务与路由（纯标准库）
  app_core/
    config.py            路径与运行时配置
    store.py             SQLite 数据层（按线程连接 + WAL）
    bilibili.py          B站接口与 WBI 签名
    classifier.py        分类引擎（Python 版）
    system.py            自启动 / 局域网地址 / 数据迁移
    demo.py              演示数据
  web/
    index.html  style.css  app.js      电脑端界面
    mobile.html  mobile.css  mobile.js 手机端界面
    lib/
      classifier.js      分类引擎（JS 移植版）
      bili.js            B站接口客户端（原生 HTTP + WBI 签名）
      db.js              IndexedDB 数据层与统计
      md5.js             MD5 实现（WBI 签名用）
      qrcode-generator.js 二维码生成
    sw.js  manifest.webmanifest  icons/
  tools/make_icons.py    图标生成（纯标准库生成 PNG/ICO）
  mobile-app/            Capacitor 工程（APK 打包）
    capacitor.config.json  sync-web.js  重新打包.bat
    android/             Gradle Android 工程
  B站历史记录仪-手机版.apk   成品 APK（4.1 MB）
  install.bat            创建虚拟环境并安装
  启动客户端.bat          电脑端入口
  启动服务.bat            只跑后台服务
  创建桌面快捷方式.bat     重建快捷方式
  runtime.json           当前数据目录指针
```

**数据保存位置**
- 电脑：`%LOCALAPPDATA%\BiliHistory`（macOS `~/Library/Application Support/BiliHistory`，Linux `~/.local/share/bili-history`）
- 手机：App 私有目录下的 IndexedDB，**卸载 App 前记得先导出备份**

---

## ⚠️ 已知限制

- B 站历史 cursor 接口每页上限 **30 条**，历史量大会分页拉取（已内置限速间隔）
- 触发风控返回 `-412 / -352` 时，请降低同步频率或改用扫码登录获取完整 Cookie
- 手机 APK 为 **debug 签名**，安装时系统会提示"未经安全检测"，属正常现象
- 桌面端 `--native`（pywebview）链路稳定性较差，不建议日常使用

---

## 📄 说明

本项目为个人学习 / 自用用途，与 Bilibili 官方无关。功能实现基于 B 站公开 Web 接口，仅读取用户本人的观看历史数据。

**再次声明：本项目全部代码由 AI 生成，非人工编写。**
