import { focusToObjectPosition, type ImageValue } from 'gitvfs-cms'
import { useMediaUrl, type PreviewProps } from 'gitvfs-cms/react'

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' && value ? value : fallback)

// Custom previews replace the rendered tab per collection: <CmsApp previews={{ authors: AuthorPreview }} />.
// They render in the editor's page, so only show trusted values (React escapes text for you).

export function AuthorPreview({ values }: PreviewProps) {
  const name = typeof values.name === 'string' && values.name ? values.name : 'Unnamed author'
  const color = typeof values.color === 'string' ? values.color : '#2f6feb'
  const socials = Array.isArray(values.socials) ? (values.socials as Array<{ network?: string; url?: string }>) : []
  // Reads the image through the CMS, so it shows before it is committed and in private repositories.
  const avatar = useMediaUrl(typeof values.avatar === 'string' && values.avatar ? values.avatar : undefined)
  return (
    <div className="demo-preview">
      <article className="demo-author" style={{ borderTopColor: color }}>
        {avatar ? (
          <img className="demo-avatar" src={avatar} alt="" />
        ) : (
          <div className="demo-avatar" style={{ background: color }} aria-hidden>
            {name.slice(0, 1)}
          </div>
        )}
        <h2>{name}</h2>
        <p className="demo-role">{text(values.role)}</p>
        {typeof values.bio === 'string' && values.bio ? <p>{values.bio}</p> : null}
        <ul>
          {socials.filter((social) => social?.url).map((social, index) => (
            <li key={index}>
              {social.network}: {social.url}
            </li>
          ))}
        </ul>
      </article>
    </div>
  )
}

function EventPhoto({ photo }: { photo: ImageValue }) {
  const url = useMediaUrl(photo.src)
  // The focal point keeps the important part in view in the square crop.
  return url ? <img src={url} alt={photo.alt ?? ''} style={{ objectPosition: focusToObjectPosition(photo.focus) }} /> : null
}

export function EventPreview({ values }: PreviewProps) {
  const photos = Array.isArray(values.photos) ? (values.photos as ImageValue[]).filter((photo) => photo?.src) : []
  const tickets = Array.isArray(values.tickets) ? (values.tickets as Array<{ name?: string; price?: number }>) : []
  const location = values.location as { venue?: string; city?: string } | undefined
  const starts = values.starts instanceof Date || typeof values.starts === 'string' ? new Date(values.starts) : null
  return (
    <div className="demo-preview">
      <article className="demo-event">
        <p className="demo-role">{starts && !Number.isNaN(starts.getTime()) ? starts.toDateString() : 'No date yet'}</p>
        <h2>{text(values.title, 'Untitled event')}</h2>
        {photos.length > 0 ? (
          <div className="demo-photos">
            {photos.map((photo, index) => (
              <EventPhoto key={index} photo={photo} />
            ))}
          </div>
        ) : null}
        <p>{values.online ? 'Online' : [location?.venue, location?.city].filter(Boolean).join(', ') || 'Location to be announced'}</p>
        {tickets.length > 0 ? (
          <table>
            <tbody>
              {tickets.map((ticket, index) => (
                <tr key={index}>
                  <td>{ticket?.name}</td>
                  <td>{typeof ticket?.price === 'number' ? (ticket.price === 0 ? 'Free' : `€${ticket.price}`) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </article>
    </div>
  )
}
