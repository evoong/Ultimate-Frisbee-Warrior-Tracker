update storage.objects o
set name = p.organization_id::text || '/' || regexp_replace(o.name, '^.*/', '')
from public.players p
where o.bucket_id = 'player-photos'
  and p.photo_url like '/db/storage/v1/object/public/player-photos/%'
  and o.name = regexp_replace(p.photo_url, '^.*/player-photos/', '');

update public.players
set photo_url = '/db/storage/v1/object/authenticated/player-photos/'
  || organization_id::text || '/' || regexp_replace(photo_url, '^.*/player-photos/', '')
where photo_url like '/db/storage/v1/object/public/player-photos/%';

update public.organizations
set photo_url = replace(
  photo_url,
  '/db/storage/v1/object/public/team-photos/',
  '/db/storage/v1/object/authenticated/team-photos/'
)
where photo_url like '/db/storage/v1/object/public/team-photos/%';
