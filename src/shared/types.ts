export type PluginKind = 'web2api' | 'cli2api' | 'api2api';

export type PluginStatus =
  | 'not_installed'
  | 'installing'
  | 'installed'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error';

export type UpstreamKind = 'web' | 'cli' | 'api';
export type AdapterKind = 'openai-http' | 'cli-spawn';
export type AuthMode = 'none' | 'cookie' | 'bearer' | 'oauth';
export type ToolsMode = 'native' | 'emulate' | 'off';
export type ToolVariant = 'xml' | 'fence' | 'json';
export type Strategy =
  | 'priority'
  | 'weighted'
  | 'round_robin'
  | 'least_used'
  | 'fastest'
  | 'cheapest'
  | 'quota_headroom';

export interface Plugin {
  id: string;
  name: string;
  kind: PluginKind;
  repo: string;
  description: string;
  port: number | null;
  base_path: string;
  auth_hint: string;
  install_cmd: string;
  run_cmd: string;
  models_hint: string[];
  tools_hint: ToolsMode;
  status: PluginStatus;
  dir: string;
  last_error: string | null;
  installed_at: string | null;
  updated_at: string | null;
}

export interface Upstream {
  id: string;
  name: string;
  preset: string | null;
  kind: UpstreamKind;
  plugin_id: string | null;
  adapter: AdapterKind;
  base_url: string | null;
  api_key: string | null;
  cookie: string | null;
  headers: string;
  auth_mode: AuthMode;
  status: 'active' | 'disabled';
  weight: number;
  cost_per_1k: number;
  max_rpm: number;
  max_rpd: number;
  reset_mode: 'none' | 'cookie_reset';
  session_reset_at: string | null;
  config: string;
  created_at: string;
}

export interface Model {
  id: string;
  upstream_id: string;
  upstream_model: string;
  display_name: string | null;
  context_window: number;
  tools_mode: ToolsMode;
  tool_variant: ToolVariant;
  caps: string;
  enabled: number;
  created_at: string;
}

export interface Chain {
  id: string;
  name: string;
  strategy: Strategy;
  members: string; // JSON string[] of model ids
  description: string | null;
  enabled: number;
  created_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  rpm: number;
  rpd: number;
  created_at: string;
  last_used_at: string | null;
  revoked: number;
}

export interface UsageRow {
  id: number;
  ts: number;
  key_id: string | null;
  model: string;
  upstream_id: string | null;
  status: number;
  ok: number;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  error: string | null;
  streamed: number;
}
