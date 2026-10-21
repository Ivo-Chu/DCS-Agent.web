export interface SsoSession {
  ok: true;
  token: string;
  name: string;
  employeeNo: string;
  department: string;
  authMethod: "dcs_sso";
}
export interface ApiError { ok: false; message: string }
export interface NavigationResult { ok: boolean; message: string }
export type ChatEvent =
  | { type: "delta"; text: string; messageId?: string }
  | { type: "tool_step"; status: "start" | "end"; name: string; toolCallId?: string; isError?: boolean }
  | { type: "ui_action"; action: "navigate_dcs_menu"; requestId: string; toolCallId?: string; payload: { menuName: string } }
  | { type: "final"; text: string; messageId?: string }
  | { type: "error" | "timeout" | "busy"; message: string };

export async function loginSso(code: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SsoSession | ApiError> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const duration = options.timeoutMs ?? 15000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; cancel(); }, Number.isFinite(duration) && duration > 0 ? duration : 15000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const res = await fetch("/api/session/sso", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }), signal: controller.signal,
    });
    const body = await res.json();
    return res.ok && body.ok ? body : { ok: false, message: body.message ?? "SSO登录失败，请重新打开DCS Agent。" };
  } catch {
    return { ok: false, message: timedOut ? "DCS登录超时，请重新打开DCS Agent。" :
      options.signal?.aborted ? "登录已取消。" : "无法连接DCS Agent服务，请重新打开。" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export async function streamChat(token: string, question: string, onEvent: (event: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let terminal = false;
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question }), signal,
    });
    if (!res.ok || !res.body) {
      let message = "连接失败，请稍后重试。";
      try { message = (await res.json()).message ?? message; } catch { /* 非 JSON 错误页 */ }
      onEvent({ type: "error", message });
      return;
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let event: ChatEvent;
        try { event = JSON.parse(data) as ChatEvent; } catch { throw new Error("invalid SSE"); }
        if (!event || !["delta", "tool_step", "ui_action", "final", "error", "timeout", "busy"].includes(event.type)) continue;
        terminal = ["final", "error", "timeout", "busy"].includes(event.type);
        onEvent(event);
        if (terminal) break;
      }
    }
    if (!terminal) onEvent({ type: "error", message: signal?.aborted ? "已停止本次回复。" : "连接已中断，回复未完成，请重试。" });
  } catch {
    onEvent({ type: "error", message: signal?.aborted ? "已停止本次回复。" : "网络异常，回复已中断，请重试。" });
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch { /* 已断开的连接 */ }
      reader.releaseLock();
    }
  }
}

export async function postNavigationResult(token: string, requestId: string, result: NavigationResult, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/ui-action/result", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId, result }), signal,
  });
  if (!res.ok) throw new Error("导航结果回传失败");
}
