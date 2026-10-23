import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Badge } from './ui.tsx';
import OverviewPage from './pages/Overview.tsx';
import SetupPage from './pages/Setup.tsx';
import ConnectorsPage from './pages/Connectors.tsx';
import UpstreamsPage from './pages/Upstreams.tsx';
import ModelsPage from './pages/Models.tsx';
import RoutingPage from './pages/Routing.tsx';
import KeysPage from './pages/Keys.tsx';
import LogsPage from './pages/Logs.tsx';
import PlaygroundPage from './pages/Playground.tsx';
import SettingsPage from './pages/Settings.tsx';

export type PageId =
  | 'overview'
  | 'setup'
  | 'connectors'
  | 'upstreams'
  | 'models'
  | 'routing'
  | 'keys'
  | 'logs'
  | 'playground'
  | 'settings';

const NAV: { group: string; items: { id: PageId; label: string }[] }[] = [
  {
    group: 'route',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'playground', label: 'Playground' },
      { id: 'logs', label: 'Requests' },
    ],
  },
  {
    group: 'build',
    items: [
      { id: 'setup', label: 'Setup' },
      { id: 'connectors', label: 'Connectors' },
      { id: 'upstreams', label: 'Upstreams' },
      { id: 'models', label: 'Models' },
      { id: 'routing', label: 'Routing' },
    ],
  },
  {
    group: 'access',
    items: [
      { id: 'keys', label: 'API keys' },
      { id: 'settings', label: 'Settings' },
    ],
  },
];

const TITLES: Record<PageId, [string, string]> = {
  overview: ['Overview', 'traffic, health and tool emulation at a glance'],
  setup: ['Setup', 'pick connectors, install them, calibrate tools'],
  connectors: ['Connectors', 'web2api, cli2api and api2api repos on this host'],
  upstreams: ['Upstreams', 'credentials and endpoints comb routes to'],
  models: ['Models', 'every routable model and how its tools work'],
  routing: ['Routing', 'chains, strategies and failover'],
  keys: ['API keys', 'client keys for the /v1 surface'],
  logs: ['Requests', 'recent routed calls'],
  playground: ['Playground', 'send a request through the router'],
  settings: ['Settings', 'router defaults'],
};

const pageFromHash = (): PageId => {
  const id = location.hash.slice(1);
  return Object.prototype.hasOwnProperty.call(TITLES, id) ? (id as PageId) : 'overview';
};

export default function App() {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [counts, setCounts] = useState<{ upstreams: number; models: number; emulated: number } | null>(null);

  const go = (id: PageId) => {
    location.hash = id;
    setPage(id);
  };

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .get('/overview')
        .then((d) => alive && setCounts({ ...d.counts }))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [page]);

  const [title, sub] = TITLES[page];

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div>
            <div className="brand-name">comb</div>
            <div className="brand-sub">model router</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((group) => (
            <div key={group.group}>
              <div className="nav-group">{group.group}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={page === item.id ? 'active' : ''}
                  onClick={() => go(item.id)}
                >
                  {item.label}
                  {item.id === 'models' && counts ? <span className="count">{counts.models}</span> : null}
                  {item.id === 'routing' && counts?.emulated ? <span className="count">~{counts.emulated}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div>
            <b>openai base</b>
            <br />
            {location.origin}/v1
          </div>
          <div style={{ marginTop: 8 }}>
            <Badge tone={counts?.emulated ? 'blue' : 'idle'}>
              {counts?.emulated ?? 0} emulated
            </Badge>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{title}</h1>
            <div className="sub">{sub}</div>
          </div>
          <div className="topbar-actions">
            <Badge tone="ok">online</Badge>
          </div>
        </header>
        <div className="content">
          {page === 'overview' && <OverviewPage go={go} />}
          {page === 'setup' && <SetupPage done={() => go('overview')} />}
          {page === 'connectors' && <ConnectorsPage />}
          {page === 'upstreams' && <UpstreamsPage />}
          {page === 'models' && <ModelsPage />}
          {page === 'routing' && <RoutingPage />}
          {page === 'keys' && <KeysPage />}
          {page === 'logs' && <LogsPage />}
          {page === 'playground' && <PlaygroundPage />}
          {page === 'settings' && <SettingsPage />}
        </div>
      </div>
    </div>
  );
}
