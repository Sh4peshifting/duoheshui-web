import type { IScannerControls } from "@zxing/browser";
import {
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Droplets,
  Flame,
  House,
  ListPlus,
  LoaderCircle,
  LogOut,
  Pencil,
  Plus,
  Power,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Snowflake,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, isSessionExpiredError, onSessionExpired, type AccountData, type DeviceInput, type DeviceKind, type DevicesData, type DeviceView } from "./api";
import { TurnstileWidget } from "./TurnstileWidget";

const emptyDevices: DevicesData = { devices: [] };
type Notice = { type: "success" | "error"; text: string } | null;
type Page = "home" | "scan" | "devices";

export function App() {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [devices, setDevices] = useState<DevicesData>(emptyDevices);
  const [page, setPage] = useState<Page>("home");
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<DeviceView | "new" | null>(null);
  const [sessionMessage, setSessionMessage] = useState("");
  const [startupError, setStartupError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadDevices = useCallback(async () => setDevices(await api.devices()), []);

  useEffect(() => onSessionExpired((message) => {
    setSessionMessage(message || "登录状态已失效，请重新登录");
    setAccount({ authenticated: false });
    setDevices(emptyDevices);
    setEditing(null);
    setNotice(null);
    setPage("home");
  }), []);

  useEffect(() => {
    let active = true;
    setStartupError("");
    api.me().then(async (data) => {
      if (!active) return;
      setAccount(data);
      if (data.authenticated) await loadDevices();
    }).catch((caught) => {
      if (!active || isSessionExpiredError(caught)) return;
      setStartupError(caught instanceof Error ? caught.message : "暂时无法连接服务");
    });
    return () => { active = false; };
  }, [loadAttempt, loadDevices]);

  if (startupError) return <StartupErrorScreen message={startupError} onRetry={() => setLoadAttempt((value) => value + 1)} />;
  if (!account) return <LoadingScreen />;
  if (!account.authenticated) {
    return <LoginScreen initialMessage={sessionMessage} onLogin={(data) => { setSessionMessage(""); setAccount(data); setPage("home"); void loadDevices(); }} />;
  }

  const activeDevice = devices.devices.find((device) => device.enabled) ?? null;

  async function logout() {
    await api.logout().catch(() => undefined);
    setAccount({ authenticated: false });
    setDevices(emptyDevices);
    setPage("home");
    setSessionMessage("");
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="compact-brand"><span><Droplets size={20} /></span><div><strong>多喝水</strong><small>小天同学控制台</small></div></div>
        <button className="icon-action" onClick={logout} aria-label="退出登录"><LogOut size={20} /></button>
      </header>

      <section className="page-content">
        {notice && <NoticeBanner notice={notice} />}
        {page === "home" && (
          <HomePage
            account={account}
            activeDevice={activeDevice}
            onAccount={setAccount}
            onNotice={setNotice}
            onManageDevices={() => { setNotice(null); setPage("devices"); }}
          />
        )}
        {page === "scan" && <TemporaryScanPage onNotice={setNotice} />}
        {page === "devices" && (
          <DevicesPage
            devices={devices.devices}
            onAdd={() => setEditing("new")}
            onEdit={setEditing}
            onChanged={loadDevices}
            onNotice={setNotice}
          />
        )}
      </section>

      <BottomNavigation page={page} onChange={(next) => { setNotice(null); setPage(next); }} />

      {editing && (
        <DeviceEditor
          current={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (label) => {
            await loadDevices();
            setEditing(null);
            setNotice({ type: "success", text: `${label}已保存` });
          }}
        />
      )}
    </main>
  );
}

function LoadingScreen() {
  return <main className="loading-screen" aria-live="polite"><div className="brand-mark"><Droplets size={28} /></div><LoaderCircle className="spin" size={22} /><span>正在安全连接…</span></main>;
}

function StartupErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <main className="loading-screen startup-error" role="alert"><div className="brand-mark"><CircleAlert size={26} /></div><strong>暂时无法载入账号</strong><span>{message}</span><button className="primary-action" onClick={onRetry}><RefreshCw size={17} />重新加载</button></main>;
}

