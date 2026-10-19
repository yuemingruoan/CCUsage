// Settings window. Reuses index.html?view=settings&tab=general|quota|pricing|server.
// Port of SettingsView.swift plus the new 服务端 sync tab.
import { useEffect, useState } from "react";
import type { AppSettings, AppState, ModState, ServerConfig, WindowMode } from "@ccusage/core/pure";
import type { CcusagePaths } from "../api";
import { configFilePath, deviceTodayStats } from "../data";
import { dateTime, planDisplayName, WINDOW_MODE_LABELS } from "../format";
import { errorMessage, useAppState } from "../state";
import { DeviceTable, PricingTable } from "../components/tables";
import { Button, Field, Select, SettingsTabs, Spinner } from "../components/ui";
import { SyncBadge } from "../components/tables";

type SettingsTab = "general" | "quota" | "pricing" | "server";

const TABS: readonly { key: SettingsTab; label: string }[] = [
  { key: "general", label: "通用" },
  { key: "quota", label: "额度" },
  { key: "pricing", label: "定价" },
  { key: "server", label: "服务端" },
];

function initialTabFromQuery(raw: string | null): SettingsTab {
  const match = TABS.find((tab) => tab.key === raw);
  return match?.key ?? "general";
}

/** Optional preload extensions (feature-detected, absent is fine). */
function useCcusagePaths(): CcusagePaths | null {
  const [paths, setPaths] = useState<CcusagePaths | null>(null);
  useEffect(() => {
    let alive = true;
    const api = window.ccusage;
    if (api.getPaths != null) {
      api
        .getPaths()
        .then((value) => {
          if (alive) setPaths(value);
        })
        .catch(() => {
          // Paths are cosmetic; fall back to derived values.
        });
    }
    return () => {
      alive = false;
    };
  }, []);
  return paths;
}

