# Nighterminal — 开发提示

半透明终端 + ConPTY 有一批不看代码就想不到的约束。下面每一条都是踩过之后加上的，**改之前先读完对应那节**，否则很容易"顺手简化"掉。

## 1. 不要给 xterm 换回 WebGL 渲染器

`src/theme/nightfall.ts` 的 `RENDERER` 默认是 `"dom"`，这是刻意的。

WebGL 渲染器把字形连同背景一起烘进纹理图集，xterm 官方明确说它不正确支持 `allowTransparency`。在半透明背景下，斜体、dim 这类有独立字形变体的样式会渲染成**文字形状的不透明黑块**（Claude Code 的 `/release-notes for more` 和输入占位符就是这么中招的）。

排查时注意：这类黑块**不是**字符属性画出来的。遍历 `term.buffer.active` 会发现那些单元格全是 `isBgDefault() === true`、`isInverse() === false`。别在转义序列里找原因，是渲染器。

DOM 渲染器在终端这个体量下性能完全够。

## 2. `lineHeight` 必须是 1，`letterSpacing` 必须是 0

同在 `nightfall.ts`。DOM 渲染器铺的是真实字形，多出来的行距或字距会让制表符边框（`│ ─ ┌`）断成虚线 —— TUI 的框会全部裂开。

WebGL 的 `customGlyphs` 会合成这些线条从而掩盖问题，所以这条约束和第 1 条是绑定的：只要用 DOM 渲染器，就不能加行距/字距。

## 3. 内边距只能加在 `.xterm` 上，不能加在 `.pane` 上

FitAddon 算行列数用的是 **父元素的高度** 减去 **`.xterm` 自身的 padding**（`addon-fit` 源码里 `getComputedStyle(element.parentElement)` 配 `getComputedStyle(element).padding-*`）。

所以把内边距写在 `.pane`（父元素）上，FitAddon 完全看不见它 —— 会多算出一行，最底下那行被窗口边缘切掉一半。全屏 TUI 下尤其明显，因为它的状态行就在最后一行。

判断方法：`rows * cell.height` 应该 ≤ `.pane` 内容高减去 `.xterm` 的上下 padding。

## 4. `src/ansi/flatten-bg.ts` 不是多余的

TUI 假设终端不透明，会给高亮片段刷一层自己的背景色。Claude Code 实际发的是 `ESC[48;2;0;0;0m`（真彩色纯黑，**不是** SGR 40，所以调 `theme.black` 没有任何用）。黑底终端上这层填充完全看不见 —— 这正是应用想要的效果；半透明终端上它就变成一块实心黑洞。

这个过滤器把**近中性的深色填充**改写成 SGR 49。判据是"每个通道都够暗 **且** 够接近中性"，所以蓝色选中条 `48;2;38;79;120`、暗红报错条这类**有意为之的颜色一律保留**。改阈值前先跑一遍两类样例。

它带 `carry` 缓冲是必要的：转义序列会被 PTY 的 8ms 批量切断，跨块的 `ESC[48;2;0;0;0m` 不缓冲就漏改。

## 5. ConPTY 的退出检测只能靠进程句柄

`src-tauri/src/pty.rs`：**不要**改回"reader 读到 EOF 就算 shell 退出"。

只要我们还持有 pty，ConPTY 就不会关闭 master 管道，read 会在子进程早就没了之后继续阻塞。所以有一条专门的 waiter 线程 `child.wait()`，`Pump::running` 由它清零。reader 线程结束是因为 session 被 drop（master 关闭），不代表 shell 退出。

Session 里存的是 `ChildKiller` 而不是 `Child`，因为 `Child` 本体被移进了 waiter 线程。

flusher 的退出判定藏在 `attached` 门后面，所以前端从未 attach 就 kill 掉的会话（`start()` 里 `disposed` 早退那条路）要靠 `Pump::closed`（`Session` 的 `Drop` 置位）打断循环，否则留下一条每 8ms 空转到进程退出的线程。

`pty:exit` 事件的 payload 是「退出码是否为 0」。waiter 先 `Release` 写 `exit_ok` 再清 `running`，flusher 观察到 `!running` 后读 `exit_ok` 因而不会读到旧值。前端用它区分 SSH pane 的"连接失败留红字"和"远端正常登出关 pane"——**别改回按耗时猜**：Windows 默认 TCP 连接超时约 21 秒，任何固定宽限期都会把慢失败连同错误信息一起吞掉。本地 shell pane 不用退出码（`exit 1` 是正常退出方式），仍按 1.5s 宽限期判"根本没起来"。

