// Prüfung der aufgelösten Docker-Compose-Konfiguration auf Pfade und Rechte ausserhalb des Projekts.
import { isAbsolute, resolve, sep } from 'node:path';
import { realPath } from './command-checks.js';

export const COMPOSE_STARTING = /^docker compose (?:up|start|restart|build)\b/;

/** Check the resolved Compose configuration for paths that escape the project directory. */
export function composeViolation(configJson: string, root: string): string | null {
  let config: {
    services?: Record<string, Record<string, unknown>>;
    configs?: unknown;
    secrets?: unknown;
    volumes?: Record<string, unknown>;
  };
  try {
    config = JSON.parse(configJson.slice(configJson.indexOf('{'))) as typeof config;
  } catch {
    return 'Die Compose-Konfiguration konnte nicht geprüft werden (docker compose config liefert kein gültiges JSON).';
  }
  // Symbolische Links auflösen: ein Link im Projekt, der nach draussen zeigt, zählt als draussen.
  const inside = (path: unknown): boolean => {
    if (typeof path !== 'string' || !isAbsolute(path)) return false;
    const real = realPath(path);
    return real === root || real.startsWith(root + sep);
  };
  const isHostPath = (value: string): boolean => isAbsolute(value) || value.startsWith('.') || value.startsWith('~');
  const fileSources = (entries: unknown): unknown[] =>
    Object.values((entries ?? {}) as Record<string, { file?: unknown } | null>).map((entry) => entry?.file);
  for (const [name, service] of Object.entries(config.services ?? {})) {
    if (service.privileged === true) return `Dienst "${name}" ist privilegiert.`;
    const namespaces = [
      service.network_mode,
      service.pid,
      service.ipc,
      service.uts,
      service.userns_mode,
      service.cgroup,
    ];
    if (namespaces.some((value) => value === 'host' || (typeof value === 'string' && value.startsWith('container:')))) {
      return `Dienst "${name}" nutzt den Host-Namensraum oder den eines fremden Containers.`;
    }
    if (Array.isArray(service.cap_add) && service.cap_add.length)
      return `Dienst "${name}" fordert zusätzliche Capabilities an.`;
    if (Array.isArray(service.devices) && service.devices.length) return `Dienst "${name}" bindet Geräte ein.`;
    if (
      Array.isArray(service.security_opt) &&
      service.security_opt.some((option) => !String(option).startsWith('no-new-privileges'))
    )
      return `Dienst "${name}" lockert die Sicherheitsprofile (security_opt).`;
    if (
      Array.isArray(service.volumes_from) &&
      service.volumes_from.some((entry) => String(entry).startsWith('container:'))
    )
      return `Dienst "${name}" übernimmt Volumes eines fremden Containers.`;
    if (service.cgroup_parent !== undefined) return `Dienst "${name}" setzt cgroup_parent.`;
    const build =
      typeof service.build === 'string'
        ? { context: service.build }
        : (service.build as { context?: unknown; dockerfile?: unknown; additional_contexts?: unknown } | undefined);
    if (build) {
      if (build.context !== undefined && !inside(build.context))
        return `Build-Kontext von "${name}" liegt außerhalb des Projektordners.`;
      if (
        typeof build.dockerfile === 'string' &&
        typeof build.context === 'string' &&
        !inside(resolve(build.context, build.dockerfile))
      )
        return `Dockerfile von "${name}" liegt außerhalb des Projektordners.`;
      for (const extra of Object.values((build.additional_contexts ?? {}) as Record<string, unknown>)) {
        if (typeof extra === 'string' && isHostPath(extra) && !inside(extra))
          return `Zusätzlicher Build-Kontext von "${name}" liegt außerhalb des Projektordners.`;
      }
    }
    for (const volume of Array.isArray(service.volumes)
      ? (service.volumes as { type?: string; source?: unknown }[])
      : []) {
      if (volume.type === 'bind' && !inside(volume.source)) {
        return `Dienst "${name}" bindet ${String(volume.source)} außerhalb des Projektordners ein.`;
      }
    }
    const envFiles = Array.isArray(service.env_file) ? service.env_file : service.env_file ? [service.env_file] : [];
    for (const entry of envFiles) {
      const path = typeof entry === 'string' ? entry : (entry as { path?: unknown } | null)?.path;
      if (!inside(path)) return `Dienst "${name}" liest die env-Datei ${String(path)} außerhalb des Projektordners.`;
    }
  }
  for (const [kind, sources] of [
    ['Config', fileSources(config.configs)],
    ['Secret', fileSources(config.secrets)],
  ] as const) {
    for (const source of sources) {
      if (source !== undefined && !inside(source))
        return `${kind}-Datei ${String(source)} liegt außerhalb des Projektordners.`;
    }
  }
  for (const [name, volume] of Object.entries(config.volumes ?? {})) {
    const device = (volume as { driver_opts?: { device?: unknown } } | null)?.driver_opts?.device;
    if (typeof device === 'string' && isHostPath(device) && !inside(device))
      return `Volume "${name}" bindet ${device} außerhalb des Projektordners ein.`;
  }
  return null;
}
