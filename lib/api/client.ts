import { apiConfig } from '@/lib/api/config';
import type {
  ApiEnvelope,
  FormFieldsFillData,
  FormFieldsFillRequest,
  KnowledgeFile,
  KnowledgeFilesData,
} from '@/lib/api/types';
import { slog, swarn } from '@/lib/log';

const TOKEN_KEY = 'snapfill:accessToken';
const DEVICE_KEY = 'snapfill:deviceId';

async function getDeviceId(): Promise<string> {
  const stored = await browser.storage.local.get(DEVICE_KEY);
  const existing = stored[DEVICE_KEY] as string | undefined;
  if (existing) return existing;
  const id = `${apiConfig.deviceIdPrefix}-${crypto.randomUUID()}`;
  await browser.storage.local.set({ [DEVICE_KEY]: id });
  return id;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = apiConfig.timeoutMs,
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

export async function passwordLogin(
  username = apiConfig.username,
  password = apiConfig.password,
): Promise<string> {
  const body = new URLSearchParams({ username, password });
  const res = await fetchWithTimeout(`${apiConfig.apiBaseUrl}/auth/password_login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`登录失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('登录响应缺少 access_token');
  await browser.storage.session.set({ [TOKEN_KEY]: json.access_token });
  slog('api', `登录成功 token_len=${json.access_token.length}`);
  return json.access_token;
}

export async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const stored = await browser.storage.session.get(TOKEN_KEY);
    const token = stored[TOKEN_KEY] as string | undefined;
    if (token) return token;
  }
  return passwordLogin();
}

async function authedJson<T>(
  path: string,
  init: RequestInit & { retryOn401?: boolean } = {},
): Promise<T> {
  const { retryOn401 = true, ...rest } = init;
  const token = await getAccessToken();
  const res = await fetchWithTimeout(`${apiConfig.apiBaseUrl}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(rest.headers ?? {}),
    },
  });

  if (res.status === 401 && retryOn401) {
    swarn('api', `401，重新登录后重试 ${path}`);
    await getAccessToken(true);
    return authedJson(path, { ...init, retryOn401: false });
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
