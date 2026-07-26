# Nighterminal

一个暗夜毛玻璃风格的 Windows 终端。Tauri 2 + Rust ConPTY 后端，xterm.js 6 前端。

改代码前请先看 [CLAUDE.md](CLAUDE.md)，里面是半透明终端和 ConPTY 的若干非显然约束。

## 运行

```sh
pnpm install
pnpm tauri dev      # 开发
pnpm tauri build    # 打包到 src-tauri/target/release
```

## 功能

- 多标签页，任意嵌套分屏（`Ctrl+Shift+D` 右分 / `Ctrl+Shift+E` 下分，`Alt+方向键` 移焦点）
- 五套暗色主题（暗夜 / 樱花 / 抹茶 / 琥珀 / 霓虹玫瑰），终端调色板与界面辉光整套切换
- 设置面板（`Ctrl+,`），改动即时生效并写入 `config.json`
- 恢复上次会话：标签页、分屏布局、各 pane 的 shell 与工作目录、窗口几何
- Quake 下拉：全局热键从屏幕顶部落下，可设高度与失焦隐藏
- 半透明毛玻璃背景、光标辉光、全屏 TUI 自动让出状态栏

完整说明（界面各部分、设置逐项、会话恢复与 Quake 的细节）见
**[docs/使用说明.md](docs/使用说明.md)**。

## 快捷键

| 组合 | 作用 |
| --- | --- |
| `Ctrl+Shift+T` | 新建标签页 |
| `Ctrl+Shift+D` | 向右分屏 |
| `Ctrl+Shift+E` | 向下分屏 |
| `Ctrl+Shift+W` | 关闭当前 pane（最后一个则关闭标签页） |
| `Alt+方向键` | 切换焦点到相邻 pane |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个标签页 |
| `Ctrl+(Shift+)PageDown` / `Ctrl+(Shift+)PageUp` | 同上 |
| `Ctrl+Alt+1`…`9` | 跳到第 N 个标签页 |
| `Ctrl+Shift+C` | 复制选区 |
| `Ctrl+V` / `Ctrl+Shift+V` | 粘贴 |
| `Ctrl+,` | 打开 / 关闭设置面板 |
| `Esc` | 关闭设置面板（面板未开时交给 shell） |
| 右键 | 有选区则复制，否则粘贴 |
| 中键点击标签 | 关闭该标签 |
| 双击标题栏空白 | 最大化 / 还原 |

`Ctrl+C` 未被拦截，始终作为中断信号送给 shell。快捷键按物理按键位置匹配，换键盘布局不会错位。

## 结构

```
src/                    前端
  theme/nightfall.ts    从 CSS 变量读出 xterm 配色（配色的唯一来源在 styles/）
  config.ts             配置的类型、加载与应用（默认值和边界在 Rust 侧）
  session.ts            Session：终端实例、PTY 连线、cwd 追踪
  layout.ts             分屏二叉树：切分 / 坍缩 / 拖拽分隔条 / 几何寻邻 / 序列化
  workspace.ts          标签页与其中的 pane：生命周期、焦点、快照
  ipc.ts                Rust 命令与事件封装
  ui/settings.ts        设置面板（改动即写盘、即生效）
  ui/tabbar.ts          标签栏（滑动霓虹指示条）
  ui/cursor-glow.ts     光标辉光与拖尾覆盖层
  ui/chrome.ts          无边框窗口按钮
  ui/boot.ts            启动扫描线动画
  styles/base.css       设计令牌 + 背景层
  styles/themes.css     配色主题（每个主题只覆盖与默认不同的令牌）
src-tauri/
  src/pty.rs            ConPTY 会话、UTF-8 边界安全解码、8ms 批量输出
  src/config.rs         config.json：默认值、范围收敛、读写
  src/state.rs          state.json：工作区快照（对 Rust 不透明）
  src/quake.rs          全局热键（Win32 RegisterHotKey）与贴顶下拉
  src/window.rs         亚克力毛玻璃 + DWM 圆角
```

## 改配色

设置面板里可以直接切主题。想调整或新增主题：默认配色在 `src/styles/base.css` 的 `:root` 里，各主题在
`src/styles/themes.css` 里只覆盖与默认不同的令牌；再往 `src/ui/settings.ts` 的主题下拉里加一行选项即可。
`theme/nightfall.ts` 会把当前生效的 CSS 变量读出来喂给 xterm.js，不需要在 TS 里写任何颜色。
注意事项（为什么全是暗色系、哪些令牌必须是纯色值）见 [CLAUDE.md](CLAUDE.md)。

## 配置文件

`%APPDATA%\dev.nighterminal.app\config.json`（设置）与 `state.json`（会话快照）。默认值和取值
范围由 `src-tauri/src/config.rs` 定义，两个文件都可以手改。

## 尚未实现

SSH、标签页拖拽重排、pane 换位、字体连字（需要 `@xterm/addon-ligatures`，它依赖 Node 的字体探测，
浏览器环境下不可用）。
