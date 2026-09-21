// Helper to generate the correct authenticated URL path for private storage
// buckets. Do not construct these paths inline; the public-URL format breaks
// on non-upload origins, and switching from /public/ to /authenticated/ is
// required to access files in buckets made private via migration.

export function authenticatedStorageUrl(bucket: 'player-photos' | 'team-photos', path: string): string {
  const normalized = path.replace(/^\/+/, '')
  if (!normalized) return ''
  return `/db/storage/v1/object/authenticated/${bucket}/${normalized}`
}
