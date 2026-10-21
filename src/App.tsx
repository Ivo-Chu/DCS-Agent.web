import { AssistantRuntimeProvider, ThreadPrimitive, ComposerPrimitive, MessagePrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { loginSso, postNavigationResult, streamChat, type ChatEvent, type SsoSession } from "./api";
import { waitForNavigation } from "./navigation";
import { applyTextEvent, type StoreMessage } from "./messages";

interface ToolStatus { key: string; name: string; status: "running" | "success" | "error" }
let messageSeq = 0;
const nextId = () => `m${++messageSeq}`;
const UserMessage = () => <MessagePrimitive.Root className="message user"><div className="bubble"><MessagePrimitive.Content /></div></MessagePrimitive.Root>;
const AssistantMessage = () => <MessagePrimitive.Root className="message assistant"><div className="bubble"><MessagePrimitive.Content /></div></MessagePrimitive.Root>;
const messageComponents = { UserMessage, AssistantMessage };

function parentOrigin(): string | null {
  try { return window.parent === window || !document.referrer ? null : new URL(document.referrer).origin; }
  catch { return null; }
}
function App() {
  const [session, setSession] = useState<SsoSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<StoreMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [toolStatuses, setToolStatuses] = useState<ToolStatus[]>([]);
  const tokenRef = useRef("");
  const mounted = useRef(false);
  const chatController = useRef<AbortController | null>(null);
  // StrictMode 的 effect 重放不丢失读取后的 code。
  const [ssoCode] = useState(() => new URLSearchParams(window.location.search).get("_code"));

  const updateToolStatus = useCallback((key: string, name: string, status: ToolStatus["status"]) => {
    setToolStatuses(prev => [...prev.filter(item => item.key !== key), { key, name, status }]);
  }, []);

  const onNew = useCallback(async (message: { content: unknown }) => {
    const content = Array.isArray(message.content)
      ? message.content.filter((part): part is { type: "text"; text: string } => part?.type === "text").map(part => part.text).join("")
      : String(message.content ?? "");
    const question = content.trim();
    if (!question || !tokenRef.current || chatController.current) return;
    const prefix = nextId(), controller = new AbortController(), navigationController = new AbortController();
    chatController.current = controller;
    const cancelNavigation = () => navigationController.abort();
    controller.signal.addEventListener("abort", cancelNavigation, { once: true });
    setMessages(prev => [...prev, { id: nextId(), role: "user", content: question },
      { id: `${prefix}:placeholder`, role: "assistant", content: "" }]);
    setToolStatuses([]); setRunning(true);
    const live = () => mounted.current && chatController.current === controller;
    const navigationTasks: Promise<void>[] = [];
    const handleEvent = (event: ChatEvent) => {
      if (!live()) return;
      setMessages(prev => applyTextEvent(prev, prefix, event));
      if (event.type === "tool_step") {
        updateToolStatus(event.toolCallId ?? `${prefix}:${event.name}`, event.name,
          event.status === "start" ? "running" : event.isError ? "error" : "success");
      } else if (event.type === "ui_action") {
        const key = event.toolCallId ?? `navigate:${event.requestId}`;
        updateToolStatus(key, "DCS菜单导航", "running");
        navigationTasks.push((async () => {
          const result = await waitForNavigation(event.requestId, event.payload.menuName, parentOrigin(), navigationController.signal);
          if (!live() || navigationController.signal.aborted) return;
          try {
            await postNavigationResult(tokenRef.current, event.requestId, result, navigationController.signal);
            if (live() && !navigationController.signal.aborted) updateToolStatus(key, "DCS菜单导航", result.ok ? "success" : "error");
          } catch {
            if (live() && !navigationController.signal.aborted) updateToolStatus(key, "DCS菜单导航", "error");
          }
        })());
      }
    };
    try {
      await streamChat(tokenRef.current, question, handleEvent, controller.signal);
    } finally {
      navigationController.abort();
      controller.signal.removeEventListener("abort", cancelNavigation);
      await Promise.all(navigationTasks);
      if (live()) {
        setToolStatuses(prev => prev.map(tool => tool.status === "running" ? { ...tool, status: "error" } : tool));
        setRunning(false);
        chatController.current = null;
      }
    }
  }, [updateToolStatus]);
  const runtime = useExternalStoreRuntime({
    messages, isRunning: running, onNew,
    onCancel: async () => { chatController.current?.abort(); },
    convertMessage: (message: StoreMessage) => ({ id: message.id, role: message.role, content: message.content }),
  });

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (!ssoCode) { setError("请从DCS系统右下角入口打开DCS Agent。"); setLoading(false); }
    else {
      const url = new URL(window.location.href);
      url.searchParams.delete("_code");
      window.history.replaceState(null, "", url);
      void loginSso(ssoCode, { signal: controller.signal, timeoutMs: Number(import.meta.env.VITE_SSO_TIMEOUT_MS ?? 15000) }).then(result => {
        if (controller.signal.aborted) return;
        if (result.ok) { tokenRef.current = result.token; setSession(result); }
        else setError(result.message);
        setLoading(false);
      });
    }
    return () => {
      mounted.current = false;
      controller.abort();
      chatController.current?.abort();
    };
  }, [ssoCode]);

  if (loading) return <div className="state">正在通过DCS SSO识别身份…</div>;
  if (error) return <div className="state error">{error}</div>;
  if (!session) return <div className="state">会话未初始化。</div>;
  return <AssistantRuntimeProvider runtime={runtime}>
    <div className="app">
      <header className="header"><div>
        <div className="header-title">DCS Agent</div>
        <div className="header-user">{session.name} / {session.employeeNo}{session.department ? ` / ${session.department}` : ""}</div>
      </div></header>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="thread-viewport">
          <ThreadPrimitive.Messages components={messageComponents} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
      {toolStatuses.length > 0 && <div className="tool-panel">
        {toolStatuses.map(tool => <span key={tool.key} className={`tool-badge ${tool.status}`}>
          {tool.name}：{tool.status === "running" ? "执行中" : tool.status === "error" ? "失败" : "完成"}
        </span>)}
      </div>}
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input className="composer-input" placeholder="请输入问题，例如：帮我打开上岗证查询" />
        {running ? <ComposerPrimitive.Cancel className="composer-send">停止</ComposerPrimitive.Cancel>
          : <ComposerPrimitive.Send className="composer-send">发送</ComposerPrimitive.Send>}
      </ComposerPrimitive.Root>
    </div>
  </AssistantRuntimeProvider>;
}
export default App;
