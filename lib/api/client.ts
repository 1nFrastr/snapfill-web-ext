import type {
  ApiEnvelope,
  FormFieldsFillData,
  FormFieldsFillRequest,
  KnowledgeFile,
  KnowledgeFilesData,
} from '@/lib/api/types';
import { getSettings } from '@/lib/settings/store';
import { slog, swarn } from '@/lib/log';

const TOKEN_KEY = 'snapfill:accessToken';
const USER_KEY = 'snapfill:username';
const DEVICE_KEY = 'snapfill:deviceId';
const SELECTED_KB_KEY = 'snapfill:selectedKbIds';

export class AuthRequiredError extends Error {
  constructor(message = '请先登录') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export type AuthStatus = {
  loggedIn: boolean;
  username: string | null;
};

async function getDeviceId(): Promise<string> {
  const stored = await browser.storage.local.get(DEVICE_KEY);
  const existing = stored[DEVICE_KEY] as string | undefined;
  if (existing) return existing;
  const id = `${getSettings().deviceIdPrefix}-${crypto.randomUUID()}`;
  await browser.storage.local.set({ [DEVICE_KEY]: id });
  return id;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = getSettings().apiTimeoutMs,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`API 超时（>${timeoutMs}ms）：${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const stored = await browser.storage.local.get([TOKEN_KEY, USER_KEY]);
  let token = stored[TOKEN_KEY] as string | undefined;
  let username = (stored[USER_KEY] as string | undefined) ?? null;
  if (!token) {
    const legacy = await browser.storage.session.get([TOKEN_KEY, USER_KEY]);
    token = legacy[TOKEN_KEY] as string | undefined;
    username = (legacy[USER_KEY] as string | undefined) ?? null;
    if (token) {
      await browser.storage.local.set({
        [TOKEN_KEY]: token,
        [USER_KEY]: username,
      });
      await browser.storage.session
        .remove([TOKEN_KEY, USER_KEY])
        .catch(() => undefined);
    }
  }
  return { loggedIn: Boolean(token), username };
}

export async function passwordLogin(
  username: string,
  password: string,
): Promise<string> {
  const body = new URLSearchParams({ username, password });
  const res = await fetchWithTimeout(
    `${getSettings().apiBaseUrl}/auth/password_login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(
      `登录失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('登录响应缺少 access_token');
  await browser.storage.local.set({
    [TOKEN_KEY]: json.access_token,
    [USER_KEY]: username,
  });
  // 清掉旧版 session 存储，避免双源
  await browser.storage.session.remove([TOKEN_KEY, USER_KEY]).catch(() => undefined);
  slog('api', `登录成功 user=${username} token_len=${json.access_token.length}`);
  return json.access_token;
}

export async function logout(): Promise<void> {
  await browser.storage.local.remove([TOKEN_KEY, USER_KEY]);
  await browser.storage.session.remove([TOKEN_KEY, USER_KEY]).catch(() => undefined);
  slog('api', '已退出登录');
}

/** 仅读取已有 token，不再静默用 config 账号登录 */
export async function getAccessToken(): Promise<string> {
  const stored = await browser.storage.local.get(TOKEN_KEY);
  let token = stored[TOKEN_KEY] as string | undefined;
  if (!token) {
    // 兼容升级前存在 session 里的 token
    const legacy = await browser.storage.session.get([TOKEN_KEY, USER_KEY]);
    token = legacy[TOKEN_KEY] as string | undefined;
    if (token) {
      await browser.storage.local.set({
        [TOKEN_KEY]: token,
        [USER_KEY]: (legacy[USER_KEY] as string | undefined) ?? '',
      });
      await browser.storage.session
        .remove([TOKEN_KEY, USER_KEY])
        .catch(() => undefined);
    }
  }
  if (!token) throw new AuthRequiredError();
  return token;
}

async function clearSession(): Promise<void> {
  await browser.storage.local.remove([TOKEN_KEY, USER_KEY]);
  await browser.storage.session.remove([TOKEN_KEY, USER_KEY]).catch(() => undefined);
}

async function authedJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(`${getSettings().apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    swarn('api', `401，会话失效 ${path}`);
    await clearSession();
    throw new AuthRequiredError('登录已过期，请重新登录');
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const json = (await res.json()) as ApiEnvelope<T>;
  if (json.code !== 200 || json.data == null) {
    throw new Error(json.msg || `API 失败：${path}`);
  }
  return json.data;
}

export async function listKnowledgeFiles(opts?: {
  page?: number;
  pageSize?: number;
  status?: string;
}): Promise<KnowledgeFile[]> {
  const page = opts?.page ?? 1;
  const pageSize = opts?.pageSize ?? 50;
  const status = opts?.status ?? 'complete';
  const q = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    status,
  });
  const data = await authedJson<KnowledgeFilesData>(`/knowledge/files?${q}`);
  return data.files ?? [];
}

export async function getSelectedKnowledgeIds(): Promise<string[]> {
  const stored = await browser.storage.local.get(SELECTED_KB_KEY);
  const ids = stored[SELECTED_KB_KEY];
  return Array.isArray(ids) ? (ids as string[]) : [];
}

export async function setSelectedKnowledgeIds(ids: string[]): Promise<void> {
  await browser.storage.local.set({ [SELECTED_KB_KEY]: ids });
}

export async function waitKnowledgeComplete(
  taskId: string,
  timeoutMs = 180_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const st = await authedJson<Record<string, unknown>>(
      `/knowledge/status/${taskId}`,
    );
    const status = String(st.status ?? st.status_text ?? '');
    const done =
      st.is_completed === true ||
      st.is_complete === true ||
      status === 'complete' ||
      status === 'success';
    if (done) return;
    if (status === 'failed' || status === 'error') {
      throw new Error(`知识库解析失败: ${JSON.stringify(st)}`);
    }
    slog(
      'api',
      `knowledge status=${status || '?'} progress=${String(st.progress_percentage ?? st.progress ?? '-')}`,
    );
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`知识库解析超时（>${timeoutMs}ms） task=${taskId}`);
}

