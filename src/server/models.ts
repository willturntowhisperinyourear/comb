import { get, nowIso, run, setting } from './db.ts';
import { modelById } from './router.ts';
import { calibrationFor, defaultToolsMode } from './plugins.ts';
import { slugify } from './text.ts';
import type { ToolsMode } from '../shared/types.ts';

export interface AddModelsResult {
  created: string[];
  existing: string[];
  invalid: string[];
  error?: string;
}

/**
 * Adds model ids by hand. Connectors lag behind the provider: a web2api repo
 * may still list last quarter's ids, while the web app already serves a new
 * one. Nothing upstream has to know the model name, so the operator can just
 * type it in and comb will route to it.
 */
export function addModels(upstreamId: string, names: unknown, toolsMode?: string): AddModelsResult {
  const up = get<any>('select * from upstreams where id = ?', upstreamId);
  if (!up) return { created: [], existing: [], invalid: [], error: 'upstream not found' };
  const slug = slugify(up.name);
  const mode: ToolsMode = ['native', 'emulate', 'off'].includes(String(toolsMode))
    ? (String(toolsMode) as ToolsMode)
    : defaultToolsMode(up);
  const created: string[] = [];
  const existing: string[] = [];
  const invalid: string[] = [];

  const list = Array.isArray(names) ? names : [names];
  for (const raw of list) {
    const name = String(raw ?? '').trim().replace(new RegExp(`^${slug}/`), '');
    if (!name || /\s/.test(name)) {
      if (String(raw ?? '').trim()) invalid.push(String(raw));
      continue;
    }
    const id = `${slug}/${name}`;
    if (modelById(id)) {
      if (!existing.includes(id)) existing.push(id);
      continue;
    }
    run(
      `insert into models(id, upstream_id, upstream_model, display_name, context_window, tools_mode, tool_variant,
         calibration_status, calibrated_at, caps, created_at)
       values(?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      up.id,
      name,
      name,
      128000,
      mode,
      setting('default_tool_variant', 'xml'),
      calibrationFor(mode),
      null,
      JSON.stringify({ added_manually: true }),
      nowIso(),
    );
    created.push(id);
  }
  return { created, existing, invalid };
}
