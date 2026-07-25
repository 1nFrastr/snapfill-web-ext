/**
 * Node 侧 API 客户端（不依赖 browser.storage），供 CLI e2e 使用。
 */
import { readFileSync } from 'node:fs';
import type {
  ApiEnvelope,
  FormFieldsFillData,
  FormFieldsFillRequest,
  KnowledgeFile,
  KnowledgeFilesData,
} from '../../lib/api/types';

export type NodeApiConfig = {
  apiBaseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
};

export class NodeSnapfillApi {
  token: string | null = null;

  constructor(private readonly cfg: NodeApiConfig) {}

  private async fetchJson(
    path: string,
    init: RequestInit = {},
    opts?: { auth?: boolean; envelope?: boolean },
  ): Promise<unknown> {
    const auth = opts?.auth !== false;
    const envelope = opts?.envelope !== false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const headers: Record<string, string> = {
        ...(init.headers as Record<string, string> | undefined),
      };
      if (auth) {
        if (!this.token) throw new Error('未登录');
        headers.Authorization = `Bearer ${this.token}`;
      }
      if (init.body && !headers['Content-Type'] && !(init.body instanceof URLSearchParams)) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(`${this.cfg.apiBaseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
      }
      const json = await res.json();
      if (!envelope) return json;
      const env = json as ApiEnvelope<unknown>;
      if (typeof env.code === 'number') {
        if (env.code !== 200) throw new Error(env.msg || `API 失败 ${path}`);
        return env.data;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  async login(username = this.cfg.username, password = this.cfg.password): Promise<string> {
    const body = new URLSearchParams({ username, password });
    const json = (await this.fetchJson(
      '/auth/password_login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      { auth: false, envelope: false },
    )) as { access_token?: string };
    if (!json.access_token) throw new Error('登录响应缺少 access_token');
    this.token = json.access_token;
    return this.token;
  }

  async listKnowledgeFiles(status = 'complete'): Promise<KnowledgeFile[]> {
    const q = new URLSearchParams({ page: '1', page_size: '50', status });
    const data = (await this.fetchJson(`/knowledge/files?${q}`)) as KnowledgeFilesData;
    return data?.files ?? [];
  }

  async uploadKnowledgeFile(filePath: string, filename?: string): Promise<{
    fileIds: string[];
    taskId: string;
  }> {
    const bytes = readFileSync(filePath);
    const name = filename || filePath.split('/').pop() || 'kb.txt';
    const pre = (await this.fetchJson('/knowledge/pre-upload', {
      method: 'POST',
      body: JSON.stringify({
        files: [{ filename: name, file_size: bytes.length }],
      }),
    })) as { files?: Array<{ upload_url?: string; file_key?: string; error?: string }> };

    const file0 = pre?.files?.[0];
    if (!file0?.upload_url || !file0.file_key) {
      throw new Error(`pre-upload 失败: ${JSON.stringify(pre)}`);
    }

    const put = await fetch(file0.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: bytes,
    });
    if (!put.ok) {
      throw new Error(`S3 PUT 失败 HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
    }

    const confirm = (await this.fetchJson('/knowledge/confirm-upload', {
      method: 'POST',
      body: JSON.stringify({
        files: [
          {
            file_key: file0.file_key,
            filename: name,
            file_size: bytes.length,
          },
        ],
      }),
    })) as {
      file_list?: Array<{ id?: string }>;
      task_id?: string;
      running_number?: number;
    };

    const fileIds = (confirm.file_list || [])
      .map((f) => f.id)
      .filter((id): id is string => Boolean(id));
    const taskId = confirm.task_id || '';

    if (taskId && (confirm.running_number ?? 0) > 0) {
      await this.waitKnowledgeComplete(taskId);
    }

    return { fileIds, taskId };
  }

  async waitKnowledgeComplete(taskId: string, timeoutMs = 180_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const st = (await this.fetchJson(`/knowledge/status/${taskId}`)) as Record<
        string,
        unknown
      >;
      const status = String(st.status ?? st.status_text ?? '');
      const done =
        st.is_completed === true ||
        st.is_complete === true ||
        status === 'complete' ||
        status === 'success';
      if (done) return;
      const failed = status === 'failed' || status === 'error';
      if (failed) throw new Error(`知识库解析失败: ${JSON.stringify(st)}`);
      process.stdout.write(
        `  … knowledge status=${status || '?'} progress=${st.progress_percentage ?? st.progress ?? '-'}\n`,
      );
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error(`知识库解析超时（>${timeoutMs}ms） task=${taskId}`);
  }

  async fillFormFields(
    body: FormFieldsFillRequest,
  ): Promise<FormFieldsFillData> {
    return (await this.fetchJson('/Table/form-fields/fill', {
      method: 'POST',
      body: JSON.stringify(body),
    })) as FormFieldsFillData;
  }
}
