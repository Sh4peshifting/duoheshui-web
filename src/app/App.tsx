import type { IScannerControls } from "@zxing/browser";
import { Camera, CheckCircle2, ChevronRight, CircleAlert, Droplets, Flame, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Snowflake, Smartphone, Trash2, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type AccountData, type DeviceKind, type DevicesData } from "./api";

const emptyDevices: DevicesData = { hot: { bound: false, label: "热水" }, cold: { bound: false, label: "冷水" } };
type Notice = { type: "success" | "error"; text: string } | null;

export function App() {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [devices, setDevices] = useState<DevicesData>(emptyDevices);
  const [notice, setNotice] = useState<Notice>(null);
  const [bindingKind, setBindingKind] = useState<DeviceKind | null>(null);
  const loadDevices = useCallback(async () => setDevices(await api.devices()), []);

  useEffect(() => {
    let active = true;
    api.me().then(async (data) => {
      if (!active) return;
      setAccount(data);
      if (data.authenticated) await loadDevices();
    }).catch(() => active && setAccount({ authenticated: false }));
    return () => { active = false; };
  }, [loadDevices]);

  if (!account) return <LoadingScreen />;
  if (!account.authenticated) return <LoginScreen onLogin={(data) => { setAccount(data); void loadDevices(); }} />;

  return (
    <Dashboard account={account} devices={devices} notice={notice} onNotice={setNotice} onAccount={setAccount} onBind={setBindingKind} onLogout={() => { setAccount({ authenticated: false }); setDevices(emptyDevices); }}>
      {bindingKind && (
        <DeviceDialog
          kind={bindingKind}
          current={devices[bindingKind]}
          onClose={() => setBindingKind(null)}
          onSaved={async () => { await loadDevices(); setBindingKind(null); setNotice({ type: "success", text: `${bindingKind === "hot" ? "热水" : "冷水"}设备已保存` }); }}
          onDeleted={async () => { await loadDevices(); setBindingKind(null); setNotice({ type: "success", text: "设备关联已移除" }); }}
        />
      )}
    </Dashboard>
  );
}

function LoadingScreen() {
  return <main className="loading-screen" aria-live="polite"><div className="brand-mark"><Droplets size={28} /></div><LoaderCircle className="spin" size={22} /><span>正在安全连接…</span></main>;
}

function LoginScreen({ onLogin }: { onLogin: (account: AccountData) => void }) {
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState<"send" | "login" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  async function sendCode() {
    setError("");
    if (!/^1[3-9]\d{9}$/.test(mobile)) return setError("请输入有效的中国大陆手机号");
    setBusy("send");
    try { const result = await api.sendCode(mobile); setSent(true); setCountdown(result.retryAfter); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "验证码发送失败，请稍后再试"); }
    finally { setBusy(null); }
  }

  async function login(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!/^\d{4,8}$/.test(code)) return setError("请输入收到的短信验证码");
    setBusy("login");
    try { onLogin(await api.login(mobile, code)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "登录失败，请检查验证码"); }
    finally { setBusy(null); }
  }

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-row"><div className="brand-mark"><Droplets size={27} strokeWidth={1.8} /></div><span>DUOHESHUI WEB</span></div>
        <div className="login-copy"><p className="eyebrow">欢迎回来</p><h1 id="login-title">小天同学</h1><p>登录后查看余额、关联设备，并从手机安全地启动热水或冷水。</p></div>
        <form className="login-form" onSubmit={login}>
          <label htmlFor="mobile">手机号</label>
          <div className="phone-field"><span>+86</span><input id="mobile" inputMode="tel" autoComplete="tel" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 11))} placeholder="请输入手机号" disabled={busy !== null} /></div>
          {sent && <><label htmlFor="code">验证码</label><input id="code" className="code-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="请输入短信验证码" autoFocus /></>}
          {error && <p className="form-error" role="alert"><CircleAlert size={16} />{error}</p>}
          {!sent ? (
            <button type="button" className="primary-action" onClick={sendCode} disabled={busy !== null}>{busy === "send" ? <><LoaderCircle className="spin" size={18} />正在发送</> : <>获取验证码<ChevronRight size={18} /></>}</button>
          ) : <><button type="submit" className="primary-action" disabled={busy !== null || !code}>{busy === "login" ? <><LoaderCircle className="spin" size={18} />正在登录</> : <>登录<ChevronRight size={18} /></>}</button><button type="button" className="text-action" onClick={sendCode} disabled={countdown > 0 || busy !== null}>{countdown > 0 ? `${countdown} 秒后可重新发送` : "重新发送验证码"}</button></>}
        </form>
        <p className="privacy-note"><ShieldCheck size={16} />登录凭据仅由安全服务器处理</p>
      </section>
      <p className="disclaimer">非官方客户端 · 仅限操作本人有权使用的账号与设备</p>
    </main>
  );
}

