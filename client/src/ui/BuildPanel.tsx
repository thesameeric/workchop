import { useEffect, useState } from 'react';
import { CLOTHING_COLORS } from '../../../shared/avatar';
import { CATALOG_LIST, CATEGORIES, getEntry, type Category } from '../../../shared/catalog';
import { FLOOR_STYLES, MAX_SIZE, MIN_SIZE, ZONE_COLORS } from '../../../shared/office';
import type { FloorStyle, OfficeSettings, Zone } from '../../../shared/types';
import { local } from '../lib/positions';
import { getSession } from '../lib/session';
import { buildRule, canBuild, setState, useStore } from '../state/store';
import { buildActions } from '../world/Ground';
import { Swatches } from './AvatarEditor';
import { CopyIcon, LockIcon, PinIcon, RotateIcon, TrashIcon } from './icons';

type Tab = 'items' | 'areas' | 'office';

const FURNITURE_COLORS = ['#c8a27a', '#8d6e63', '#a47148', '#f2f2f2', '#2b2d42', ...CLOTHING_COLORS.slice(2, 11)];
const FLOOR_COLORS = ['#c9a27e', '#a47148', '#e6d3b3', '#8d9aa8', '#cfd6df', '#5b6475', '#7c9a7e', '#c98f8f', '#8f8fc9', '#f2efe9'];
const WALL_COLORS = ['#e9e4f2', '#f2efe9', '#dfe6e9', '#ffe8d6', '#d8f3dc', '#cdb4db', '#a2d2ff', '#b0b7c3', '#ffd6a5', '#3d405b'];