export function SettingsWindow({ initialTab }: { initialTab: string | null }) {
  const { state, error, refreshState } = useAppState();
  const [tab, setTab] = useState<SettingsTab>(() => initialTabFromQuery(initialTab));

  if (state == null) {
    return (
      <div className="settings-window">
        <div className="settings-loading">
          <Spinner />
          <span>正在读取设置…</span>
          {error != null && <div className="inline-error">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="settings-window">
      <SettingsTabs
        tabs={TABS.map((entry) => ({ value: entry.key, label: entry.label }))}
        value={tab}
        onChange={setTab}
      />
      <div className="settings-content" role="tabpanel">
        {tab === "general" && <GeneralTab state={state} refreshState={refreshState} />}
        {tab === "quota" && <QuotaTab state={state} refreshState={refreshState} />}
        {tab === "pricing" && <PricingTab />}
        {tab === "server" && <ServerTab state={state} refreshState={refreshState} />}
      </div>
    </div>
  );
}

// MARK: - 通用

const REFRESH_OPTIONS = [
  { value: "30", label: "30 秒" },
  { value: "60", label: "1 分钟" },
  { value: "300", label: "5 分钟" },
  { value: "900", label: "15 分钟" },
];

const THEME_OPTIONS: readonly { value: AppSettings["theme"]; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

function GeneralTab({ state, refreshState }: { state: AppState; refreshState: () => Promise<void> }) {
  const paths = useCcusagePaths();
  const [projectsPath, setProjectsPath] = useState(state.settings.projectsPath);
  const [refreshSeconds, setRefreshSeconds] = useState(String(state.settings.refreshIntervalSeconds));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setProjectsPath(state.settings.projectsPath), [state.settings.projectsPath]);
  useEffect(
    () => setRefreshSeconds(String(state.settings.refreshIntervalSeconds)),
    [state.settings.refreshIntervalSeconds],
  );

  async function update(patch: Parameters<typeof window.ccusage.updateSettings>[0]) {
    setBusy(true);
    setError(null);
    try {
      await window.ccusage.updateSettings(patch);
      await refreshState();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function commitProjectsPath(next: string) {
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === state.settings.projectsPath) return;
    setProjectsPath(trimmed);
    await update({ projectsPath: trimmed });
  }

  async function chooseDirectory() {
    const api = window.ccusage;
    if (api.chooseDirectory == null) {
      setError("当前版本不支持目录选择，请直接填写路径后按回车。");
      return;
    }
    try {
      const chosen = await api.chooseDirectory();
      if (chosen != null) await commitProjectsPath(chosen);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function useDefault() {
    let next = "~/.claude/projects";
    try {
      if (window.ccusage.defaultProjectsPath != null) next = await window.ccusage.defaultProjectsPath();
    } catch {
      // Fall back to the conventional path.
    }
    setProjectsPath(next);
    await update({ projectsPath: next });
  }

  return (
    <div className="settings-form">
      <Field label="会话记录目录">
        <div className="field-inline">
          <input
            className="input input-wide mono"
            value={projectsPath}
            spellCheck={false}
            onChange={(event) => setProjectsPath(event.target.value)}
            onBlur={() => void commitProjectsPath(projectsPath)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void commitProjectsPath(projectsPath);
            }}
          />
          <Button disabled={busy} onClick={() => void chooseDirectory()}>
            选择…
          </Button>
          <Button disabled={busy} onClick={() => void useDefault()}>
            默认
          </Button>
        </div>
      </Field>
      <Field label="自动刷新">
        <Select
          value={refreshSeconds}
          onChange={(value) => {
            setRefreshSeconds(value);
            void update({ refreshIntervalSeconds: Number(value) });
          }}
          options={REFRESH_OPTIONS}
        />
      </Field>
      <Field label="外观">
        <Select
          value={state.settings.theme}
          onChange={(value) => void update({ theme: value })}
          options={THEME_OPTIONS}
        />
      </Field>
      <Field label="CC 成本记录">
        <span className="mono-secondary selectable">
          {paths?.configFile ?? configFilePath(state.settings.projectsPath)}
        </span>
      </Field>
      {busy && <div className="caption-secondary">正在保存…</div>}
      {error != null && <div className="inline-error">{error}</div>}
    </div>
  );
}

// MARK: - 额度

function modText(modState: ModState): string {
  switch (modState) {
    case "installed":
      return "已安装";
    case "outdated":
      return "已安装（有更新）";
    case "notInstalled":
      return "未安装";
    case "legacyStatusLine":
      return "仍在使用旧的状态栏脚本，升级后恢复原 statusLine";
  }
}

function QuotaTab({ state, refreshState }: { state: AppState; refreshState: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = state.quota.plan;
  const paths = useCcusagePaths();
  const logPath = paths?.rateLimitsLog;

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.ccusage.installMod();
      if (result.error != null) setError(result.error);
      await refreshState();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function uninstall() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.ccusage.uninstallMod();
      if (result.error != null) setError(result.error);
      await refreshState();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeWindowMode(windowMode: WindowMode) {
    setBusy(true);
    setError(null);
    try {
      await window.ccusage.updateSettings({ windowMode });
      await refreshState();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-form">
      <Field label="当前套餐">
        <span>{plan != null ? planDisplayName(plan.tier) + "（" + plan.tier + "）" : "未知"}</span>
      </Field>
      <Field label="CC mod">
        <div className="field-inline">
          <span className="field-value">{modText(state.modState)}</span>
          <span className="settings-actions-inline">
            {state.modState === "installed" && (
              <Button disabled={busy} onClick={() => void uninstall()}>
                卸载
              </Button>
            )}
            {state.modState === "outdated" && (
              <>
                <Button variant="primary" disabled={busy} onClick={() => void install()}>
                  更新
                </Button>
                <Button disabled={busy} onClick={() => void uninstall()}>
                  卸载
                </Button>
              </>
            )}
            {state.modState === "legacyStatusLine" && (
              <Button variant="primary" disabled={busy} onClick={() => void install()}>
                升级
              </Button>
            )}
            {state.modState === "notInstalled" && (
              <Button variant="primary" disabled={busy} onClick={() => void install()}>
                安装
              </Button>
            )}
            {busy && <Spinner small />}
          </span>
        </div>
      </Field>
      <Field label="上报记录">
        <span className="mono-secondary selectable">
          {state.quota.statusLineObservationCount} 条
          {logPath != null ? " · " + logPath : " · rate-limits.jsonl（app 数据目录）"}
        </span>
      </Field>
      <Field label="5 小时窗口">
        <Select
          value={state.settings.windowMode}
          onChange={(value) => void changeWindowMode(value)}
          options={[
            { value: "firstRequest", label: WINDOW_MODE_LABELS.firstRequest },
            { value: "fixedRolling", label: WINDOW_MODE_LABELS.fixedRolling },
          ]}
        />
      </Field>
      <p className="caption-text">
        仅影响没有 CC 上报的时段。首条请求开启窗口：与历史撞限提示的重置时间一致；固定周期滚动：从最近一次上报的重置时间起每 5
        小时一个窗口。每周窗口始终按上报的重置时间滚动。套餐升降级（记录或推断）之前的窗口不参与额度估算。
      </p>
      {error != null && <div className="inline-error">{error}</div>}
    </div>
  );
}

// MARK: - 定价

function PricingTab() {
  return (
    <div className="settings-form">
      <p className="caption-text">
        Anthropic API 标价（美元 / 百万 tokens）。缓存写入 5m = 1.25× 输入，1h = 2× 输入；网页搜索 $10 /
        千次。订阅用户看到的是按此价格折算的等值金额，并非实际扣费。
      </p>
      <PricingTable height={340} />
    </div>
  );
}

// MARK: - 服务端 (new)

interface ActionOutcome {
  ok?: boolean;
  error?: string;
}

function statusDetail(state: AppState): string {
  const sync = state.sync;
  const parts: string[] = [];
  if (sync.lastSyncAt != null) parts.push("上次同步 " + dateTime(sync.lastSyncAt));
  if (sync.pendingEntries > 0) parts.push("待上传 " + sync.pendingEntries + " 条");
  if (sync.account != null) parts.push("账号 " + sync.account.username);
  return parts.join(" · ");
}

function ServerTab({ state, refreshState }: { state: AppState; refreshState: () => Promise<void> }) {
  const server: ServerConfig = state.settings.server;
  const sync = state.sync;
  const [url, setUrl] = useState(server.url);
  const [deviceName, setDeviceName] = useState(server.deviceName);
  const [username, setUsername] = useState(server.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setUrl(server.url), [server.url]);
  useEffect(() => setDeviceName(server.deviceName), [server.deviceName]);
  useEffect(() => setUsername(server.username ?? ""), [server.username]);

  async function run(label: string, action: () => Promise<ActionOutcome | void>, success: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const outcome = await action();
      if (outcome != null && outcome.ok === false) setError(outcome.error ?? label + "失败");
      else {
        setNotice(success);
        await refreshState();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function saveConfig() {
    void run(
      "保存设置",
      async () => {
        const saved = await window.ccusage.sync.configure({
          url: url.trim(),
          deviceName: deviceName.trim(),
        });
        setUrl(saved.server.url);
        setDeviceName(saved.server.deviceName);
      },
      "服务器设置已保存",
    );
  }

  function toggleEnabled(enabled: boolean) {
    void run(
      enabled ? "启用同步" : "停用同步",
      async () => {
        await window.ccusage.sync.configure({ enabled });
      },
      enabled ? "已启用同步" : "已停用同步",
    );
  }

  function login() {
    if (username.trim().length === 0 || password.length === 0) {
      setError("请填写用户名和密码。");
      return;
    }
    if (url.trim().length === 0) {
      setError("请先填写服务器 URL。");
      return;
    }
    void run(
      "登录",
      async () => {
        if (url.trim() !== server.url) {
          await window.ccusage.sync.configure({ url: url.trim(), deviceName: deviceName.trim() });
        }
        const result = await window.ccusage.sync.login(username.trim(), password);
        if (result.ok) setPassword("");
        return result;
      },
      "登录成功",
    );
  }

  function register() {
    if (username.trim().length === 0 || password.length === 0) {
      setError("请填写用户名和密码。");
      return;
    }
    if (url.trim().length === 0) {
      setError("请先填写服务器 URL。");
      return;
    }
    void run(
      "注册",
      async () => {
        if (url.trim() !== server.url) {
          await window.ccusage.sync.configure({ url: url.trim(), deviceName: deviceName.trim() });
        }
        const result = await window.ccusage.sync.register(username.trim(), password);
        if (result.ok) setPassword("");
        return result;
      },
      "注册成功，已登录",
    );
  }

  function syncNow() {
    void run("立即同步", () => window.ccusage.sync.now(), "同步完成");
  }

  function logout() {
    void run("退出登录", async () => window.ccusage.sync.logout(), "已退出登录");
  }

  const deviceStats = deviceTodayStats(state.snapshot.entries, Date.now());
  const detail = statusDetail(state);

  return (
    <div className="settings-form settings-server">
      <Field label="启用同步">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={server.enabled}
            disabled={busy != null}
            onChange={(event) => toggleEnabled(event.target.checked)}
          />
          <span>与自建服务器同步多设备用量（5 小时 / 每周额度包含所有设备）</span>
        </label>
      </Field>

      <Field label="服务器 URL">
        <div className="field-inline">
          <input
            className="input input-wide mono"
            value={url}
            spellCheck={false}
            placeholder="http://127.0.0.1:8787"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveConfig();
            }}
          />
          <Button disabled={busy != null} onClick={saveConfig}>
            保存
          </Button>
        </div>
      </Field>

      <Field label="设备名">
        <div className="field-inline">
          <input
            className="input"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveConfig();
            }}
          />
        </div>
      </Field>

      <div className="settings-divider" />

      <Field label="账号">
        <div className="field-inline">
          <input
            className="input"
            value={username}
            autoComplete="username"
            placeholder="用户名"
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
      </Field>
      <Field label="密码">
        <div className="field-inline">
          <input
            className="input"
            type="password"
            value={password}
            autoComplete="current-password"
            placeholder="密码"
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") login();
            }}
          />
        </div>
      </Field>
      <div className="settings-actions">
        <Button variant="primary" disabled={busy != null} onClick={login}>
          {busy === "登录" ? "登录中…" : "登录"}
        </Button>
        <Button disabled={busy != null} onClick={register}>
          {busy === "注册" ? "注册中…" : "注册"}
        </Button>
        {sync.account != null && (
          <Button variant="danger" disabled={busy != null} onClick={logout}>
            退出登录
          </Button>
        )}
      </div>

      <Field label="同步状态">
        <div className="field-inline">
          <SyncBadge sync={sync} />
          <span className="caption-secondary">{detail.length > 0 ? detail : "尚未同步"}</span>
        </div>
      </Field>
      {sync.error != null && sync.error.length > 0 && <div className="inline-error">{sync.error}</div>}

      <Field label="设备列表" top>
        <DeviceTable
          devices={sync.devices}
          selfDeviceId={server.deviceId}
          todayStats={deviceStats}
          now={Date.now()}
          height={150}
        />
      </Field>

      <div className="settings-actions">
        <Button variant="primary" disabled={busy != null} onClick={syncNow}>
          {busy === "立即同步" ? "正在同步…" : "立即同步"}
        </Button>
        {busy != null && <Spinner small />}
      </div>

      {error != null && <div className="inline-error">{error}</div>}
      {notice != null && <div className="inline-notice">{notice}</div>}
    </div>
  );
}
