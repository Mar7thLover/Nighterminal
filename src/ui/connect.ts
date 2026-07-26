/**
 * SSH quick-connect prompt.
 *
 * Deliberately a thin front for the system OpenSSH client (`ssh.exe`, shipped
 * with Windows 10+): keys, agent, known_hosts and ~/.ssh/config all behave
 * exactly as they do on the command line, and this app carries no crypto code
 * of its own. The prompt just turns "user@host:port -i key" into an argv and
 * opens a tab running it.
 */

/**
 * `[user@]host[:port] [extra ssh options…]` -> argv for ssh, or null when
 * there is nothing usable. Options are placed *before* the destination —
 * OpenSSH reads anything after the destination as a remote command.
 */
export function parseSshTarget(text: string): string[] | null {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const [first, ...rest] = tokens;
  if (first.startsWith("-")) return null; // options without a destination

  let target = first;
  const options: string[] = [];
  // A trailing `:digits` is a port only when it is the *sole* colon — an IPv6
  // literal (`::1`, `user@2001:db8::7`) ends in digit groups too, and slicing
  // one off would mangle the address. Those pass through whole; their port,
  // if any, is written the OpenSSH way (-p).
  const colon = first.lastIndexOf(":");
  if (
    colon > 0 &&
    !first.slice(0, colon).includes(":") &&
    /^\d{1,5}$/.test(first.slice(colon + 1))
  ) {
    target = first.slice(0, colon);
    options.push("-p", first.slice(colon + 1));
  }
  return [...options, ...rest, target];
}

export class ConnectPrompt {
  private readonly root: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private open = false;

  constructor(
    host: HTMLElement,
    private readonly onConnect: (args: string[]) => void,
    private readonly onDismiss?: () => void,
  ) {
    this.root = document.createElement("div");
    this.root.id = "connect";
    this.root.setAttribute("aria-hidden", "true");
    this.root.innerHTML =
      '<div class="scrim"></div>' +
      '<div class="box" role="dialog" aria-label="SSH 连接">' +
      "<h2>SSH 连接</h2>" +
      '<input type="text" spellcheck="false" ' +
      'placeholder="user@host[:port] [其它 ssh 参数]" />' +
      '<div class="hint">回车连接，Esc 取消。走系统 OpenSSH 客户端 —— ' +
      "密钥、known_hosts、~/.ssh/config 与命令行的 ssh 完全一致。</div>" +
      "</div>";
    host.appendChild(this.root);

    this.input = this.root.querySelector("input") as HTMLInputElement;
    this.root
      .querySelector(".scrim")
      ?.addEventListener("click", () => this.hide());

    this.input.addEventListener("keydown", (event) => {
      // Data entry, not commands — same isolation as the settings panel.
      event.stopPropagation();
      if (event.key === "Escape") {
        this.hide();
        return;
      }
      if (event.key !== "Enter") return;
      const args = parseSshTarget(this.input.value);
      if (args === null) {
        // Unusable input (empty, or options with no destination) — flash
        // instead of silently doing nothing on Enter.
        this.input.classList.remove("reject");
        void this.input.offsetWidth; // restart the animation
        this.input.classList.add("reject");
        return;
      }
      this.hide();
      this.onConnect(args);
    });
    this.input.addEventListener("input", () =>
      this.input.classList.remove("reject"),
    );
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.root.classList.add("on");
    this.root.setAttribute("aria-hidden", "false");
    this.input.focus();
    this.input.select();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove("on");
    this.root.setAttribute("aria-hidden", "true");
    // A hidden element would otherwise keep swallowing keystrokes.
    this.input.blur();
    this.onDismiss?.();
  }

  get isOpen(): boolean {
    return this.open;
  }
}