function ItemsTab() {
  const build = useStore((s) => s.build);
  const selected = useStore((s) => s.office?.items.find((i) => i.id === s.build.selectedId) ?? null);
  const [category, setCategory] = useState<Category>('Work');
  const entry = selected ? getEntry(selected.type) : null;

  const pick = (type: string) =>
    setState((s) => ({
      build: {
        ...s.build,
        tool: s.build.placeType === type && s.build.tool === 'place' ? 'select' : 'place',
        placeType: s.build.placeType === type && s.build.tool === 'place' ? null : type,
        selectedId: null,
        selectedZoneId: null,
      },
    }));

  return (
    <>
      <div className="chips categories">
        {CATEGORIES.map((c) => (
          <button key={c} className={`chip${c === category ? ' active' : ''}`} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="catalog">
        {CATALOG_LIST.filter((e) => e.category === category).map((e) => (
          <button
            key={e.type}
            className={`catalog-item${build.tool === 'place' && build.placeType === e.type ? ' active' : ''}`}
            onClick={() => pick(e.type)}
            title={e.label}
          >
            <span className="catalog-icon">{e.icon}</span>
            <span>{e.label}</span>
          </button>
        ))}
      </div>
      <div className="build-hint">
        {build.tool === 'place' && build.placeType ? (
          <>
            Click the floor to place <b>{getEntry(build.placeType)?.label}</b>. <kbd>R</kbd> rotate · <kbd>Esc</kbd> done
          </>
        ) : (
          <>
            Click an item to select it, drag to move. <kbd>R</kbd> rotate · <kbd>Del</kbd> delete · <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate.
            Right-drag to turn the camera.
          </>
        )}
      </div>
      {selected && entry && (
        <div className="inspector">
          <div className="inspector-title">
            <span>{entry.icon}</span> {entry.label}
          </div>
          <div className="inspector-actions">
            <button className="btn small" onClick={buildActions.rotateSelected}>
              <RotateIcon size={14} /> Rotate
            </button>
            <button className="btn small" onClick={buildActions.duplicateSelected}>
              <CopyIcon size={14} /> Duplicate
            </button>
            <button className="btn small danger" onClick={buildActions.deleteSelected}>
              <TrashIcon size={14} /> Delete
            </button>
          </div>
          {entry.colorable && (
            <Swatches
              value={selected.color ?? entry.defaultColor ?? '#cccccc'}
              colors={FURNITURE_COLORS}
              onChange={(color) => getSession()?.edit({ t: 'update', item: { ...selected, color } })}
            />
          )}
        </div>
      )}
    </>
  );
}

function ZoneRow({ zone, selected }: { zone: Zone; selected: boolean }) {
  const [name, setName] = useState(zone.name);
  useEffect(() => setName(zone.name), [zone.name]);
  const commit = () => {
    if (name.trim() && name !== zone.name) getSession()?.edit({ t: 'zone:update', zone: { ...zone, name } });
    else setName(zone.name);
  };
  return (
    <div
      className={`zone-row${selected ? ' active' : ''}`}
      onClick={() => setState((s) => ({ build: { ...s.build, tool: 'select', selectedZoneId: zone.id, selectedId: null } }))}
    >
      <div className="zone-row-top">
        <span className="zone-color" style={{ background: zone.color }} />
        <input
          value={name}
          maxLength={32}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="Area name"
        />
        <span className="muted small">
          {zone.w}×{zone.d}
        </span>
        <button className="icon-btn" title="Delete area" onClick={(e) => {
          e.stopPropagation();
          getSession()?.edit({ t: 'zone:remove', id: zone.id });
        }}>
          <TrashIcon size={14} />
        </button>
      </div>
      {selected && (
        <Swatches value={zone.color} colors={ZONE_COLORS} custom={false} onChange={(color) => getSession()?.edit({ t: 'zone:update', zone: { ...zone, color } })} />
      )}
    </div>
  );
}

function AreasTab() {
  const zones = useStore((s) => s.office?.zones ?? []);
  const tool = useStore((s) => s.build.tool);
  const selectedZoneId = useStore((s) => s.build.selectedZoneId);
  return (
    <>
      <p className="muted small">
        People inside a private area only hear and see each other, however far apart they are — perfect for meeting rooms.
      </p>
      <button
        className={`btn wide${tool === 'zone' ? ' primary' : ''}`}
        onClick={() => setState((s) => ({ build: { ...s.build, tool: s.build.tool === 'zone' ? 'select' : 'zone', placeType: null, selectedId: null } }))}
      >
        <LockIcon size={16} /> {tool === 'zone' ? 'Drag on the floor to draw…' : 'Draw a private area'}
      </button>
      <div className="zone-list">
        {zones.length === 0 && <p className="muted center">No private areas yet.</p>}
        {zones.map((z) => (
          <ZoneRow key={z.id} zone={z} selected={z.id === selectedZoneId} />
        ))}
      </div>
    </>
  );
}

function OfficeTab() {
  const settings = useStore((s) => s.office!.settings);
  const isOwner = useStore((s) => s.isOwner);
  const open = useStore((s) => s.guests === 'open');
  const [name, setName] = useState(settings.name);
  const [size, setSize] = useState({ width: settings.width, depth: settings.depth });
  useEffect(() => setName(settings.name), [settings.name]);
  useEffect(() => setSize({ width: settings.width, depth: settings.depth }), [settings.width, settings.depth]);

  const save = (patch: Partial<OfficeSettings>) => getSession()?.edit({ t: 'settings', settings: patch });
  const sizeChanged = size.width !== settings.width || size.depth !== settings.depth;
  const shrinking = size.width < settings.width || size.depth < settings.depth;

  return (
    <div className="office-settings">
      <label className="field">
        <span>Office name</span>
        <input value={name} maxLength={48} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== settings.name && save({ name })} />
      </label>
      <div className="field">
        <span>Floor size</span>
        <div className="size-row">
          <input type="number" min={MIN_SIZE} max={MAX_SIZE} value={size.width} onChange={(e) => setSize({ ...size, width: Number(e.target.value) })} aria-label="Width" />
          <span>×</span>
          <input type="number" min={MIN_SIZE} max={MAX_SIZE} value={size.depth} onChange={(e) => setSize({ ...size, depth: Number(e.target.value) })} aria-label="Depth" />
          <button
            className="btn small"
            disabled={!sizeChanged}
            onClick={() => {
              if (shrinking && !confirm('Shrinking removes furniture that no longer fits. Continue?')) return;
              save(size);
            }}
          >
            Apply
          </button>
        </div>
      </div>
      <div className="field">
        <span>Floor</span>
        <div className="chips">
          {FLOOR_STYLES.map((f) => (
            <button key={f} className={`chip${settings.floor === f ? ' active' : ''}`} onClick={() => save({ floor: f as FloorStyle })}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <Swatches value={settings.floorColor} colors={FLOOR_COLORS} onChange={(floorColor) => save({ floorColor })} />
      </div>
      <div className="field">
        <span>Walls</span>
        <Swatches value={settings.wallColor} colors={WALL_COLORS} onChange={(wallColor) => save({ wallColor })} />
      </div>
      <div className="field">
        <span>Spawn point</span>
        <button className="btn small" onClick={() => save({ spawn: { x: local.x, z: local.z } })}>
          <PinIcon size={14} /> Set to where I’m standing
        </button>
      </div>
      {isOwner && (
        <label className="field">
          <span>Who can edit</span>
          <select value={settings.buildPolicy} onChange={(e) => save({ buildPolicy: e.target.value as OfficeSettings['buildPolicy'] })}>
            <option value="everyone">{open ? 'Everyone in the office' : 'All members'}</option>
            <option value="owner">The owner and admins</option>
          </select>
        </label>
      )}
    </div>
  );
}

export function BuildPanel() {
  const [tab, setTab] = useState<Tab>('items');
  const allowed = useStore(canBuild);
  const rule = useStore(buildRule);
  if (!allowed) {
    return (
      <div className="panel-body">
        <p className="muted center pad">
          <LockIcon size={16} /> {rule}
        </p>
      </div>
    );
  }
  return (
    <div className="panel-body build">
      <div className="tabs">
        {(['items', 'areas', 'office'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`tab${tab === t ? ' active' : ''}`}
            onClick={() => {
              setTab(t);
              setState((s) => ({ build: { ...s.build, tool: 'select', placeType: null } }));
            }}
          >
            {t === 'items' ? 'Furniture' : t === 'areas' ? 'Private areas' : 'Office'}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === 'items' && <ItemsTab />}
        {tab === 'areas' && <AreasTab />}
        {tab === 'office' && <OfficeTab />}
      </div>
    </div>
  );
}
