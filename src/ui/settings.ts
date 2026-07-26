/**
 * Settings panel.
 *
 * Every control writes straight through `updateConfig`, which persists to disk
 * and republishes the *clamped* value — so there is no apply button, no local
 * draft state, and no way for the panel to display a value the backend would
 * have rejected. Rebuilding the rows after each change is cheap (a few dozen
 * nodes) and keeps that guarantee obvious.
 */

import { config, updateConfig, type Config } from "../config";
import { configPath, quakeApply, stateClear } from "../ipc";

/** Shared with the startup path, which hits the same failure before the panel
 *  has ever been opened. */
export const HOTKEY_WARNING = "热键无法注册：组合键无效或已被其它程序占用";

type Row =
  | { kind: "text"; label: string; hint?: string; get(c: Config): string; set(v: string): Partial<Config>; placeholder?: string }
  | { kind: "number"; label: string; hint?: string; min: number; max: number; step: number; get(c: Config): number; set(v: number): Partial<Config> }
  | { kind: "range"; label: string; hint?: string; min: number; max: number; step: number; get(c: Config): number; format(v: number): string; set(v: number): Partial<Config> }
  | { kind: "toggle"; label: string; hint?: string; get(c: Config): boolean; set(v: boolean): Partial<Config> }
  | { kind: "select"; label: string; hint?: string; options: [string, string][]; get(c: Config): string; set(v: string): Partial<Config> }
  | { kind: "hotkey"; label: string; hint?: string; get(c: Config): string; set(v: string): Partial<Config> };

interface Section {
  title: string;
  rows: Row[];
}

const SECTIONS: Section[] = [
  {
    title: "外观",
    rows: [
      {
        kind: "select",
        label: "主题",
        hint: "配色整套切换，包括终端调色板与辉光",
        options: [
          ["nightfall", "暗夜"],
          ["sakura", "樱花"],
          ["matcha", "抹茶"],
          ["amber", "琥珀"],
          ["neon-rose", "霓虹玫瑰"],
        ],
        get: (c) => c.theme,
        set: (v) => ({ theme: v }),
      },
      {
        kind: "text",
        label: "字体",
        hint: "CSS font-family 写法，逗号分隔的回退链",
        get: (c) => c.fontFamily,
        set: (v) => ({ fontFamily: v }),
        placeholder: '"Cascadia Code", Consolas, monospace',
      },
      {
        kind: "number",
        label: "字号",
        min: 6,
        max: 40,
        step: 0.5,
        get: (c) => c.fontSize,
        set: (v) => ({ fontSize: v }),
      },
      {
        kind: "range",
        label: "玻璃浓度",
        hint: "终端表层的染色深浅，越低越透",
        min: 0,
        max: 1,
        step: 0.02,
        get: (c) => c.opacity,
        format: (v) => `${Math.round(v * 100)}%`,
        set: (v) => ({ opacity: v }),
      },
      {
        kind: "toggle",
        label: "极光背景",
        get: (c) => c.aurora,
        set: (v) => ({ aurora: v }),
      },
      {
        kind: "toggle",
        label: "光标辉光",
        get: (c) => c.cursorGlow,
        set: (v) => ({ cursorGlow: v }),
      },
      {
        kind: "toggle",
        label: "启动动画",
        get: (c) => c.bootAnimation,
        set: (v) => ({ bootAnimation: v }),
      },
    ],
  },
  {
    title: "终端",
    rows: [
      {
        kind: "select",
        label: "光标样式",
        options: [
          ["block", "方块"],
          ["bar", "竖线"],
          ["underline", "下划线"],
        ],
        get: (c) => c.cursorStyle,
        set: (v) => ({ cursorStyle: v as Config["cursorStyle"] }),
      },
      {
        kind: "toggle",
        label: "光标闪烁",
        get: (c) => c.cursorBlink,
        set: (v) => ({ cursorBlink: v }),
      },
      {
        kind: "number",
        label: "回滚行数",
        min: 0,
        max: 500_000,
        step: 1000,
        get: (c) => c.scrollback,
        set: (v) => ({ scrollback: Math.round(v) }),
      },
      {
        kind: "text",
        label: "默认 shell",
        hint: "留空则依次探测 pwsh、powershell、cmd",
        placeholder: "自动",
        get: (c) => c.shell ?? "",
        set: (v) => ({ shell: v.trim() === "" ? null : v.trim() }),
      },
      {
        kind: "text",
        label: "起始目录",
        hint: "留空则用用户主目录",
        placeholder: "自动",
        get: (c) => c.cwd ?? "",
        set: (v) => ({ cwd: v.trim() === "" ? null : v.trim() }),
      },
    ],
  },
  {
    title: "行为",
    rows: [
      {
        kind: "toggle",
        label: "恢复上次会话",
        hint: "记住标签页与分屏布局，以及各自的工作目录",
        get: (c) => c.restoreSession,
        set: (v) => ({ restoreSession: v }),
      },
    ],
  },
  {
    title: "Quake 下拉",
    rows: [
      {
        kind: "toggle",
        label: "启用全局热键",
        hint: "窗口置顶、不占任务栏，按热键从屏幕顶部落下",
        get: (c) => c.quakeEnabled,
        set: (v) => ({ quakeEnabled: v }),
      },
      {
        kind: "hotkey",
        label: "热键",
        hint: "点一下再按组合键；必须含 Ctrl / Alt / Shift / Win",
        get: (c) => c.quakeHotkey,
        set: (v) => ({ quakeHotkey: v }),
      },
      {
        kind: "range",
        label: "下拉高度",
        min: 0.2,
        max: 1,
        step: 0.05,
        get: (c) => c.quakeHeight,
        format: (v) => `${Math.round(v * 100)}%`,
        set: (v) => ({ quakeHeight: v }),
      },
      {
        kind: "toggle",
        label: "失焦自动隐藏",
        get: (c) => c.quakeHideOnBlur,
        set: (v) => ({ quakeHideOnBlur: v }),
      },
    ],
  },
];

