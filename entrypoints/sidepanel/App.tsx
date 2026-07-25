import { FormEvent, useEffect, useRef, useState } from 'react';
import './App.css';
import {
  AGENT_PORT,
  type AgentPortClientMessage,
  type AgentStreamEvent,
} from '@/lib/messaging/types';
import { isDeepSeekConfigured } from '@/lib/ai/deepseek';
import { deepSeekConfig } from '@/lib/ai/config';
import { elapsed, slog, serror } from '@/lib/log';

type ToolStatus = 'running' | 'done' | 'error';

type ToolPart = {
  kind: 'tool';
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  status: ToolStatus;
};

type TextPart = {
  kind: 'text';
  text: string;
};

type MessagePart = TextPart | ToolPart;

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  streaming?: boolean;
};

const TOOL_LABELS: Record<string, string> = {
  extractPageFields: '抽取页面字段',
  listKnowledgeFiles: '列出知识库',
  fillFormFields: '后端填值',
  applyFieldValues: '写回 DOM',
};

const INITIAL: ChatMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    parts: [
      {
        kind: 'text',
        text: '你好，我是 Snapfill。在待填页面打开侧栏，直接说「帮我填表」或描述要填的步骤；我会流式展示工具调用并写回页面。',
      },
    ],
  },
];

function toolLabel(name: string) {
  return TOOL_LABELS[name] || name;
}