## 6. `pty_attach` 握手不能省

shell 打印提示符可能快过前端 `listen()` 注册完成。Rust 侧先把输出缓冲住，等前端调用 `pty_attach` 再放行，否则首屏输出会丢。

## 7. 配色的唯一来源是 CSS

`src/styles/base.css` 的 `:root` 自定义属性是默认主题，`src/styles/themes.css` 按 `:root[data-theme=…]` 覆盖差异令牌；`theme/nightfall.ts` 用 `getComputedStyle` 读回去构造 xterm 的 `ITheme`。别在 TS 里另写一份颜色常量。

主题相关的三条硬约束：

- **`--term-*` / `--ansi-*` 必须是纯色字面量**（hex 或 rgba）。这些值被 `nightfallTheme()` 读出来交给 xterm 自己解析，xterm 不认 `var()` 间接引用，也不认 `rgb(from …)` 相对色语法 —— 写了不会报错，只会静默变成默认色。界面 CSS 里的派生透明度（`rgb(from var(--accent) r g b / .3)`）不受此限。
- **不要加浅色主题**。`ansi/flatten-bg.ts` 的判据（见第 4 节）建立在"终端底色是暗的"之上：浅底下 TUI 刷的黑色填充会被改写成浅色而前景仍按黑底选色，TUI 刷的浅色填充又不满足暗色阈值直接漏过。浅色主题需要先重写 flatten 判据，是独立工程。
- **主题 id 故意不做白名单**（Rust 侧只 trim + 空值回退）。未知 id 匹配不到任何 CSS 规则，级联自动退回默认主题，坏不了；加一个主题只需要改 `themes.css` 和 `settings.ts` 的下拉两处。

另外主题切换的生效顺序是固定的：`onConfigChange` 里 `applyChrome`（写 `data-theme`）在 `workspace.applySettings()`（`getComputedStyle` 读新值）之前，`getComputedStyle` 会强制同步样式重算，所以读到的一定是新主题。调换这个顺序会读到旧值。

配置里的 `opacity`（玻璃浓度）只以 `--tint-alpha` 内联写入，tint 的**颜色**在 `--tint-term-rgb` 里归主题管 —— 若把整个 `--tint-term` 写成内联样式，会以内联优先级盖掉所有主题。

## 8. 分屏：`.split` 必须自己带 `flex: 1 1 0`

`layout.ts` 的分割树渲染成嵌套 flex 容器。给分割的两个孩子写的是**内联** `flex-grow`（比例条拖动只改这两个数），但**最外层那个 `.split` 自己是 `.layout` 的 flex item**，没人给它写内联样式。

flex item 的 `flex-basis` 默认 `auto`，于是整棵树会缩到文字宽度 —— 表现是分屏后每个 pane 只剩两三列宽，全挤在左边。所以 `term.css` 里 `.split` 的 `flex: 1 1 0` 不能删。

同理 `.pane` 必须有 `min-width: 0; min-height: 0`：flex item 的 `min-size` 默认 `auto`，终端一溢出就会把兄弟挤出容器而不是自己滚动。

## 9. 配置的默认值和边界只在 Rust 里

`src-tauri/src/config.rs` 是唯一定义默认值和取值范围的地方。前端 `config.ts` 只显示和编辑，`updateConfig` 拿回来的是**后端 clamp 过的**值再广播 —— 所以面板不需要草稿态、不需要"应用"按钮，也不可能显示出一个后端会拒绝的值。

配置文件读得很宽松（缺字段用默认、坏 JSON 整个退回默认），因为它是用户可以手改的文件，不该让应用起不来。

`state.json`（会话快照）对 Rust 是**不透明的** `serde_json::Value`：标签页和分屏树是前端概念，让 Rust 认识它的结构只会导致每加一个字段要改两处。前端读回来时必须自己校验（`isLayoutShape` / `readShape`）。

## 10. Quake 热键归线程所有

`src-tauri/src/quake.rs` 用 `RegisterHotKey(NULL, ...)` 而不是插件。hwnd 传 NULL 时注册**属于调用线程**，`WM_HOTKEY` 投递到该线程的消息队列 —— 所以有一条专职线程同时持有注册和消息循环，改绑定是往它 `PostThreadMessageW` 一个 `WM_APP`，而不是在设置面板所在的线程上碰 Win32。

`WM_HOTKEY` 里**不能**直接操作窗口，要 `run_on_main_thread`。