/** Config keys the native layer has to be told about after they change. */
const QUAKE_KEYS: (keyof Config)[] = [
  "quakeEnabled",
  "quakeHotkey",
  "quakeHeight",
  "quakeHideOnBlur",
];

export class SettingsPanel {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly note: HTMLDivElement;
  private open = false;

  constructor(host: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "settings";
    this.root.setAttribute("aria-hidden", "true");
    this.root.innerHTML =
      '<div class="scrim"></div>' +
      '<section class="sheet" role="dialog" aria-label="设置">' +
      '<header><h2>设置</h2><button class="close" aria-label="关闭">✕</button></header>' +
      '<div class="body"></div>' +
      '<footer><span class="note"></span></footer>' +
      "</section>";
    host.appendChild(this.root);

    this.body = this.root.querySelector(".body") as HTMLDivElement;
    this.note = this.root.querySelector(".note") as HTMLDivElement;

    this.root.querySelector(".scrim")?.addEventListener("click", () => this.hide());
    this.root.querySelector(".close")?.addEventListener("click", () => this.hide());

    void configPath().then((path) => {
      // Don't clobber a warning that landed before this round trip finished
      // (startup hotkey registration failing is exactly that case).
      if (this.root.classList.contains("warned")) return;
      this.note.textContent = path;
      this.note.title = path;
    });
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.render();
    this.root.classList.add("on");
    this.root.setAttribute("aria-hidden", "false");
  }

  hide(): void {
    this.open = false;
    this.root.classList.remove("on");
    this.root.setAttribute("aria-hidden", "true");
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Persist, then re-render so clamped values land back in the inputs. */
  private async commit(patch: Partial<Config>): Promise<void> {
    await updateConfig(patch);
    if (QUAKE_KEYS.some((key) => key in patch)) {
      const ok = await quakeApply();
      this.warn(ok ? null : HOTKEY_WARNING);
    }
    if (patch.restoreSession === false) await stateClear();
    this.render();
  }

  /** Show a red warning in the footer, or clear it back to the config path.
   *  Public: startup also lands here when its hotkey registration fails. */
  warn(message: string | null): void {
    this.root.classList.toggle("warned", message !== null);
    if (message !== null) {
      this.note.textContent = message;
      return;
    }
    void configPath().then((path) => {
      // A warning may have landed while this round trip was in flight; the
      // path must not overwrite it (checked at resolve time, not call time).
      if (this.root.classList.contains("warned")) return;
      this.note.textContent = path;
    });
  }

  private render(): void {
    const settings = config();
    this.body.replaceChildren(
      ...SECTIONS.map((section) => this.renderSection(section, settings)),
    );
  }

  private renderSection(section: Section, settings: Config): HTMLElement {
    const block = document.createElement("div");
    block.className = "group";
    const title = document.createElement("h3");
    title.textContent = section.title;
    block.append(title, ...section.rows.map((row) => this.renderRow(row, settings)));
    return block;
  }

  private renderRow(row: Row, settings: Config): HTMLElement {
    const line = document.createElement("label");
    line.className = `row ${row.kind}`;

    const text = document.createElement("div");
    text.className = "text";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.label;
    text.append(name);
    if (row.hint !== undefined) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = row.hint;
      text.append(hint);
    }

    line.append(text, this.renderControl(row, settings));
    return line;
  }