/** 浏览器侧上传：pre-upload → PUT → confirm → 可选等待解析完成
 *  对象存储 key 为 UUID；列表展示名仍用你传入的 filename（经后端 sanitize）。
 */
export async function uploadKnowledgeFile(
  file: Blob,
  filename: string,
  opts?: { waitComplete?: boolean },
): Promise<{
  fileIds: string[];
  taskId: string;
  files: Array<{
    id?: string;
    filename: string;
    message?: string;
    isRun?: boolean;
  }>;
  originalFilename: string;
}> {
  const waitComplete = opts?.waitComplete !== false;
  const bytes = file.size;
  const pre = await authedJson<{
    files?: Array<{ upload_url?: string; file_key?: string; error?: string }>;
  }>('/knowledge/pre-upload', {
    method: 'POST',
    body: JSON.stringify({
      files: [{ filename, file_size: bytes }],
    }),
  });

  const file0 = pre.files?.[0];
  if (!file0?.upload_url || !file0.file_key) {
    throw new Error(`pre-upload 失败: ${JSON.stringify(pre)}`);
  }

  const contentType = file.type || 'application/octet-stream';
  const put = await fetchWithTimeout(file0.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: file,
  });
  if (!put.ok) {
    throw new Error(
      `对象存储 PUT 失败 HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`,
    );
  }

  const confirm = await authedJson<{
    file_list?: Array<{ id?: string; filename?: string; is_run?: boolean; message?: string }>;
    task_id?: string;
    running_number?: number;
  }>('/knowledge/confirm-upload', {
    method: 'POST',
    body: JSON.stringify({
      files: [
        {
          file_key: file0.file_key,
          filename,
          file_size: bytes,
        },
      ],
    }),
  });

  const confirmed = (confirm.file_list || []).map((f) => ({
    id: f.id,
    filename: f.filename || filename,
    message: f.message,
    isRun: f.is_run,
  }));
  const fileIds = confirmed
    .map((f) => f.id)
    .filter((id): id is string => Boolean(id));
  const taskId = confirm.task_id || '';

  if (waitComplete && taskId && (confirm.running_number ?? 0) > 0) {
    await waitKnowledgeComplete(taskId);
  }

  slog(
    'api',
    `知识库上传完成 names=${confirmed.map((f) => f.filename).join(',')} fileIds=${fileIds.join(',')} task=${taskId}`,
  );
  return { fileIds, taskId, files: confirmed, originalFilename: filename };
}

export async function fillFormFields(
  body: Omit<FormFieldsFillRequest, 'device_id'> & { device_id?: string | null },
): Promise<FormFieldsFillData> {
  const device_id = body.device_id ?? (await getDeviceId());
  const payload: FormFieldsFillRequest = {
    ...body,
    device_id,
  };
  slog(
    'api',
    `form-fields/fill fields=${payload.fields.length} kb=${payload.knowledge_file_ids?.length ?? 'all'} context=${payload.page_context?.slice(0, 60) ?? ''}`,
  );
  return authedJson<FormFieldsFillData>('/Table/form-fields/fill', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
