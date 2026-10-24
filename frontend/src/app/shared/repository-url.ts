/** Web-Adresse des Repositorys aus dem Git-Remote (SSH oder HTTPS), sonst null. */
export function repositoryWebUrl(remote: string | null | undefined): string | null {
  const value = remote?.trim();
  if (!value) return null;
  const ssh = /^git@([\w.-]+):(.+?)(?:\.git)?$/.exec(value);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/(?:[^@/]+@)?([\w.-]+(?::\d+)?)\/(.+?)(?:\.git)?\/?$/.exec(value);
  return https ? `https://${https[1]}/${https[2]}` : null;
}