  private renderControl(row: Row, settings: Config): HTMLElement {
    switch (row.kind) {
      case "text": {
        const input = document.createElement("input");
        input.type = "text";
        input.value = row.get(settings);
        if (row.placeholder !== undefined) input.placeholder = row.placeholder;
        // On `change`, not `input`: committing per keystroke would respawn
        // nothing but would write the file on every character.
        input.addEventListener("change", () => void this.commit(row.set(input.value)));
        return input;
      }
      case "number": {
        const input = document.createElement("input");
        input.type = "number";
        input.min = String(row.min);
        input.max = String(row.max);
        input.step = String(row.step);
        input.value = String(row.get(settings));
        input.addEventListener("change", () => {
          const value = Number(input.value);
          if (Number.isFinite(value)) void this.commit(row.set(value));
        });
        return input;
      }
      case "range": {
        const wrap = document.createElement("span");
        wrap.className = "slider";
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(row.min);
        input.max = String(row.max);
        input.step = String(row.step);
        input.value = String(row.get(settings));
        const read = document.createElement("span");
        read.className = "readout";
        read.textContent = row.format(row.get(settings));
        // Live feedback while dragging; only the release writes to disk.
        input.addEventListener("input", () => {
          read.textContent = row.format(Number(input.value));
        });
        input.addEventListener("change", () => void this.commit(row.set(Number(input.value))));
        wrap.append(input, read);
        return wrap;
      }
      case "toggle": {
        const button = document.createElement("button");
        button.className = "switch";
        button.type = "button";
        const on = row.get(settings);
        button.setAttribute("role", "switch");
        button.setAttribute("aria-checked", String(on));
        button.classList.toggle("on", on);
        button.addEventListener("click", () => void this.commit(row.set(!on)));
        return button;
      }
      case "select": {
        const select = document.createElement("select");
        for (const [value, label] of row.options) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          select.append(option);
        }
        select.value = row.get(settings);
        select.addEventListener("change", () => void this.commit(row.set(select.value)));
        return select;
      }
      case "hotkey": {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "hotkey";
        input.readOnly = true;
        input.value = row.get(settings);
        input.addEventListener("focus", () => {
          input.value = "按下组合键…";
        });
        input.addEventListener("blur", () => {
          input.value = row.get(config());
        });
        input.addEventListener("keydown", (event) => {
          event.preventDefault();
          // The combination being recorded must not double as a live shortcut —
          // capturing Ctrl+Shift+T should not also open a tab.
          event.stopPropagation();
          if (event.key === "Escape" && describeAccelerator(event) === null) {
            input.blur(); // bare Escape cancels the recording
            return;
          }
          const accelerator = describeAccelerator(event);
          if (accelerator === null) return;
          input.blur();
          void this.commit(row.set(accelerator));
        });
        return input;
      }
    }
  }
}

/**
 * Builds a `Ctrl+Shift+K`-style string from a key event, matching what
 * `quake::parse` on the Rust side understands. Returns null while only
 * modifiers are held, so the combination can still be completed.
 */
function describeAccelerator(event: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Win");
  if (parts.length === 0) return null;

  const key = event.key;
  if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") {
    return null;
  }
  // `event.key` carries the shifted character (`~` for Shift+`), which would
  // not survive the round trip; `event.code` names the physical key.
  const named = keyFromCode(event.code) ?? (key.length === 1 ? key : null);
  if (named === null) return null;
  parts.push(named);
  return parts.join("+");
}

function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return digit[1];
  const fn = /^(F[0-9]{1,2})$/.exec(code);
  if (fn !== null) return fn[1];
  const punctuation: Record<string, string> = {
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Space: "Space",
    Escape: "Escape",
    Tab: "Tab",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  return punctuation[code] ?? null;
}
