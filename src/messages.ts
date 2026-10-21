import type { ChatEvent } from "./api";
export interface StoreMessage { id: string; role: "user" | "assistant"; content: string }
/** 每个模型轮次独立更新；final 不覆盖工具前的其他轮次文本。 */
export function applyTextEvent(messages: StoreMessage[], prefix: string, event: ChatEvent): StoreMessage[] {
  if (event.type !== "delta" && event.type !== "final" && event.type !== "error" && event.type !== "timeout" && event.type !== "busy") return messages;
  const failed = event.type === "error" || event.type === "timeout" || event.type === "busy";
  const id = failed ? `${prefix}:error` : `${prefix}:${"messageId" in event ? event.messageId ?? "1" : "1"}`;
  const text = "text" in event ? event.text : event.message;
  const existing = messages.find(m => m.id === id);
  const content = event.type === "delta" ? (existing?.content ?? "") + text : text;
  // 首个空占位在首次实际文本到达时移除，避免工具先行时留下空气泡。
  const next = messages.filter(m => m.id !== `${prefix}:placeholder`);
  return existing ? next.map(m => m.id === id ? { ...m, content } : m) : [...next, { id, role: "assistant", content }];
}