function Dashboard({ account, devices, notice, onNotice, onAccount, onBind, onLogout, children }: {
  account: AccountData; devices: DevicesData; notice: Notice; onNotice: (notice: Notice) => void;
  onAccount: (account: AccountData) => void; onBind: (kind: DeviceKind) => void; onLogout: () => void; children: ReactNode;
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
    if (!devices[kind].bound) return onBind(kind);
    if (kind === "hot" && !window.confirm("确认启动热水？请确保出水口下方已放置容器。")) return;
    setStarting(kind); onNotice(null);
    try { await api.startWater(kind, crypto.randomUUID()); onNotice({ type: "success", text: "设备启动指令已发送" }); }
    catch { onNotice({ type: "error", text: "启动失败，请确认设备二维码及账户状态" }); }
    finally { setStarting(null); }
  }

  async function logout() { await api.logout().catch(() => undefined); onLogout(); }

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header"><div className="compact-brand"><span><Droplets size={20} /></span><div><strong>多喝水</strong><small>小天同学控制台</small></div></div><button className="icon-action" onClick={logout} aria-label="退出登录"><LogOut size={20} /></button></header>
      <section className="dashboard-grid">
        <div className="account-card"><div><span className="section-kicker">账户</span><strong className="mobile-number">{account.mobile}</strong></div><div className="balance-block"><span>余额</span><strong><small>¥</small>{account.balance ?? "0.00"}</strong></div><button className="refresh-action" onClick={refresh} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} size={16} />{refreshing ? "刷新中" : "刷新余额"}</button></div>
        {notice && <div className={`notice ${notice.type}`} role="status">{notice.type === "success" ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}{notice.text}</div>}
        <section className="device-section" aria-labelledby="devices-title">
          <div className="section-heading"><div><span className="section-kicker">我的设备</span><h2 id="devices-title">二维码关联</h2></div><small>仅保存在加密数据库</small></div>
          <div className="device-list">{(["hot", "cold"] as const).map((kind) => { const device = devices[kind]; return <button key={kind} className="device-row" onClick={() => onBind(kind)}><span className={`device-icon ${kind}`}>{kind === "hot" ? <Flame size={21} /> : <Snowflake size={21} />}</span><span className="device-copy"><strong>{device.label || (kind === "hot" ? "热水设备" : "冷水设备")}</strong><small>{device.bound ? `已关联 ${device.fingerprint}` : "尚未关联设备"}</small></span><span className="device-action">{device.bound ? "重新关联" : "添加"}<ChevronRight size={16} /></span></button>; })}</div>
        </section>
        <section className="control-section" aria-labelledby="controls-title">
          <div className="section-heading"><div><span className="section-kicker">即时控制</span><h2 id="controls-title">选择水温</h2></div><small>每次点击仅发送一条指令</small></div>
          <div className="control-grid"><button className="water-control hot" onClick={() => startWater("hot")} disabled={starting !== null}><span className="control-icon"><Flame size={27} /></span><span><strong>{starting === "hot" ? "正在发送…" : "热 水"}</strong><small>{devices.hot.bound ? devices.hot.fingerprint : "请先关联设备"}</small></span></button><button className="water-control cold" onClick={() => startWater("cold")} disabled={starting !== null}><span className="control-icon"><Snowflake size={27} /></span><span><strong>{starting === "cold" ? "正在发送…" : "冷 水"}</strong><small>{devices.cold.bound ? devices.cold.fingerprint : "请先关联设备"}</small></span></button></div>
          <p className="safety-caption"><ShieldCheck size={15} />热水启动前会再次确认，出水指令不会自动重试</p>
        </section>
      </section>
      {children}
    </main>
  );
}

