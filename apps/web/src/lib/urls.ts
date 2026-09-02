const baseDomain = (process.env.NEXT_PUBLIC_BASE_DOMAIN || 'localhost').trim().toLowerCase();
const protocol = baseDomain === 'localhost' ? 'http' : 'https';

export function projectHostname(projectSlug: string): string {
  return `${projectSlug}.${baseDomain}`;
}

export function projectUrl(projectSlug: string): string {
  return `${protocol}://${projectHostname(projectSlug)}`;
}

export function deploymentPreviewUrl(projectSlug: string, commitHash?: string | null): string {
  const suffix = commitHash ? `-${commitHash.slice(0, 7)}` : '';
  return `${protocol}://${projectSlug}${suffix}.${baseDomain}`;
}
