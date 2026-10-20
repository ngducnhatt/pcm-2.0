"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

interface CurrentUser {
  id: string;
  username: string;
  email: string;
  fullName: string;
  role: string;
  roleLabel: string;
}

interface OrderRow {
  id: string;
  code: string;
  status: string;
  statusLabel: string;
  customer?: { fullName?: string };
  totals?: { total?: string };
  assignedTo?: { fullName?: string } | null;
  priorityLabel?: string;
  version?: number;
  allowedActions?: string[];
  [key: string]: unknown;
}

interface ApiErrorBody {
  error?: { message?: string; code?: string };
}

async function apiRequest(
  path: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: text.slice(0, 300) } };
    }
  }
  return { ok: response.ok, status: response.status, body };
}

function errorMessage(body: unknown, fallback: string): string {
  const value = body as ApiErrorBody | null;
  return value?.error?.message ?? fallback;
}

export default function HomePage() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [dashboard, setDashboard] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [transitionAction, setTransitionAction] = useState("CLAIM");
  const [transitionBody, setTransitionBody] = useState('{\n  "note": ""\n}');

  const [apiMethod, setApiMethod] = useState("GET");
  const [apiPath, setApiPath] = useState("/api/health");
  const [apiBody, setApiBody] = useState("");
  const [apiResult, setApiResult] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    const [ordersResponse, dashboardResponse] = await Promise.all([
      apiRequest("/api/orders?limit=30"),
      apiRequest("/api/dashboard")
    ]);
    if (ordersResponse.ok) {
      const body = ordersResponse.body as { data?: OrderRow[] };
      setOrders(body.data ?? []);
    }
    if (dashboardResponse.ok) {
      const body = dashboardResponse.body as { data?: Record<string, unknown> };
      setDashboard(body.data ?? null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await apiRequest("/api/auth/me");
        if (!cancelled && me.ok) {
          const body = me.body as { data?: CurrentUser };
          setUser(body.data ?? null);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoginBusy(true);
    try {
      const result = await apiRequest("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password })
      });
      if (!result.ok) {
        setError(errorMessage(result.body, "Đăng nhập thất bại."));
        return;
      }
      const body = result.body as { data?: { user?: CurrentUser } };
      setUser(body.data?.user ?? null);
      setPassword("");
      setNotice("Đăng nhập thành công.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không kết nối được API.");
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    await apiRequest("/api/auth/logout", { method: "POST" });
    setUser(null);
    setOrders([]);
    setDashboard(null);
    setSelected(null);
    setSelectedId(null);
  }

  async function openOrder(id: string) {
    setError("");
    setSelectedId(id);
    setBusy(true);
    try {
      const result = await apiRequest(`/api/orders/${encodeURIComponent(id)}`);
      if (!result.ok) {
        setError(errorMessage(result.body, "Không tải được đơn."));
        setSelected(null);
        return;
      }
      const body = result.body as { data?: Record<string, unknown> };
      const detail = body.data ?? null;
      setSelected(detail);
      if (detail) {
        const version = Number(detail.version ?? 0);
        const actions = Array.isArray(detail.allowedActions) ? detail.allowedActions : [];
        setTransitionAction(String(actions[0] ?? "CLAIM"));
        setTransitionBody(JSON.stringify({ expectedVersion: version, note: "" }, null, 2));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitTransition(event: FormEvent) {
    event.preventDefault();
    if (!selectedId || !selected) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(transitionBody || "{}") as Record<string, unknown>;
      } catch {
        setError("Payload chuyển bước không phải JSON hợp lệ.");
        return;
      }
      const payload = {
        ...parsed,
        action: transitionAction,
        expectedVersion: Number(selected.version ?? parsed.expectedVersion ?? 0)
      };
      const result = await apiRequest(
        `/api/orders/${encodeURIComponent(selectedId)}/transitions`,
        { method: "POST", body: JSON.stringify(payload) }
      );
      if (!result.ok) {
        setError(errorMessage(result.body, "Không thực hiện được chuyển bước."));
        return;
      }
      const body = result.body as { data?: Record<string, unknown> };
      setSelected(body.data ?? null);
      setNotice("Đã cập nhật trạng thái đơn.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Có lỗi khi gọi API.");
    } finally {
      setBusy(false);
    }
  }

  async function sendApiRequest(event: FormEvent) {
    event.preventDefault();
    setError("");
    setApiResult(null);
    setBusy(true);
    try {
      const options: RequestInit = { method: apiMethod };
      if (["POST", "PATCH", "PUT"].includes(apiMethod) && apiBody.trim()) {
        try {
          JSON.parse(apiBody);
        } catch {
          setError("Body API Console không phải JSON hợp lệ.");
          return;
        }
        options.body = apiBody;
      }
      const result = await apiRequest(apiPath, options);
      setApiResult({ httpStatus: result.status, body: result.body });
      if (!result.ok) setError(errorMessage(result.body, "API trả về lỗi."));
      if (apiPath.startsWith("/api/orders") || apiPath.startsWith("/api/dashboard")) {
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">
            <div className="logo">PCM</div>
            <div>
              <h1>Hệ thống vận hành PCM</h1>
              <p>PCM OpsFlow · đang tải</p>
            </div>
          </div>
        </header>
        <div className="container">
          <div className="card">Đang kiểm tra phiên đăng nhập…</div>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">
            <div className="logo">PCM</div>
            <div>
              <h1>Hệ thống vận hành PCM</h1>
              <p>PCM OpsFlow · cổng nội bộ</p>
            </div>
          </div>
        </header>
        <div className="container">
          <div className="card login-wrap">
            <h2>Đăng nhập nhân viên</h2>
            <p className="sub">
              Tài khoản được quản trị viên cấp. Hệ thống không có tài khoản mặc định.
            </p>
            {error ? <div className="alert error">{error}</div> : null}
            <form onSubmit={handleLogin}>
              <label htmlFor="identifier">Tên đăng nhập hoặc email</label>
              <input
                id="identifier"
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                required
                maxLength={190}
              />
              <label htmlFor="password">Mật khẩu</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                maxLength={200}
              />
              <div style={{ marginTop: 16 }}>
                <button className="primary" type="submit" disabled={loginBusy}>
                  {loginBusy ? "Đang đăng nhập…" : "Đăng nhập"}
                </button>
              </div>
            </form>
            <hr className="hr" />
            <p className="notice">
              Nếu quên mật khẩu, quản trị viên chạy{" "}
              <span className="mono">npm run user:password -- --username &lt;tên&gt;</span>{" "}
              trên máy chủ. Không có endpoint công khai để đặt lại mật khẩu.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const kpis = dashboard?.queues as Record<string, number> | undefined;
  const allowedActions = selected && Array.isArray(selected.allowedActions)
    ? (selected.allowedActions as string[])
    : [];

  return (
    <main className={`shell ${busy ? "loading" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <div className="logo">PCM</div>
          <div>
            <h1>Hệ thống vận hành PCM</h1>
            <p>PCM OpsFlow · bảng điều khiển tối thiểu</p>
          </div>
        </div>
        <div className="userbox">
          <span>{user.fullName}</span>
          <span className="pill">{user.roleLabel}</span>
          <button className="ghost" type="button" onClick={handleLogout}>
            Đăng xuất
          </button>
        </div>
      </header>

      <div className="container">
        {error ? <div className="alert error">{error}</div> : null}
        {notice ? <div className="alert ok">{notice}</div> : null}

        <div className="card">
          <div className="row spread">
            <div>
              <h2>Tổng quan nhanh</h2>
              <p className="sub" style={{ marginBottom: 0 }}>
                Dữ liệu được giới hạn theo vai trò. Làm mới sau mỗi thao tác.
              </p>
            </div>
            <button className="secondary" type="button" onClick={() => void refresh()}>
              Làm mới
            </button>
          </div>
          <div className="kpis" style={{ marginTop: 16 }}>
            <div className="kpi">
              <strong>{kpis?.sales ?? "—"}</strong>
              <span>Kinh doanh</span>
            </div>
            <div className="kpi">
              <strong>{kpis?.warehouse ?? "—"}</strong>
              <span>Kho</span>
            </div>
            <div className="kpi">
              <strong>{kpis?.technical ?? "—"}</strong>
              <span>Kỹ thuật</span>
            </div>
            <div className="kpi">
              <strong>{kpis?.warranty ?? "—"}</strong>
              <span>Bảo hành</span>
            </div>
            <div className="kpi">
              <strong>{kpis?.delivery ?? "—"}</strong>
              <span>Giao hàng</span>
            </div>
            <div className="kpi">
              <strong>{kpis?.payment ?? "—"}</strong>
              <span>Thanh toán</span>
            </div>
          </div>
        </div>

        <div className="grid" style={{ marginTop: 18 }}>
          <div>
            <div className="card">
              <h2>Đơn hàng có thể xem</h2>
              <p className="sub">
                Tối đa 30 đơn gần nhất. Mở một đơn để xem JSON và thực hiện chuyển bước.
              </p>
              <div className="orders">
                {orders.length === 0 ? (
                  <p className="muted small">Chưa có đơn hàng trong phạm vi quyền của bạn.</p>
                ) : (
                  orders.map((order) => (
                    <button
                      key={order.id}
                      type="button"
                      className="order-row"
                      onClick={() => void openOrder(order.id)}
                      style={selectedId === order.id ? { borderColor: "#0f766e" } : undefined}
                    >
                      <div className="row spread">
                        <span className="code">{order.code}</span>
                        <span className="badge">{order.statusLabel}</span>
                      </div>
                      <div className="meta">
                        {order.customer?.fullName ?? ""}
                        {order.totals?.total ? ` · ${order.totals.total} đ` : ""}
                        {order.assignedTo?.fullName ? ` · ${order.assignedTo.fullName}` : ""}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {selected ? (
              <div className="card">
                <div className="row spread">
                  <h2>Đơn {String(selected.code ?? "")}</h2>
                  <span className="badge">{String(selected.statusLabel ?? "")}</span>
                </div>
                <p className="sub">
                  Phiên bản {String(selected.version)} · trạng thái {String(selected.status)}
                </p>
                <form onSubmit={submitTransition}>
                  <label htmlFor="transition">Hành động</label>
                  <select
                    id="transition"
                    value={transitionAction}
                    onChange={(event) => setTransitionAction(event.target.value)}
                  >
                    {(allowedActions.length > 0 ? allowedActions : [transitionAction]).map(
                      (action) => (
                        <option key={action} value={action}>
                          {action}
                        </option>
                      )
                    )}
                  </select>
                  <label htmlFor="transition-body">Payload bổ sung (JSON)</label>
                  <textarea
                    id="transition-body"
                    value={transitionBody}
                    onChange={(event) => setTransitionBody(event.target.value)}
                    spellCheck={false}
                  />
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="primary" type="submit" disabled={busy}>
                      Thực hiện chuyển bước
                    </button>
                  </div>
                </form>
                <hr className="hr" />
                <pre>{JSON.stringify(selected, null, 2)}</pre>
              </div>
            ) : null}
          </div>

          <div>
            <div className="card">
              <h2>API Console</h2>
              <p className="sub">
                Dùng cookie phiên hiện tại để thử API. Không dán mật khẩu/token vào đây.
              </p>
              <form onSubmit={sendApiRequest}>
                <div className="grid-2">
                  <div>
                    <label htmlFor="api-method">Phương thức</label>
                    <select
                      id="api-method"
                      value={apiMethod}
                      onChange={(event) => setApiMethod(event.target.value)}
                    >
                      {["GET", "POST", "PATCH", "DELETE"].map((method) => (
                        <option key={method}>{method}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="api-path">Đường dẫn</label>
                    <input
                      id="api-path"
                      value={apiPath}
                      onChange={(event) => setApiPath(event.target.value)}
                      spellCheck={false}
                      required
                    />
                  </div>
                </div>
                <label htmlFor="api-body">Body JSON</label>
                <textarea
                  id="api-body"
                  value={apiBody}
                  onChange={(event) => setApiBody(event.target.value)}
                  placeholder='Ví dụ: {"expectedVersion": 0}'
                  spellCheck={false}
                />
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="primary" type="submit" disabled={busy}>
                    Gửi request
                  </button>
                </div>
              </form>
              {apiResult ? <pre style={{ marginTop: 14 }}>{JSON.stringify(apiResult, null, 2)}</pre> : null}
            </div>

            <div className="card">
              <h2>Quy trình</h2>
              <p className="sub">
                Kinh doanh → Kho → Kỹ thuật → Bảo hành → Giao hàng → Thanh toán → Hoàn tất.
                Mỗi bước phải nhận xử lý trước khi hoàn tất; dữ liệu được khóa và kiểm tra phiên bản.
              </p>
              <p className="notice">
                Tài liệu API đầy đủ nằm trong <span className="mono">README.md</span> và{" "}
                <span className="mono">docs/API.md</span>. Giao diện này chỉ dùng để kiểm thử.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