type LoginMode = "password" | "code";

function LoginScreen({ initialMessage, onLogin }: { initialMessage: string; onLogin: (account: AccountData) => void }) {
  const [mode, setMode] = useState<LoginMode>("password");
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState<"send" | "login" | null>(null);
  const [error, setError] = useState(initialMessage);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileError, setTurnstileError] = useState("");
  const [turnstileVersion, setTurnstileVersion] = useState(0);

  const acceptTurnstileToken = useCallback((token: string) => {
    setTurnstileToken(token);
    if (token) setTurnstileError("");
  }, []);
  const reportTurnstileError = useCallback(() => {
    setTurnstileToken("");
    setTurnstileError("人机验证加载失败，请刷新页面重试");
  }, []);

  useEffect(() => {
    let active = true;
    api.config().then(({ turnstileSiteKey: siteKey }) => {
      if (active) setTurnstileSiteKey(siteKey);
    }).catch((caught) => {
      if (active) setTurnstileError(caught instanceof Error ? caught.message : "人机验证加载失败，请刷新页面重试");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  async function sendCode() {
    setError("");
    if (!/^1[3-9]\d{9}$/.test(mobile)) return setError("请输入有效的中国大陆手机号");
    if (!turnstileToken) return setError("请先完成人机验证");
    setBusy("send");
    try { const result = await api.sendCode(mobile, turnstileToken); setSent(true); setCountdown(result.retryAfter); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "验证码发送失败，请稍后再试"); }
    finally { setBusy(null); setTurnstileToken(""); setTurnstileVersion((value) => value + 1); }
  }

  async function login(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!/^1[3-9]\d{9}$/.test(mobile)) return setError("请输入有效的中国大陆手机号");
    if (mode === "code" && !/^\d{4,8}$/.test(code)) return setError("请输入收到的短信验证码");
    if (mode === "password" && (!password || password.length > 128)) return setError("请输入账号密码");
    if (!turnstileToken) return setError("请先完成人机验证");
    setBusy("login");
    try {
      onLogin(mode === "password" ? await api.loginWithPassword(mobile, password, turnstileToken) : await api.login(mobile, code, turnstileToken));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败，请检查登录信息");
    }
    finally { setBusy(null); setTurnstileToken(""); setTurnstileVersion((value) => value + 1); }
  }

  function changeMode(next: LoginMode) {
    if (busy) return;
    setMode(next);
    setError("");
  }

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-row"><div className="brand-mark"><Droplets size={27} strokeWidth={1.8} /></div><span>DUOHESHUI WEB</span></div>
        <div className="login-copy"><p className="eyebrow">欢迎回来</p><h1 id="login-title">小天同学</h1><p>登录后查看余额、管理常用设备，或直接扫描临时设备二维码。</p></div>
        <div className="login-mode-switch" role="tablist" aria-label="登录方式">
          <button type="button" role="tab" aria-selected={mode === "password"} className={mode === "password" ? "active" : ""} onClick={() => changeMode("password")}>密码登录</button>
          <button type="button" role="tab" aria-selected={mode === "code"} className={mode === "code" ? "active" : ""} onClick={() => changeMode("code")}>验证码登录</button>
        </div>
        <form className="login-form" onSubmit={login}>
          <label htmlFor="mobile">手机号</label>
          <div className="phone-field"><span>+86</span><input id="mobile" inputMode="tel" autoComplete="tel" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 11))} placeholder="请输入手机号" disabled={busy !== null} /></div>
          {mode === "password" && <><label htmlFor="password">密码</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value.slice(0, 128))} placeholder="请输入账号密码" disabled={busy !== null} /></>}
          {mode === "code" && sent && <><label htmlFor="code">验证码</label><input id="code" className="code-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="请输入短信验证码" disabled={busy !== null} autoFocus /></>}
          {turnstileSiteKey ? <TurnstileWidget key={turnstileVersion} siteKey={turnstileSiteKey} onToken={acceptTurnstileToken} onError={reportTurnstileError} /> : !turnstileError && <div className="turnstile-placeholder"><LoaderCircle className="spin" size={17} />正在加载人机验证</div>}
          {(error || turnstileError) && <p className="form-error" role="alert"><CircleAlert size={16} />{error || turnstileError}</p>}
          {mode === "password" ? (
            <button type="submit" className="primary-action" disabled={busy !== null || !mobile || !password || !turnstileToken}>{busy === "login" ? <><LoaderCircle className="spin" size={18} />正在登录</> : <>登录<ChevronRight size={18} /></>}</button>
          ) : !sent ? (
            <button type="button" className="primary-action" onClick={sendCode} disabled={busy !== null || !turnstileToken}>{busy === "send" ? <><LoaderCircle className="spin" size={18} />正在发送</> : <>获取验证码<ChevronRight size={18} /></>}</button>
          ) : <><button type="submit" className="primary-action" disabled={busy !== null || !code || !turnstileToken}>{busy === "login" ? <><LoaderCircle className="spin" size={18} />正在登录</> : <>登录<ChevronRight size={18} /></>}</button><button type="button" className="text-action" onClick={sendCode} disabled={countdown > 0 || busy !== null || !turnstileToken}>{countdown > 0 ? `${countdown} 秒后可重新发送` : "重新发送验证码"}</button></>}
        </form>
        <p className="login-hint">建议使用密码登录；短信验证码频繁请求可能触发上游限制。</p>
        <p className="privacy-note"><ShieldCheck size={16} />登录凭据仅由安全服务器处理</p>
      </section>
      <p className="disclaimer">非官方客户端 · 仅限操作本人有权使用的账号与设备</p>
    </main>
  );
}

