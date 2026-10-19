// Offer to install / update the Claude Code mod (port of QuotaViews.swift ModBanner).
import { useState } from "react";
import type { ModState } from "@ccusage/core/pure";
import { errorMessage } from "../state";
import { Button, IconPlus } from "./ui";

function actionFor(state: ModState): string {
  switch (state) {
    case "outdated":
      return "更新";
    case "legacyStatusLine":
      return "升级";
    default:
      return "安装";
  }
}

function titleFor(state: ModState): string {
  switch (state) {
    case "outdated":
      return "CC mod 有更新";
    case "legacyStatusLine":
      return "升级为 CC mod，不再占用 Claude Code 的状态栏命令";
    default:
      return "安装 CC mod，获取精确的重置时间和用量百分比";
  }
}

function detailFor(state: ModState): string {
  switch (state) {
    case "outdated":
      return "已安装的 mod 与本版本自带的不一致。";
    case "legacyStatusLine":
      return "订阅额度目前由旧版的状态栏脚本记录。升级后改由 mod 记录，settings.json 的 statusLine 恢复为你原先的命令。";
    default:
      return "Claude Code 每轮对话后会测得订阅额度（5 小时 / 每周的已用百分比与重置时间）。安装后由一个 mod 把它记录下来供本 app 读取，并显示在输入框下方。当前窗口时间仅由请求记录和撞限提示推断。";
  }
}

export function ModBanner({ modState, onChanged }: { modState: ModState; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = actionFor(modState);

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.ccusage.installMod();
      if (result.error != null) setError(result.error);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="card mod-banner">
      <div className="mod-banner-icon">
        <IconPlus size={20} />
      </div>
      <div className="mod-banner-body">
        <div className="mod-banner-title">{titleFor(modState)}</div>
        <div className="mod-banner-detail">{detailFor(modState)}</div>
        {error != null && <div className="inline-error">{error}</div>}
        {confirming && (
          <div className="mod-banner-confirm">
            <span>
              将把 mod 写入 Claude Code 的 skills 目录，新开的 Claude Code 会话会自动加载它（ccusage@skills-dir）。
              {modState === "legacyStatusLine" && " 同时会恢复旧脚本接管前的 settings.json statusLine（原文件会先备份）。"}
            </span>
            <div className="mod-banner-actions">
              <Button variant="primary" disabled={busy} onClick={() => void install()}>
                {busy ? "正在" + action + "…" : "确认" + action}
              </Button>
              <Button onClick={() => setConfirming(false)} disabled={busy}>
                取消
              </Button>
            </div>
          </div>
        )}
      </div>
      {!confirming && (
        <div className="mod-banner-actions">
          <Button onClick={() => setConfirming(true)}>{action}…</Button>
        </div>
      )}
    </div>
  );
}
