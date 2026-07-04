import { User } from 'lucide-react'

// Shared circular player avatar with a lucide User fallback when no photo
// is set. photoUrl is a domain-relative path (see useUploadPlayerPhoto);
// render it directly, never prepend an origin. draggable={false} matters:
// native image dragging would hijack pointer events on the Strategy board.
export default function PlayerAvatar({ photoUrl, name, size = 'md', className = '' }: {
  photoUrl: string | null
  name: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const sizes = { sm: 'w-10 h-10', md: 'w-12 h-12', lg: 'w-20 h-20' }
  const iconSizes = { sm: 'w-5 h-5', md: 'w-6 h-6', lg: 'w-9 h-9' }
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name}
        draggable={false}
        className={`${sizes[size]} rounded-full object-cover shrink-0 border-2 border-border select-none ${className}`}
      />
    )
  }
  return (
    <div className={`${sizes[size]} rounded-full bg-primary/10 flex items-center justify-center shrink-0 select-none ${className}`}>
      <User className={`${iconSizes[size]} text-primary`} />
    </div>
  )
}