function NoticeBanner({ notice }: { notice: Exclude<Notice, null> }) {
  return <div className={`notice ${notice.type}`} role="status">{notice.type === "success" ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}{notice.text}</div>;
}

function HomePage({ account, activeDevice, onAccount, onNotice, onManageDevices }: {
  account: AccountData;
  activeDevice: DeviceView | null;
  onAccount: (account: AccountData) => void;
  onNotice: (notice: Notice) => void;
  onManageDevices: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState<DeviceKind | null>(null);

  async function refresh() {
    setRefreshing(true); onNotice(null);
    try { const result = await api.refreshBalance(); onAccount({ ...account, balance: result.balance }); onNotice({ type: "success", text: "余额已刷新" }); }
    catch (caught) { onNotice({ type: "error", text: caught instanceof Error ? caught.message : "余额刷新失败" }); }
    finally { setRefreshing(false); }
  }

  async function startWater(kind: DeviceKind) {
    if (!activeDevice?.[kind].bound) return onManageDevices();
    setStarting(kind); onNotice(null);
    try {
      await api.startWater(kind, crypto.randomUUID());
      onNotice({ type: "success", text: "设备已解锁，请在饮水机上按键出水" });
    } catch (caught) {
      onNotice({ type: "error", text: caught instanceof Error ? caught.message : "解锁失败，请检查设备状态" });
    } finally { setStarting(null); }
  }

  return (
    <div className="home-grid">
      <section className="account-card">
        <div><span className="section-kicker">账户</span><strong className="mobile-number">{account.mobile}</strong></div>
        <div className="balance-block"><span>余额</span><strong><small>¥</small>{account.balance ?? "0.00"}</strong></div>
        <button className="refresh-action" onClick={refresh} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} size={16} />{refreshing ? "刷新中" : "刷新余额"}</button>
      </section>

      <section className="control-section" aria-labelledby="controls-title">
        <div className="control-heading">
          <div><span className="section-kicker">当前设备</span><h2 id="controls-title">{activeDevice?.label ?? "尚未选择设备"}</h2></div>
          <button className="outline-action" onClick={onManageDevices}>{activeDevice ? "切换设备" : "添加设备"}<ChevronRight size={16} /></button>
        </div>
        <div className="control-grid">
          {(["hot", "cold"] as const).map((kind) => (
            <button key={kind} className={`water-control ${kind}`} onClick={() => startWater(kind)} disabled={starting !== null}>
              <span className="control-icon">{kind === "hot" ? <Flame size={27} /> : <Snowflake size={27} />}</span>
              <span><strong>{starting === kind ? "正在解锁…" : kind === "hot" ? "热 水" : "冷 水"}</strong><small>{activeDevice?.[kind].bound ? activeDevice[kind].fingerprint : "尚未绑定此出水口"}</small></span>
            </button>
          ))}
        </div>
        <p className="safety-caption"><ShieldCheck size={15} />网页仅解锁设备，仍需在饮水机上按键；指令不会自动重试</p>
      </section>
    </div>
  );
}

