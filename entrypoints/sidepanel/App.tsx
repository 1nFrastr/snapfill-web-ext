import {
  ClipboardEvent,
  DragEvent,
  FormEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import './App.css';
import {
  AGENT_PORT,
  type AgentPortClientMessage,
  type AgentStreamEvent,
} from '@/lib/messaging/types';
import { isDeepSeekConfigured } from '@/lib/ai/deepseek';
import {
  AuthRequiredError,
  getAuthStatus,
  getSelectedKnowledgeIds,
  listKnowledgeFiles,
  logout,
  passwordLogin,
  setSelectedKnowledgeIds,
  uploadKnowledgeFile,
} from '@/lib/api/client';
import type { KnowledgeFile } from '@/lib/api/types';
import { downloadTrace, readTrace, type StoredTrace } from '@/lib/trace/runtime';
import {
  ensureSettingsLoaded,
  getSettings,
} from '@/lib/settings/store';
import type { AppSettings } from '@/lib/settings/types';
import { SettingsPanel } from './SettingsPanel';
import { elapsed, slog, serror } from '@/lib/log';

const FILE_ACCEPT =
  '.txt,.md,.pdf,.doc,.docx,.csv,.json,text/plain,application/pdf';
const FILE_EXT_RE = /\.(txt|md|pdf|doc|docx|csv|json)$/i;

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

type ReasoningPart = {
  kind: 'reasoning';
  text: string;
};

type MessagePart = TextPart | ToolPart | ReasoningPart;

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  streaming?: boolean;
};

const TOOL_LABELS: Record<string, string> = {
  probeFrames: '探测页面 Frames',
  snapshotForm: '表单快照抽取',
  describeRegion: '查看区域详情',
  readElementDetail: '查看控件详情',
  activate: '交互探索',
  openOptions: '展开选项',
  getExtractionReport: '抽取质量报告',
  commitFormGraph: '提交后端检索填值',
  applyValues: '写回 DOM',
};

