import { FormEvent, useEffect, useState } from 'react';
import type { AppSettings } from '@/lib/settings/types';
import {
  ALLOWED_API_BASE_URLS,
  ALLOWED_DEEPSEEK_BASE_URLS,
  isAllowedApiBaseUrl,
  isAllowedDeepSeekBaseUrl,
  normalizeApiBaseUrl,
  normalizeDeepSeekBaseUrl,
} from '@/lib/settings/allowlist';
import {
  ensureSettingsLoaded,
  resetSettings,
  saveSettings,
} from '@/lib/settings/store';

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
};

function coerceDraft(s: AppSettings): AppSettings {
  const apiBaseUrl = normalizeApiBaseUrl(s.apiBaseUrl);
  const deepSeekBaseUrl = normalizeDeepSeekBaseUrl(s.deepSeekBaseUrl);
  return {
    ...s,
    apiBaseUrl: isAllowedApiBaseUrl(apiBaseUrl)
      ? apiBaseUrl
      : ALLOWED_API_BASE_URLS[0].value,
    deepSeekBaseUrl: isAllowedDeepSeekBaseUrl(deepSeekBaseUrl)
      ? deepSeekBaseUrl
      : ALLOWED_DEEPSEEK_BASE_URLS[0].value,
  };
}

export function SettingsPanel({ open, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setErr(null);
    void ensureSettingsLoaded().then((s) => setDraft(coerceDraft({ ...s })));
  }, [open]);

  if (!open || !draft) return null;

  function patch<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const next = await saveSettings({
        ...draft,
        deepSeekApiKey: draft.deepSeekApiKey.trim(),
        deepSeekBaseUrl: draft.deepSeekBaseUrl.trim(),
        deepSeekModel: draft.deepSeekModel.trim(),
        apiBaseUrl: draft.apiBaseUrl.trim(),
        defaultUsername: draft.defaultUsername.trim(),
      });
      setDraft(coerceDraft(next));
      setMsg('已保存到本地（browser.storage.local）');
      onSaved(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (!confirm('重置为 .env.local / 内置默认，并清除本地覆盖？')) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const next = await resetSettings();
      setDraft(coerceDraft(next));
      setMsg('已重置为内置默认');
      onSaved(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-panel" onSubmit={(e) => void handleSave(e)}>
      <div className="settings-panel__head">
        <span className="settings-panel__title">设置</span>
        <button
          type="button"
          className="action action--ghost action--sm"
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      <fieldset className="settings-group">
        <legend>DeepSeek</legend>
        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={draft.deepSeekApiKey}
            onChange={(e) => patch('deepSeekApiKey', e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>Base URL（白名单）</span>
          <select
            value={draft.deepSeekBaseUrl}
            onChange={(e) => patch('deepSeekBaseUrl', e.target.value)}
          >
            {ALLOWED_DEEPSEEK_BASE_URLS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Model</span>
          <input
            value={draft.deepSeekModel}
            onChange={(e) => patch('deepSeekModel', e.target.value)}
            spellCheck={false}
          />
        </label>
      </fieldset>

      <fieldset className="settings-group">
        <legend>后端 API</legend>
        <label className="field">
          <span>API Base URL（白名单）</span>
          <select
            value={draft.apiBaseUrl}
            onChange={(e) => patch('apiBaseUrl', e.target.value)}
          >
            {ALLOWED_API_BASE_URLS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-panel__hint">
          仅白名单内地址可保存；新增环境请改{' '}
          <code>lib/settings/allowlist.ts</code> 并同步 manifest 权限。
        </p>
        <label className="field">
          <span>登录预填账号</span>
          <input
            value={draft.defaultUsername}
            onChange={(e) => patch('defaultUsername', e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="field">
          <span>登录预填密码</span>
          <input
            type="password"
            value={draft.defaultPassword}
            onChange={(e) => patch('defaultPassword', e.target.value)}
            autoComplete="current-password"
          />
        </label>
      </fieldset>

      {msg && <p className="settings-panel__ok">{msg}</p>}
      {err && <p className="session-panel__error">{err}</p>}

      <div className="settings-panel__actions">
        <button
          type="button"
          className="action action--ghost"
          disabled={busy}
          onClick={() => void handleReset()}
        >
          重置
        </button>
        <button type="submit" className="action" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}
