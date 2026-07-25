/** 统一带时间戳日志。
 *  扩展内 console 默认只在各上下文 DevTools 可见；
 *  已通过 `wxt-module-console-forward` 转发到 `pnpm dev` 终端。
 */
export type LogScope = 'bg' | 'content' | 'sidepanel' | 'ai' | 'cli' | 'agent' | 'api' | 'settings';

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function slog(scope: LogScope, message: string, extra?: unknown): void {
  const line = `[Snapfill ${stamp()}] [${scope}] ${message}`;
  if (extra !== undefined) {
    console.log(line, extra);
  } else {
    console.log(line);
  }
}

export function swarn(scope: LogScope, message: string, extra?: unknown): void {
  const line = `[Snapfill ${stamp()}] [${scope}] ${message}`;
  if (extra !== undefined) {
    console.warn(line, extra);
  } else {
    console.warn(line);
  }
}

export function serror(scope: LogScope, message: string, extra?: unknown): void {
  const line = `[Snapfill ${stamp()}] [${scope}] ${message}`;
  if (extra !== undefined) {
    console.error(line, extra);
  } else {
    console.error(line);
  }
}

export function elapsed(startedAt: number): string {
  return `${Date.now() - startedAt}ms`;
}