const INITIAL: ChatMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    parts: [
      {
        kind: 'text',
        text: '你好，我是 Snapfill。请先登录并勾选知识库，打开待填页后说「帮我填表」。我会用 thinking 模式探索 iframe/空间标签，再填值写回。',
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

function formatSize(n?: number) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(s?: string) {
  if (!s) return '';
  // 后端多为 "YYYY-MM-DD HH:mm:ss"
  return s.length > 16 ? s.slice(5, 16) : s;
}

function isAcceptedFile(file: File) {
  if (FILE_EXT_RE.test(file.name)) return true;
  const t = file.type.toLowerCase();
  return (
    t === 'text/plain' ||
    t === 'application/pdf' ||
    t === 'text/markdown' ||
    t === 'text/csv' ||
    t === 'application/json' ||
    t === 'application/msword' ||
    t ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

function filesFromList(list: FileList | File[] | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter(isAcceptedFile);
}

function filesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const fromFiles = filesFromList(data.files);
  if (fromFiles.length > 0) return fromFiles;
  if (!data.items?.length) return [];
  const out: File[] = [];
  for (const item of data.items) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f && isAcceptedFile(f)) out.push(f);
  }
  return out;
}

type PendingUpload = {
  id: string;
  name: string;
  size: number;
};

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('');
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentReady, setAgentReady] = useState(false);

  const [trace, setTrace] = useState<StoredTrace | null>(null);

  const [loggedIn, setLoggedIn] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [kbOpen, setKbOpen] = useState(false);
  const [kbFiles, setKbFiles] = useState<KnowledgeFile[]>([]);
  const [selectedKb, setSelectedKb] = useState<string[]>([]);
  const [kbBusy, setKbBusy] = useState(false);
  const [kbError, setKbError] = useState<string | null>(null);
  const [kbHint, setKbHint] = useState<string | null>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerFileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const portRef = useRef<ReturnType<typeof browser.runtime.connect> | null>(
    null,
  );
  const assistantIdRef = useRef<string | null>(null);
  const onEventRef = useRef<(event: AgentStreamEvent) => void>(() => undefined);
  const canRun = agentReady && loggedIn;

  function applySettingsToUi(s: AppSettings) {
    setModel(s.deepSeekModel);
    setLoginUser(s.defaultUsername);
    setLoginPass(s.defaultPassword);
    setAgentReady(isDeepSeekConfigured());
  }

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

  useEffect(() => {
    void readTrace().then(setTrace);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const settings = await ensureSettingsLoaded();
        applySettingsToUi(settings);
        setSettingsReady(true);

        const status = await getAuthStatus();
        setLoggedIn(status.loggedIn);
        setUsername(status.username);
        if (!status.loggedIn) setLoginOpen(true);
        const ids = await getSelectedKnowledgeIds();
        setSelectedKb(ids);
        if (status.loggedIn) {
          await refreshKb(ids);
        }
      } catch (e) {
        serror('sidepanel', '初始化会话失败', e);
        setSettingsReady(true);
      }
    })();
    // refreshKb is stable enough for mount-only init
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshKb(preferIds?: string[], opts?: { retries?: number }) {
    setKbError(null);
    const retries = opts?.retries ?? 0;
    try {
      let files = await listKnowledgeFiles({ pageSize: 50, status: 'complete' });
      const want = preferIds?.filter(Boolean) ?? [];
      for (let i = 0; i < retries && want.length > 0; i += 1) {
        const have = new Set(files.map((f) => f.id));
        if (want.every((id) => have.has(id))) break;
        await new Promise((r) => setTimeout(r, 1500));
        files = await listKnowledgeFiles({ pageSize: 50, status: 'complete' });
      }
      setKbFiles(files);
      const valid = new Set(files.map((f) => f.id));
      const current = preferIds ?? selectedKb;
      const next = current.filter((id) => valid.has(id));
      setSelectedKb(next);
      await setSelectedKnowledgeIds(next);
      return files;
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        setLoggedIn(false);
        setUsername(null);
        setLoginOpen(true);
        setKbError('登录已过期，请重新登录');
        return [];
      }
      setKbError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  function pushSystem(text: string) {
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [{ kind: 'text', text }],
      },
    ]);
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      await passwordLogin(loginUser.trim(), loginPass);
      setLoggedIn(true);
      setUsername(loginUser.trim());
      setLoginOpen(false);
      setLoginPass('');
      pushSystem(`已登录为 ${loginUser.trim()}`);
      await refreshKb();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    await logout();
    setLoggedIn(false);
    setUsername(null);
    setKbFiles([]);
    setLoginOpen(true);
    setKbOpen(false);
    pushSystem('已退出登录');
  }

  async function toggleKb(id: string) {
    const next = selectedKb.includes(id)
      ? selectedKb.filter((x) => x !== id)
      : [...selectedKb, id];
    setSelectedKb(next);
    await setSelectedKnowledgeIds(next);
  }

  async function handleUploadFiles(rawFiles: File[]) {
    const files = filesFromList(rawFiles);
    if (files.length === 0) {
      if (rawFiles.length > 0) {
        setKbError('不支持的文件类型（仅 txt/md/pdf/doc/docx/csv/json）');
      }
      return;
    }
    if (!loggedIn) {
      setLoginOpen(true);
      pushSystem('请先登录再上传知识库文件');
      return;
    }

    setKbBusy(true);
    setKbError(null);
    setKbHint(
      files.length === 1
        ? `正在上传并解析「${files[0].name}」…`
        : `正在上传并解析 ${files.length} 个文件…`,
    );

    const pending: PendingUpload[] = files.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      size: f.size,
    }));
    setPendingUploads((prev) => [...pending, ...prev]);

    // 乐观展示：解析完成前也能在列表里看到原名
    setKbFiles((prev) => {
      const extras: KnowledgeFile[] = pending
        .filter((p) => !prev.some((f) => f.id === `__uploading__:${p.id}`))
        .map((p) => ({
          id: `__uploading__:${p.id}`,
          filename: p.name,
          file_size: p.size,
          status: 'uploading',
        }));
      return extras.length ? [...extras, ...prev] : prev;
    });

    let selected = selectedKb;
    const addedNames: string[] = [];
    const errors: string[] = [];

    try {
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const pendingId = pending[i].id;
        const originalName = file.name;
        try {
          const result = await uploadKnowledgeFile(file, originalName);
          const displayName =
            result.files.find((f) => f.filename)?.filename || originalName;
          if (result.fileIds.length === 0) {
            const msg =
              result.files.map((f) => f.message).filter(Boolean).join('；') ||
              '未返回文件 id（可能重名被跳过）';
            errors.push(`「${displayName}」：${msg}`);
          } else {
            selected = Array.from(new Set([...selected, ...result.fileIds]));
            addedNames.push(displayName);
          }
        } catch (e) {
          if (e instanceof AuthRequiredError) throw e;
          errors.push(
            e instanceof Error
              ? `「${originalName}」上传失败：${e.message}`
              : String(e),
          );
        } finally {
          setPendingUploads((prev) => prev.filter((p) => p.id !== pendingId));
          setKbFiles((prev) =>
            prev.filter((f) => f.id !== `__uploading__:${pendingId}`),
          );
        }
      }

      setSelectedKb(selected);
      await setSelectedKnowledgeIds(selected);
      const refreshed = await refreshKb(selected, { retries: 8 });
      const found = refreshed.filter((f) => selected.includes(f.id));
      setKbHint(null);

      if (errors.length) setKbError(errors.join('；'));
      if (addedNames.length) {
        const visible = found
          .filter((f) => addedNames.includes(f.filename))
          .map((f) => f.filename);
        const names = visible.length ? visible : addedNames;
        pushSystem(`已添加「${names.join('、')}」并勾选。`);
      } else if (errors.length) {
        pushSystem(`上传未完成：${errors.join('；')}`);
      }
    } catch (e) {
      setPendingUploads([]);
      setKbFiles((prev) => prev.filter((f) => !f.id.startsWith('__uploading__:')));
      if (e instanceof AuthRequiredError) {
        setLoggedIn(false);
        setUsername(null);
        setLoginOpen(true);
        setKbError('登录已过期，请重新登录');
      } else {
        setKbError(e instanceof Error ? e.message : String(e));
      }
      setKbHint(null);
    } finally {
      setKbBusy(false);
      setPendingUploads([]);
      setKbFiles((prev) => prev.filter((f) => !f.id.startsWith('__uploading__:')));
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (composerFileInputRef.current) composerFileInputRef.current.value = '';
    }
  }

  function ingestFiles(files: File[]) {
    if (files.length === 0) return;
    void handleUploadFiles(files);
  }

  function onComposerDragEnter(e: DragEvent) {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  }

  function onComposerDragOver(e: DragEvent) {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function onComposerDragLeave(e: DragEvent) {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  }

  function onComposerDrop(e: DragEvent) {
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    const rawCount = e.dataTransfer.files?.length ?? 0;
    const dropped = filesFromDataTransfer(e.dataTransfer);
    if (rawCount > 0 && dropped.length === 0) {
      setKbError('不支持的文件类型（仅 txt/md/pdf/doc/docx/csv/json）');
      return;
    }
    ingestFiles(dropped);
  }

  function onComposerPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = filesFromDataTransfer(e.clipboardData);
    if (pasted.length === 0) return;
    e.preventDefault();
    ingestFiles(pasted);
  }

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
      case 'reasoning-delta':
        if (!event.delta) break;
        updateAssistant(aid, (parts) => {
          const next = [...parts];
          const last = next[next.length - 1];
          if (last?.kind === 'reasoning') {
            next[next.length - 1] = {
              kind: 'reasoning',
              text: last.text + event.delta,
            };
          } else {
            next.push({ kind: 'reasoning', text: event.delta });
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
        if (
          event.error.includes('请先登录') ||
          event.error.includes('登录已过期')
        ) {
          setLoggedIn(false);
          setUsername(null);
          setLoginOpen(true);
        }
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
        void readTrace().then(setTrace);
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
        if (
          event.error.includes('请先登录') ||
          event.error.includes('登录已过期')
        ) {
          setLoggedIn(false);
          setUsername(null);
          setLoginOpen(true);
        }
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
      pushSystem('请在「设置」中填写 DeepSeek API Key。');
      setSettingsOpen(true);
      return;
    }
    if (!loggedIn) {
      setLoginOpen(true);
      pushSystem('请先登录后再填表。');
      return;
    }

    const assistantId = crypto.randomUUID();
    assistantIdRef.current = assistantId;
    setBusy(true);
    const started = Date.now();

    const kbNote =
      selectedKb.length > 0
        ? `（已选 ${selectedKb.length} 份知识库）`
        : '（未勾选知识库 → 使用账号下全部已解析文件）';

    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: `${text}\n${kbNote}` }],
      },
      {
        id: assistantId,
        role: 'assistant',
        streaming: true,
        parts: [],
      },
    ]);

    slog('sidepanel', `Agent 流式开始 prompt=${text.slice(0, 80)} kb=${selectedKb.length}`);
    try {
      sendToAgent({
        type: 'start',
        prompt: text,
        knowledgeFileIds: selectedKb.length > 0 ? selectedKb : undefined,
      });
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

  const kbSummary = loggedIn
    ? selectedKb.length > 0
      ? `知识库：已选 ${selectedKb.length} 份`
      : `知识库：${kbFiles.length} 份可选（未勾选=全部）`
    : '知识库：登录后可用';

  const selectedAttachments = selectedKb
    .map((id) => kbFiles.find((f) => f.id === id))
    .filter((f): f is KnowledgeFile => Boolean(f));
  const orphanSelectedIds = selectedKb.filter(
    (id) => !kbFiles.some((f) => f.id === id),
  );
  const hasAttachments =
    pendingUploads.length > 0 ||
    selectedAttachments.length > 0 ||
    orphanSelectedIds.length > 0;

  return (
    <div className="chat">
      <header className="chat__header">
        <div className="chat__top">
          <div>
            <div className="chat__brand">Snapfill</div>
            <p className="chat__slogan">Agent 填表 · 流式工具调用</p>
          </div>
          <div className="chat__session">
            <button
              type="button"
              className="action action--ghost action--sm"
              onClick={() => setSettingsOpen((v) => !v)}
            >
              设置
            </button>
            {loggedIn ? (
              <>
                <span className="session__user" title={username ?? ''}>
                  {username}
                </span>
                <button
                  type="button"
                  className="action action--ghost action--sm"
                  onClick={() => void handleLogout()}
                >
                  退出
                </button>
              </>
            ) : (
              <button
                type="button"
                className="action action--sm"
                onClick={() => setLoginOpen((v) => !v)}
              >
                登录
              </button>
            )}
          </div>
        </div>

        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => {
            applySettingsToUi(s);
            pushSystem(
              `设置已更新：API ${s.apiBaseUrl} · DeepSeek ${s.deepSeekModel}`,
            );
          }}
        />

        {loginOpen && !loggedIn && (
          <form className="session-panel" onSubmit={(e) => void handleLogin(e)}>
            <label className="field">
              <span>账号</span>
              <input
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="field">
              <span>密码</span>
              <input
                type="password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {authError && <p className="session-panel__error">{authError}</p>}
            <button
              type="submit"
              className="action"
              disabled={authBusy || !loginUser.trim() || !loginPass}
            >
              {authBusy ? '登录中…' : '确认登录'}
            </button>
          </form>
        )}

        <div className="chat__kbbar">
          <button
            type="button"
            className="kbbar__toggle"
            onClick={() => {
              if (!loggedIn) {
                setLoginOpen(true);
                return;
              }
              setKbOpen((v) => !v);
              if (!kbOpen) void refreshKb();
            }}
            disabled={!loggedIn}
          >
            {kbSummary}
            <span aria-hidden>{kbOpen ? '▾' : '▸'}</span>
          </button>
          <button
            type="button"
            className="action action--ghost action--sm"
            disabled={!loggedIn || kbBusy}
            onClick={() => fileInputRef.current?.click()}
          >
            {kbBusy ? '上传中…' : '上传'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            accept={FILE_ACCEPT}
            onChange={(e) => {
              const list = e.target.files;
              if (list?.length) ingestFiles(Array.from(list));
            }}
          />
        </div>

        {(kbHint || kbError) && (
          <div className="kb-status" role="status">
            {kbHint && <p className="kb-panel__hint">{kbHint}</p>}
            {kbError && <p className="session-panel__error">{kbError}</p>}
          </div>
        )}

        {kbOpen && loggedIn && (
          <div className="kb-panel">
            <div className="kb-panel__head">
              <span className="kb-panel__title">
                已解析文件（显示原文件名）
              </span>
              <button
                type="button"
                className="action action--ghost action--sm"
                disabled={kbBusy}
                onClick={() => void refreshKb(selectedKb)}
              >
                刷新
              </button>
            </div>
            {kbFiles.length === 0 ? (
              <p className="kb-panel__empty">暂无已解析文件，请先上传材料。</p>
            ) : (
              <ul className="kb-list">
                {kbFiles.map((f) => (
                  <li key={f.id}>
                    <label
                      className={`kb-item${f.id.startsWith('__uploading__:') ? ' kb-item--pending' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={
                          f.id.startsWith('__uploading__:')
                            ? true
                            : selectedKb.includes(f.id)
                        }
                        disabled={f.id.startsWith('__uploading__:')}
                        onChange={() => void toggleKb(f.id)}
                      />
                      <span className="kb-item__body">
                        <span className="kb-item__name" title={f.filename}>
                          {f.filename || '(无文件名)'}
                        </span>
                        <span className="kb-item__meta">
                          {[
                            formatSize(f.file_size),
                            formatWhen(f.created_at),
                            f.status === 'uploading'
                              ? '上传/解析中'
                              : f.status,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="chat__actions">
          <button
            type="button"
            className="action"
            onClick={() => handleSend('请填写当前页可见表单')}
            disabled={busy || !canRun}
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
          {!busy && trace && (
            <button
              type="button"
              className="action action--ghost action--sm"
              title={`${trace.controls.length} 个控件 · ${formatWhen(trace.capturedAt)}`}
              onClick={() => downloadTrace(trace)}
            >
              导出抽取产物
            </button>
          )}
        </div>
        <p className="chat__stats">
          {!settingsReady
            ? '加载设置…'
            : !agentReady
              ? '未配置 DeepSeek — 打开「设置」填写 API Key'
              : !loggedIn
                ? '未登录 — 请先登录后端账号'
                : `DeepSeek · ${model} · ${getSettings().apiBaseUrl}`}
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
              ) : part.kind === 'reasoning' ? (
                <details key={`r-${i}`} className="reasoning" open={message.streaming}>
                  <summary>Thinking</summary>
                  <pre className="reasoning__body">{part.text}</pre>
                </details>
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

      <form
        className={`composer${dragOver ? ' composer--dragover' : ''}`}
        onSubmit={handleSubmit}
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
      >
        {hasAttachments && (
          <div className="composer__attachments" aria-label="已选附件">
            {pendingUploads.map((p) => (
              <div
                key={p.id}
                className="attach-chip attach-chip--pending"
                title={p.name}
              >
                <span className="attach-chip__icon" aria-hidden />
                <span className="attach-chip__body">
                  <span className="attach-chip__name">{p.name}</span>
                  <span className="attach-chip__meta">
                    上传中… · {formatSize(p.size)}
                  </span>
                </span>
              </div>
            ))}
            {selectedAttachments.map((f) => (
              <div key={f.id} className="attach-chip" title={f.filename}>
                <span className="attach-chip__icon" aria-hidden />
                <span className="attach-chip__body">
                  <span className="attach-chip__name">
                    {f.filename || '(无文件名)'}
                  </span>
                  <span className="attach-chip__meta">
                    {[formatSize(f.file_size), f.status]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <button
                  type="button"
                  className="attach-chip__remove"
                  aria-label={`移除 ${f.filename}`}
                  disabled={busy}
                  onClick={() => void toggleKb(f.id)}
                >
                  ×
                </button>
              </div>
            ))}
            {orphanSelectedIds.map((id) => (
              <div key={id} className="attach-chip" title={id}>
                <span className="attach-chip__icon" aria-hidden />
                <span className="attach-chip__body">
                  <span className="attach-chip__name">已选文件</span>
                  <span className="attach-chip__meta">解析中…</span>
                </span>
                <button
                  type="button"
                  className="attach-chip__remove"
                  aria-label="移除附件"
                  disabled={busy}
                  onClick={() => void toggleKb(id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="composer__row">
          <button
            type="button"
            className="composer__attach"
            title="添加附件"
            aria-label="添加附件"
            disabled={!loggedIn || kbBusy || busy}
            onClick={() => composerFileInputRef.current?.click()}
          >
            +
          </button>
          <input
            ref={composerFileInputRef}
            type="file"
            hidden
            multiple
            accept={FILE_ACCEPT}
            onChange={(e) => {
              const list = e.target.files;
              if (list?.length) ingestFiles(Array.from(list));
            }}
          />
          <textarea
            className="composer__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={onComposerPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              !loggedIn
                ? '请先登录…'
                : '描述要填的内容，或拖入/粘贴文件…'
            }
            rows={1}
            disabled={!canRun}
          />
          <button
            className="composer__send"
            type="submit"
            disabled={!input.trim() || busy || !canRun}
          >
            发送
          </button>
        </div>

        {dragOver && (
          <div className="composer__drop-overlay" aria-hidden>
            松开以上传材料
          </div>
        )}
      </form>
    </div>
  );
}

export default App;