function DeviceDialog({ kind, current, onClose, onSaved, onDeleted }: { kind: DeviceKind; current: DevicesData[DeviceKind]; onClose: () => void; onSaved: () => Promise<void>; onDeleted: () => Promise<void> }) {
  const [deviceKey, setDeviceKey] = useState("");
  const [label, setLabel] = useState(current.label || (kind === "hot" ? "热水" : "冷水"));
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const stopScan = useCallback(() => { controlsRef.current?.stop(); controlsRef.current = null; setScanning(false); }, []);
  useEffect(() => stopScan, [stopScan]);

  async function scan() {
    setError(""); setScanning(true);
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader();
      controlsRef.current = await reader.decodeFromVideoDevice(undefined, videoRef.current!, (result) => { if (result) { setDeviceKey(result.getText()); stopScan(); } });
    } catch { setScanning(false); setError("无法打开相机，请允许相机权限或手工粘贴二维码内容"); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!deviceKey.trim()) return setError("请扫描二维码或粘贴设备 key");
    setBusy(true); setError("");
    try { await api.putDevice(kind, deviceKey, label); await onSaved(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "设备保存失败"); setBusy(false); }
  }

  async function remove() {
    if (!window.confirm("确认移除这个设备关联？")) return;
    setBusy(true);
    try { await api.deleteDevice(kind); await onDeleted(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "移除失败"); setBusy(false); }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="device-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-header"><div><span className={`device-icon ${kind}`}>{kind === "hot" ? <Flame size={20} /> : <Snowflake size={20} />}</span><div><span className="section-kicker">设备关联</span><h2 id="dialog-title">{kind === "hot" ? "热水设备" : "冷水设备"}</h2></div></div><button className="icon-action" onClick={onClose} aria-label="关闭"><X size={20} /></button></div>
        <div className={`scanner ${scanning ? "active" : ""}`}><video ref={videoRef} muted playsInline />{!scanning && <div><Camera size={30} /><strong>扫描饮水机二维码</strong><small>画面仅在本机解码，不会上传</small></div>}</div>
        <button type="button" className="scan-action" onClick={scanning ? stopScan : scan}><Camera size={18} />{scanning ? "停止扫描" : "打开相机扫描"}</button>
        <div className="or-divider"><span>或手工输入</span></div>
        <form className="device-form" onSubmit={save}>
          <label htmlFor="device-key">二维码原始内容</label><textarea id="device-key" value={deviceKey} onChange={(e) => setDeviceKey(e.target.value.slice(0, 2048))} placeholder="长按粘贴二维码内容" rows={3} />
          <label htmlFor="device-label">设备名称</label><div className="label-input"><Smartphone size={17} /><input id="device-label" value={label} onChange={(e) => setLabel(e.target.value.slice(0, 64))} placeholder="例如：宿舍热水" /></div>
          {error && <p className="form-error" role="alert"><CircleAlert size={16} />{error}</p>}
          <button className="primary-action" type="submit" disabled={busy || !deviceKey.trim()}>{busy ? <><LoaderCircle className="spin" size={18} />正在保存</> : "保存设备"}</button>
          {current.bound && <button type="button" className="danger-action" onClick={remove} disabled={busy}><Trash2 size={16} />移除当前关联</button>}
        </form>
      </section>
    </div>
  );
}