function previewJson(value: unknown, max = 280): string {
  try {
    const s = JSON.stringify(value, null, 0);
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value);
  }
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState(deepSeekConfig.model);
  const listRef = useRef<HTMLDivElement>(null);
  const portRef = useRef<ReturnType<typeof browser.runtime.connect> | null>(
    null,
  );
  const assistantIdRef = useRef<string | null>(null);
  const onEventRef = useRef<(event: AgentStreamEvent) => void>(() => undefined);
  const agentReady = isDeepSeekConfigured();

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    return () => {
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, []);

  function updateAssistant(
    id: string,
    updater: (parts: MessagePart[]) => MessagePart[],
    extra?: Partial<ChatMessage>,
  ) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, parts: updater(m.parts), ...extra } : m,
      ),
    );
  }

  onEventRef.current = (event: AgentStreamEvent) => {
    const aid = assistantIdRef.current;
    if (!aid) return;

    switch (event.type) {
      case 'started':
        setModel(event.model);
        break;
      case 'text-delta':
        updateAssistant(aid, (parts) => {
          const next = [...parts];
          const last = next[next.length - 1];
          if (last?.kind === 'text') {
            next[next.length - 1] = {
              kind: 'text',
              text: last.text + event.delta,
            };
          } else {
            next.push({ kind: 'text', text: event.delta });
          }
          return next;
        });
        break;
      case 'tool-call':
        updateAssistant(aid, (parts) => [
          ...parts,
          {
            kind: 'tool',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            status: 'running',
          },
        ]);
        break;
      case 'tool-result':
        updateAssistant(aid, (parts) =>
          parts.map((p) =>
            p.kind === 'tool' && p.toolCallId === event.toolCallId
              ? {
                  ...p,
                  status: 'done' as const,
                  result: event.result,
                }
              : p,
          ),
        );
        break;
      case 'tool-error':
        updateAssistant(aid, (parts) =>
          parts.map((p) =>
            p.kind === 'tool' && p.toolCallId === event.toolCallId
              ? {
                  ...p,
                  status: 'error' as const,
                  error: event.error,
                }
              : p,
          ),
        );
        break;
      case 'done':
        updateAssistant(
          aid,
          (parts) => {
            const hasText = parts.some(
              (p) => p.kind === 'text' && p.text.trim(),
            );
            if (hasText || !event.text.trim()) return parts;
            return [...parts, { kind: 'text', text: event.text }];
          },
          { streaming: false },
        );
        setBusy(false);
        assistantIdRef.current = null;
        break;
      case 'error':
        updateAssistant(
          aid,
          (parts) => [
            ...parts,
            { kind: 'text', text: `出错：${event.error}` },
          ],
          { streaming: false },
        );
        setBusy(false);
        assistantIdRef.current = null;
        break;
      default:
        break;
    }
  };

  function ensurePort() {
    if (portRef.current) return portRef.current;
    const port = browser.runtime.connect({ name: AGENT_PORT });
    port.onMessage.addListener((msg: AgentStreamEvent) => {
      onEventRef.current(msg);
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
      if (assistantIdRef.current) {
        updateAssistant(
          assistantIdRef.current,
          (parts) => parts,
          { streaming: false },
        );
        setBusy(false);
        assistantIdRef.current = null;
      }
    });
    portRef.current = port;
    return port;
  }

  function sendToAgent(msg: AgentPortClientMessage) {
    ensurePort().postMessage(msg);
  }

  function handleAbort() {
    sendToAgent({ type: 'abort' });
    const aid = assistantIdRef.current;
    if (aid) {
      updateAssistant(
        aid,
        (parts) => [...parts, { kind: 'text', text: '\n（已停止）' }],
        { streaming: false },
      );
    }
    setBusy(false);
    assistantIdRef.current = null;
  }

  function handleSend(prompt: string) {
    const text = prompt.trim();
    if (!text || busy) return;
    if (!agentReady) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          parts: [
            {
              kind: 'text',
              text: '请配置 DeepSeek API Key（lib/ai/config.ts → deepSeekConfig）。',
            },
          ],
        },
      ]);
      return;
    }

    const assistantId = crypto.randomUUID();
    assistantIdRef.current = assistantId;
    setBusy(true);
    const started = Date.now();

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text }] },
      {
        id: assistantId,
        role: 'assistant',
        streaming: true,
        parts: [],
      },
    ]);

    slog('sidepanel', `Agent 流式开始 prompt=${text.slice(0, 80)}`);
    try {
      sendToAgent({ type: 'start', prompt: text });
    } catch (e) {
      serror('sidepanel', `连接 background 失败 ${elapsed(started)}`, e);
      updateAssistant(
        assistantId,
        () => [
          {
            kind: 'text',
            text: e instanceof Error ? e.message : String(e),
          },
        ],
        { streaming: false },
      );
      setBusy(false);
      assistantIdRef.current = null;
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    handleSend(text);
  }

  return (
    <div className="chat">
      <header className="chat__header">
        <div className="chat__brand">Snapfill</div>
        <p className="chat__slogan">Agent 填表 · 流式工具调用</p>
        <div className="chat__actions">
          <button
            type="button"
            className="action"
            onClick={() => handleSend('请填写当前页可见表单')}
            disabled={busy || !agentReady}
          >
            {busy ? '运行中…' : '智能填表'}
          </button>
          {busy && (
            <button
              type="button"
              className="action action--ghost"
              onClick={handleAbort}
            >
              停止
            </button>
          )}
        </div>
        <p className="chat__stats">
          {agentReady
            ? `DeepSeek · ${model}`
            : '未配置 DeepSeek — 无法启动 Agent'}
        </p>
      </header>

      <div className="chat__messages" ref={listRef}>
        {messages.map((message) => (
          <div
            key={message.id}
            className={`bubble bubble--${message.role}${message.streaming ? ' bubble--streaming' : ''}`}
          >
            {message.parts.length === 0 && message.streaming && (
              <div className="bubble__thinking">思考中…</div>
            )}
            {message.parts.map((part, i) =>
              part.kind === 'text' ? (
                <div key={i} className="bubble__text">
                  {part.text}
                </div>
              ) : (
                <details
                  key={part.toolCallId}
                  className={`tool tool--${part.status}`}
                  open={part.status === 'running'}
                >
                  <summary>
                    <span className="tool__status" aria-hidden />
                    <span className="tool__name">
                      {toolLabel(part.toolName)}
                    </span>
                    <span className="tool__hint">{part.toolName}</span>
                  </summary>
                  {part.args != null && (
                    <pre className="tool__block">
                      参数 {previewJson(part.args)}
                    </pre>
                  )}
                  {part.result != null && (
                    <pre className="tool__block">
                      结果 {previewJson(part.result)}
                    </pre>
                  )}
                  {part.error && (
                    <pre className="tool__block tool__block--error">
                      {part.error}
                    </pre>
                  )}
                </details>
              ),
            )}
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          className="composer__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="描述要填的内容，或直接说「帮我填表」…"
          rows={1}
          disabled={!agentReady}
        />
        <button
          className="composer__send"
          type="submit"
          disabled={!input.trim() || busy || !agentReady}
        >
          发送
        </button>
      </form>
    </div>
  );
}

export default App;