`RegisterHotKey` 的成败只有热键线程自己知道，所以 `arm()` 通过 `Quake::reply` 里的一次性 channel 等它回话（带 500ms 超时兜底），`quake_apply` 才能把"组合键已被占用"如实报给设置面板 —— 别改回"parse 成功就算成功"。注册结果同时存进 `Quake::active`：失焦自动隐藏**只在热键真的注册上了**才执行，否则一个不在任务栏、又没有热键能唤回的隐藏窗口就永久失踪了。`quake_apply` 是 async command，因为同步 command 跑在主线程上，等 channel 会把 UI 卡住。

开启 quake 会给窗口加 `always_on_top` + `skip_taskbar`。调试时注意：这两个 flag 是**运行期设在窗口上的**，config 改回 false 后必须再调一次 `quake_apply` 才会摘掉，否则一个永远置顶的窗口会一直压在桌面上。

## 11. 窗口几何不要在最小化/最大化时记录

最小化的窗口 `outerPosition()` 返回 `(-32000, -32000)`、尺寸是个占位值；最大化的返回整个屏幕。两者存进 `state.json` 下次都会把窗口恢复成废的。`main.ts` 的 `watchGeometry` 因此在这两种状态下直接跳过不记。

## 12. 连字走 character joiner，不是 addon-ligatures

`@xterm/addon-ligatures` 要用 Node 的字体探测，webview 里起不来。所以 `src/ligatures.ts` 维护一份常见连字序列表，经 `registerCharacterJoiner` 把匹配段交给渲染器合并成一个 run；DOM 渲染器把整段放进同一个 span，浏览器排版时字体自己的 calt 就生效了。两个推论：

- 这依赖 DOM 渲染器按 run 排版，与第 1 条（不要换回 WebGL）绑定；
- 字体没有连字时 join 是视觉无操作，所以开关不需要探测字体、也不需要按字体禁用。

顺带：`pty_spawn` 现在接受 `args`，`-NoLogo` 只在**没有显式 args** 时追加 —— SSH pane 的命令行不是我们的，别去动它。ssh 的选项必须排在 destination **之前**传（`ui/connect.ts` 的 `parseSshTarget` 已保证），排在后面会被 OpenSSH 当成远程命令。

## 验证手法

窗口是无边框 + 半透明的，截图有两个坑：

- **别用"截屏幕对应区域"**。Windows 不允许后台进程抢前台，会拍到当时屏幕上的无关内容。用 `PrintWindow` + `PW_RENDERFULLCONTENT`(2) 只抓应用自身像素。
- **截图进程必须先 `SetProcessDPIAware()`**。否则在 150% 缩放下 `GetWindowRect` 返回的是虚拟化(缩小)坐标，而 `PrintWindow` 按物理像素渲染 —— 位图开小了，右侧和底部被静默裁掉。症状极具迷惑性：状态栏"消失"，但 DOM 探针显示它就在原位。
- `PrintWindow` **抓不到 DWM 合成的毛玻璃层**，所以截图里背景总是比实际偏暗偏平。判断毛玻璃是否生效看状态栏右下角（`acrylic` / `mica` / `solid`），别靠肉眼看截图。

想在不抢焦点的前提下触发操作：临时在 `main.ts` 里挂一段带 `setTimeout` 的探针，直接调 `workspace.split()` / `settings.show()` 这些方法，验证完删掉。`SendKeys` 需要窗口在前台，后台进程做不到。

几个具体的坑：

- **往 `Chrome_RenderWidgetHostHWND` PostMessage 鼠标事件时，坐标是 CSS 像素，不是物理像素**。截图是物理像素的，在 150% 缩放下直接拿图上的坐标去点会全部落空 —— 而且落空时画面照样在变（极光在转），很容易误判成"点到了但没反应"。
- 探针的结论**别只靠截图看**。要么 `term.write()` 打进终端里（截图能读到文字），要么 `stateSave()` 写进 `state.json` 从磁盘读 —— 后者在窗口最小化、截不到图时也有效。
- `Get-Process` 的 `MainWindowHandle` 在窗口隐藏/最小化时会指到进程里别的顶层窗口（拿到 237x39 这种尺寸就是它）。要可靠就 `EnumWindows` 按 `cls=Tauri Window` 过滤。
- 全局热键可以用 `keybd_event` 真实注入来测，`RegisterHotKey` 收得到。但**后台进程注入的按键换不来前台焦点**，所以 `toggle` 里"可见且有焦点才隐藏"那条分支测不到，只能看到"落下并置顶"这半边。