function DevicesPage({ devices, onAdd, onEdit, onChanged, onNotice }: {
  devices: DeviceView[];
  onAdd: () => void;
  onEdit: (device: DeviceView) => void;
  onChanged: () => Promise<void>;
  onNotice: (notice: Notice) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function activate(device: DeviceView) {
    if (device.enabled) return;
    setBusyId(device.id); onNotice(null);
    try { await api.activateDevice(device.id); await onChanged(); onNotice({ type: "success", text: `已启用${device.label}` }); }
    catch (caught) { onNotice({ type: "error", text: caught instanceof Error ? caught.message : "切换设备失败" }); }
    finally { setBusyId(null); }
  }

  async function remove(device: DeviceView) {
    if (!window.confirm(`确认删除“${device.label}”？`)) return;
    setBusyId(device.id); onNotice(null);
    try { await api.deleteDevice(device.id); await onChanged(); onNotice({ type: "success", text: "设备已删除" }); }
    catch (caught) { onNotice({ type: "error", text: caught instanceof Error ? caught.message : "删除设备失败" }); }
    finally { setBusyId(null); }
  }

  return (
    <div className="devices-page">
      <div className="page-heading"><div><span className="section-kicker">我的设备</span><h1>常用饮水机</h1></div><button className="add-action" onClick={onAdd} aria-label="添加设备"><Plus size={18} /><span>添加设备</span></button></div>
      {devices.length === 0 ? (
        <section className="empty-state"><Smartphone size={36} /><h2>还没有保存设备</h2><p>添加常用饮水机后，即可从首页快速解锁。</p><button className="primary-action" onClick={onAdd}><Plus size={18} />添加第一台设备</button></section>
      ) : (
        <div className="saved-device-list">
          {devices.map((device) => (
            <article className={`saved-device-card ${device.enabled ? "enabled" : ""}`} key={device.id}>
              <div className="saved-device-header"><div><span className="device-status">{device.enabled ? <><Check size={14} />当前启用</> : "未启用"}</span><h2>{device.label}</h2></div><button className="icon-action" onClick={() => onEdit(device)} aria-label={`修改${device.label}`}><Pencil size={17} /></button></div>
              <div className="outlet-summary"><OutletStatus kind="hot" outlet={device.hot} /><OutletStatus kind="cold" outlet={device.cold} /></div>
              <div className="card-actions">
                <button className="select-action" onClick={() => activate(device)} disabled={device.enabled || busyId === device.id}><Power size={16} />{device.enabled ? "正在使用" : busyId === device.id ? "切换中" : "设为当前设备"}</button>
                <button className="delete-action" onClick={() => remove(device)} disabled={busyId === device.id}><Trash2 size={16} />删除</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function OutletStatus({ kind, outlet }: { kind: DeviceKind; outlet: DeviceView[DeviceKind] }) {
  return <div className={`outlet-status ${kind}`}><span>{kind === "hot" ? <Flame size={18} /> : <Snowflake size={18} />}</span><div><strong>{kind === "hot" ? "热水口" : "冷水口"}</strong><small>{outlet.bound ? outlet.fingerprint : "未绑定"}</small></div></div>;
}

function TemporaryScanPage({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const [manualKey, setManualKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function unlock(deviceKey: string) {
    if (busy || !deviceKey.trim()) return;
    setBusy(true); onNotice(null);
    try {
      await api.startTemporaryWater(deviceKey.trim(), crypto.randomUUID());
      setManualKey("");
      onNotice({ type: "success", text: "临时设备已解锁，请在饮水机上按键出水" });
    } catch (caught) {
      onNotice({ type: "error", text: caught instanceof Error ? caught.message : "临时设备解锁失败" });
    } finally { setBusy(false); }
  }

  return (
    <div className="scan-page">
      <div className="page-heading"><div><span className="section-kicker">临时使用</span><h1>直接扫码解锁</h1><p>二维码只用于本次请求，不会保存到我的设备。</p></div></div>
      <section className="scan-card">
        <QrScanner onResult={unlock} disabled={busy} />
        <div className="or-divider"><span>或手工输入</span></div>
        <form className="device-form" onSubmit={(event) => { event.preventDefault(); void unlock(manualKey); }}>
          <label htmlFor="temporary-key">二维码原始内容</label>
          <textarea id="temporary-key" value={manualKey} onChange={(event) => setManualKey(event.target.value.slice(0, 2048))} rows={3} placeholder="粘贴临时设备二维码内容" />
          <button className="primary-action" type="submit" disabled={busy || !manualKey.trim()}>{busy ? <><LoaderCircle className="spin" size={18} />正在解锁</> : <><QrCode size={18} />立即解锁</>}</button>
        </form>
      </section>
    </div>
  );
}

function QrScanner({ onResult, disabled = false }: { onResult: (value: string) => void | Promise<void>; disabled?: boolean }) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const deliveredRef = useRef(false);
  const stopScan = useCallback(() => { controlsRef.current?.stop(); controlsRef.current = null; setScanning(false); }, []);
  useEffect(() => stopScan, [stopScan]);

  async function scan() {
    setError(""); setScanning(true); deliveredRef.current = false;
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader();
      controlsRef.current = await reader.decodeFromVideoDevice(undefined, videoRef.current!, (result) => {
        if (!result || deliveredRef.current) return;
        deliveredRef.current = true;
        const value = result.getText();
        stopScan();
        void onResult(value);
      });
    } catch {
      setScanning(false);
      setError("无法打开相机，请允许相机权限或手工粘贴二维码内容");
    }
  }

  return <><div className={`scanner ${scanning ? "active" : ""}`}><video ref={videoRef} muted playsInline />{!scanning && <div><Camera size={32} /><strong>对准饮水机二维码</strong></div>}</div><button type="button" className="scan-action" onClick={scanning ? stopScan : scan} disabled={disabled}><Camera size={18} />{scanning ? "停止扫描" : "打开相机扫描"}</button>{error && <p className="form-error" role="alert"><CircleAlert size={16} />{error}</p>}</>;
}

function DeviceEditor({ current, onClose, onSaved }: { current: DeviceView | null; onClose: () => void; onSaved: (label: string) => Promise<void> }) {
  const [label, setLabel] = useState(current?.label ?? "");
  const [hotKey, setHotKey] = useState("");
  const [coldKey, setColdKey] = useState("");
  const [removeHot, setRemoveHot] = useState(false);
  const [removeCold, setRemoveCold] = useState(false);
  const [scanKind, setScanKind] = useState<DeviceKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const resultingHot = Boolean(hotKey.trim()) || Boolean(current?.hot.bound && !removeHot);
  const resultingCold = Boolean(coldKey.trim()) || Boolean(current?.cold.bound && !removeCold);

  async function save(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!label.trim()) return setError("请输入设备备注");
    if (!resultingHot && !resultingCold) return setError("至少绑定一个热水口或冷水口二维码");
    setBusy(true);
    try {
      if (!current) {
        await api.createDevice({ label: label.trim(), ...(hotKey.trim() ? { hotKey: hotKey.trim() } : {}), ...(coldKey.trim() ? { coldKey: coldKey.trim() } : {}) });
      } else {
        const input: Partial<DeviceInput> = { label: label.trim() };
        if (hotKey.trim()) input.hotKey = hotKey.trim(); else if (removeHot) input.hotKey = null;
        if (coldKey.trim()) input.coldKey = coldKey.trim(); else if (removeCold) input.coldKey = null;
        await api.updateDevice(current.id, input);
      }
      await onSaved(label.trim());
    } catch (caught) { setError(caught instanceof Error ? caught.message : "设备保存失败"); setBusy(false); }
  }

  function acceptScan(value: string) {
    if (scanKind === "hot") { setHotKey(value); setRemoveHot(false); }
    if (scanKind === "cold") { setColdKey(value); setRemoveCold(false); }
    setScanKind(null);
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="device-dialog" role="dialog" aria-modal="true" aria-labelledby="device-editor-title">
        <div className="dialog-header"><div><span className="device-icon neutral"><Smartphone size={20} /></span><div><span className="section-kicker">设备管理</span><h2 id="device-editor-title">{current ? "修改设备" : "添加设备"}</h2></div></div><button className="icon-action" onClick={onClose} aria-label="关闭"><X size={20} /></button></div>
        {scanKind && <div className="editor-scanner"><div className="scan-target">正在绑定{scanKind === "hot" ? "热水口" : "冷水口"}</div><QrScanner onResult={acceptScan} disabled={busy} /><button className="text-action" onClick={() => setScanKind(null)}>返回编辑</button></div>}
        {!scanKind && <form className="device-form" onSubmit={save}>
          <label htmlFor="device-label">设备备注</label><div className="label-input"><Smartphone size={17} /><input id="device-label" value={label} onChange={(event) => setLabel(event.target.value.slice(0, 64))} placeholder="例如：宿舍走廊" /></div>
          <OutletEditor kind="hot" current={current?.hot} value={hotKey} removed={removeHot} onValue={setHotKey} onRemove={setRemoveHot} onScan={() => setScanKind("hot")} />
          <OutletEditor kind="cold" current={current?.cold} value={coldKey} removed={removeCold} onValue={setColdKey} onRemove={setRemoveCold} onScan={() => setScanKind("cold")} />
          {error && <p className="form-error" role="alert"><CircleAlert size={16} />{error}</p>}
          <button className="primary-action" type="submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={18} />正在保存</> : "保存设备"}</button>
        </form>}
      </section>
    </div>
  );
}

function OutletEditor({ kind, current, value, removed, onValue, onRemove, onScan }: {
  kind: DeviceKind;
  current?: DeviceView[DeviceKind];
  value: string;
  removed: boolean;
  onValue: (value: string) => void;
  onRemove: (value: boolean) => void;
  onScan: () => void;
}) {
  const title = kind === "hot" ? "热水口二维码" : "冷水口二维码";
  const preserved = current?.bound && !removed && !value;
  return <fieldset className={`outlet-editor ${kind}`}><legend>{kind === "hot" ? <Flame size={17} /> : <Snowflake size={17} />}{title}</legend>{preserved && <div className="existing-binding"><CheckCircle2 size={16} /><span>已绑定 {current.fingerprint}</span><button type="button" onClick={() => onRemove(true)}>移除</button></div>}{removed && <div className="removed-binding"><span>保存后将移除此出水口</span><button type="button" onClick={() => onRemove(false)}>撤销</button></div>}<textarea value={value} onChange={(event) => { onValue(event.target.value.slice(0, 2048)); if (event.target.value) onRemove(false); }} rows={2} placeholder={current?.bound ? "留空则保持原二维码，粘贴可重新绑定" : "粘贴二维码原始内容"} /><button type="button" className="inline-scan-action" onClick={onScan}><Camera size={16} />扫描{kind === "hot" ? "热水" : "冷水"}二维码</button></fieldset>;
}

function BottomNavigation({ page, onChange }: { page: Page; onChange: (page: Page) => void }) {
  const items: Array<{ id: Page; label: string; icon: typeof House }> = [
    { id: "home", label: "首页", icon: House },
    { id: "scan", label: "扫码", icon: QrCode },
    { id: "devices", label: "设备", icon: ListPlus },
  ];
  return <nav className="bottom-navigation" aria-label="主要导航">{items.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? "active" : ""} onClick={() => onChange(id)} aria-current={page === id ? "page" : undefined}><Icon size={21} /><span>{label}</span></button>)}</nav>;
}
